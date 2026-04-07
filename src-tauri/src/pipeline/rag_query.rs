use std::collections::{HashSet, VecDeque};
use std::sync::OnceLock;
use std::time::Instant;

use regex::Regex;
use sqlx::SqlitePool;

use crate::models::KnowledgeSearchResult;
use crate::storage::{self, KnowledgeChunkRecord};

use super::types::{
    LayerOutcome, PipelineWarning, PipelineWarningCode, RetrievalMode, RetrievalPlan,
};

pub const LAYER_NAME: &str = "rag_query";
const EMBEDDING_DIM: usize = 1024;

pub async fn run(
    pool: &SqlitePool,
    prompt: &str,
    plan: &RetrievalPlan,
) -> LayerOutcome<Vec<KnowledgeSearchResult>> {
    let started = Instant::now();
    let mut warnings = Vec::new();

    let query_embedding = simple_embed(prompt);
    if query_embedding.iter().all(|v| v.abs() < f32::EPSILON) {
        warnings.push(PipelineWarning {
            code: PipelineWarningCode::RagFallbackEmptyContext,
            layer: LAYER_NAME.to_string(),
            message: "Query had no searchable tokens. Continuing without retrieval context."
                .to_string(),
        });
        return LayerOutcome::fallback(Vec::new(), warnings, started.elapsed().as_millis() as u64);
    }

    if plan.mode == RetrievalMode::Graph {
        warnings.push(PipelineWarning {
            code: PipelineWarningCode::RagFallbackEmptyContext,
            layer: LAYER_NAME.to_string(),
            message:
                "Graph retrieval is not enabled in rust_v1 chat pipeline yet. Using vector retrieval."
                    .to_string(),
        });
    }

    let chunks = match fetch_chunks(pool, plan).await {
        Ok(rows) => rows,
        Err(err) => {
            warnings.push(PipelineWarning {
                code: PipelineWarningCode::RagFallbackEmptyContext,
                layer: LAYER_NAME.to_string(),
                message: format!(
                    "Retrieval failed and context was skipped. The answer will continue without RAG context. ({})",
                    err
                ),
            });
            return LayerOutcome::fallback(
                Vec::new(),
                warnings,
                started.elapsed().as_millis() as u64,
            );
        }
    };

    if chunks.is_empty() {
        return LayerOutcome::success(Vec::new(), started.elapsed().as_millis() as u64);
    }

    let ranked = rank_chunks(prompt, &query_embedding, &chunks, plan.limit, &mut warnings);

    let elapsed = started.elapsed().as_millis() as u64;
    let mut outcome = LayerOutcome::success(ranked, elapsed);
    outcome.warnings = warnings;
    outcome
}

async fn fetch_chunks(
    pool: &SqlitePool,
    plan: &RetrievalPlan,
) -> Result<Vec<KnowledgeChunkRecord>, String> {
    let Some(document_ids) = plan.document_ids.as_ref() else {
        return storage::list_knowledge_chunks(pool, None)
            .await
            .map_err(|e| e.to_string());
    };

    let mut seen_doc_ids: HashSet<&str> = HashSet::new();
    let mut merged = Vec::new();
    for doc_id in document_ids {
        let trimmed = doc_id.trim();
        if trimmed.is_empty() || !seen_doc_ids.insert(trimmed) {
            continue;
        }

        let mut rows = storage::list_knowledge_chunks(pool, Some(trimmed))
            .await
            .map_err(|e| e.to_string())?;
        merged.append(&mut rows);
    }

    Ok(merged)
}

