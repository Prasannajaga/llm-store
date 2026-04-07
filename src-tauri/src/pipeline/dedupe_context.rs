use std::collections::HashSet;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::time::Instant;

use crate::models::KnowledgeSearchResult;

use super::types::{LayerOutcome, PipelineWarning, PipelineWarningCode};

pub const LAYER_NAME: &str = "dedupe_context";

pub fn run(
    retrieved_chunks: Vec<KnowledgeSearchResult>,
    limit: usize,
) -> LayerOutcome<Vec<KnowledgeSearchResult>> {
    let started = Instant::now();
    let raw = retrieved_chunks.clone();

    if limit == 0 {
        return LayerOutcome::fallback(
            raw,
            vec![PipelineWarning {
                code: PipelineWarningCode::DedupePassthrough,
                layer: LAYER_NAME.to_string(),
                message: "Context dedupe received an invalid limit. Using raw retrieval results."
                    .to_string(),
            }],
            started.elapsed().as_millis() as u64,
        );
    }

    let deduped = catch_unwind(AssertUnwindSafe(|| dedupe_inner(retrieved_chunks, limit)));
    let elapsed = started.elapsed().as_millis() as u64;

    match deduped {
        Ok(chunks) => LayerOutcome::success(chunks, elapsed),
        Err(_) => LayerOutcome::fallback(
            raw,
            vec![PipelineWarning {
                code: PipelineWarningCode::DedupePassthrough,
                layer: LAYER_NAME.to_string(),
                message: "Context dedupe failed. Using raw retrieval results instead.".to_string(),
            }],
            elapsed,
        ),
    }
}

fn dedupe_inner(
    mut retrieved_chunks: Vec<KnowledgeSearchResult>,
    limit: usize,
) -> Vec<KnowledgeSearchResult> {
    retrieved_chunks.sort_by(|a, b| b.score.total_cmp(&a.score));

    let mut seen_chunk_ids = HashSet::new();
    let mut seen_content = HashSet::new();
    let mut out = Vec::new();

    for item in retrieved_chunks {
        if !seen_chunk_ids.insert(item.chunk_id.clone()) {
            continue;
        }

        let signature = normalize_signature(&item.content);
        if !seen_content.insert(signature) {
            continue;
        }

        out.push(item);
        if out.len() >= limit {
            break;
        }
    }

    out
}

fn normalize_signature(content: &str) -> String {
    content
        .to_lowercase()
        .split_whitespace()
        .take(64)
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::run;
    use crate::models::KnowledgeSearchResult;

    #[test]
    fn dedupe_removes_duplicate_chunk_ids() {
        let input = vec![
            KnowledgeSearchResult {
                chunk_id: "chunk-1".to_string(),
                document_id: "doc-1".to_string(),
                file_name: "a.txt".to_string(),
                content: "hello world".to_string(),
                score: 0.9,
            },
            KnowledgeSearchResult {
                chunk_id: "chunk-1".to_string(),
                document_id: "doc-1".to_string(),
                file_name: "a.txt".to_string(),
                content: "hello world".to_string(),
                score: 0.8,
            },
        ];

        let outcome = run(input, 8);
        let deduped = outcome.data.expect("deduped chunks");
        assert_eq!(deduped.len(), 1);
    }

    #[test]
    fn zero_limit_uses_passthrough_fallback() {
        let input = vec![KnowledgeSearchResult {
            chunk_id: "chunk-1".to_string(),
            document_id: "doc-1".to_string(),
            file_name: "a.txt".to_string(),
            content: "hello world".to_string(),
            score: 0.9,
        }];

        let outcome = run(input.clone(), 0);
        assert_eq!(
            outcome.status,
            crate::pipeline::types::LayerStatus::Fallback
        );
        let fallback_chunks = outcome.data.expect("fallback chunks");
        assert_eq!(fallback_chunks.len(), input.len());
    }
}