fn rank_chunks(
    prompt: &str,
    query_embedding: &[f32],
    chunks: &[KnowledgeChunkRecord],
    limit: usize,
    warnings: &mut Vec<PipelineWarning>,
) -> Vec<KnowledgeSearchResult> {
    let query_lc = prompt.trim().to_lowercase();
    let mut parsing_skips = 0usize;
    let mut ranked = Vec::with_capacity(chunks.len());

    for chunk in chunks {
        let embedding = match parse_embedding(&chunk.embedding) {
            Some(vector) if vector.len() == EMBEDDING_DIM => vector,
            _ => {
                parsing_skips += 1;
                simple_embed(&chunk.content)
            }
        };

        let base_score = cosine_similarity(query_embedding, &embedding).clamp(-1.0, 1.0);
        let lexical_boost =
            if !query_lc.is_empty() && chunk.content.to_lowercase().contains(&query_lc) {
                0.15
            } else {
                0.0
            };
        let score = (base_score + lexical_boost).clamp(-1.0, 1.0);

        ranked.push(KnowledgeSearchResult {
            chunk_id: chunk.chunk_id.clone(),
            document_id: chunk.document_id.clone(),
            file_name: chunk.file_name.clone(),
            content: chunk.content.clone(),
            score,
        });
    }

    if parsing_skips > 0 {
        warnings.push(PipelineWarning {
            code: PipelineWarningCode::ParsingSkipped,
            layer: LAYER_NAME.to_string(),
            message: format!(
                "{} chunk embeddings were invalid and were rebuilt on the fly.",
                parsing_skips
            ),
        });
    }

    ranked.sort_by(|a, b| b.score.total_cmp(&a.score));

    let mut seen_chunk_ids = HashSet::new();
    let mut deduped = VecDeque::with_capacity(limit);
    for item in ranked {
        if !seen_chunk_ids.insert(item.chunk_id.clone()) {
            continue;
        }
        deduped.push_back(item);
        if deduped.len() >= limit {
            break;
        }
    }

    deduped.into_iter().collect()
}

fn parse_embedding(serialized_embedding: &str) -> Option<Vec<f32>> {
    serde_json::from_str::<Vec<f32>>(serialized_embedding).ok()
}

fn simple_embed(text: &str) -> Vec<f32> {
    let mut embedding = vec![0.0_f32; EMBEDDING_DIM];
    let mut total_weight = 0.0_f32;
    let mut tokens: Vec<String> = Vec::new();

    for mat in token_regex().find_iter(text) {
        let token = mat.as_str().to_lowercase();
        if token.is_empty() {
            continue;
        }

        add_hashed_feature(&mut embedding, &format!("tok:{token}"), 2.0);
        total_weight += 2.0;

        if token.chars().count() >= 3 {
            let chars: Vec<char> = token.chars().collect();
            for window in chars.windows(3) {
                let trigram = window.iter().collect::<String>();
                add_hashed_feature(&mut embedding, &format!("tri:{trigram}"), 0.7);
                total_weight += 0.7;
            }
        }

        tokens.push(token);
    }

    for pair in tokens.windows(2) {
        let bigram = format!("{}|{}", pair[0], pair[1]);
        add_hashed_feature(&mut embedding, &format!("bi:{bigram}"), 1.3);
        total_weight += 1.3;
    }

    if total_weight == 0.0 {
        return embedding;
    }

    for value in &mut embedding {
        *value /= total_weight;
    }

    normalize(&mut embedding);
    embedding
}

fn token_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"[A-Za-z0-9]+").expect("valid token regex"))
}

fn add_hashed_feature(target: &mut [f32], feature: &str, weight: f32) {
    let hash = fnv1a_hash(feature.as_bytes());
    let index = (hash as usize) % EMBEDDING_DIM;
    let sign = if ((hash >> 32) & 1) == 0 { 1.0 } else { -1.0 };
    target[index] += sign * weight;
}

fn fnv1a_hash(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn normalize(vector: &mut [f32]) {
    let norm = vector.iter().map(|v| v * v).sum::<f32>().sqrt();
    if norm == 0.0 {
        return;
    }
    for value in vector {
        *value /= norm;
    }
}

fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    a.iter().zip(b.iter()).map(|(x, y)| x * y).sum()
}

#[cfg(test)]
mod tests {
    use super::{cosine_similarity, run, simple_embed};
    use crate::pipeline::types::{LayerStatus, RetrievalMode, RetrievalPlan};
    use sqlx::SqlitePool;

    #[test]
    fn related_text_scores_above_unrelated_text() {
        let query = simple_embed("rust async streaming");
        let related = simple_embed("async rust task streaming tokens");
        let unrelated = simple_embed("mango banana orange");

        let related_score = cosine_similarity(&query, &related);
        let unrelated_score = cosine_similarity(&query, &unrelated);

        assert!(related_score > unrelated_score);
    }

    #[tokio::test]
    async fn non_searchable_query_falls_back_to_empty_context() {
        let pool = SqlitePool::connect_lazy("sqlite::memory:").expect("lazy sqlite pool");
        let plan = RetrievalPlan {
            mode: RetrievalMode::Vector,
            limit: 8,
            document_ids: None,
        };

        let outcome = run(&pool, "!!! ??? ###", &plan).await;
        assert_eq!(outcome.status, LayerStatus::Fallback);
        assert_eq!(outcome.data.expect("fallback output should exist").len(), 0);
    }
}
