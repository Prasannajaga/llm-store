use std::collections::{HashMap, HashSet};
use std::io::{Cursor, Read};
use std::path::Path;
use std::sync::OnceLock;

use hnsw_rs::prelude::{DistCosine, Hnsw};
use quick_xml::events::Event;
use quick_xml::Reader;
use regex::Regex;
use tauri::State;
use uuid::Uuid;
use zip::ZipArchive;

use crate::error::AppError;
use crate::models::{KnowledgeDocument, KnowledgeIngestResult, KnowledgeSearchResult};
use crate::storage::{self, AppState};

const EMBEDDING_DIM: usize = 1024;
const CHUNK_SIZE_CHARS: usize = 900;
const CHUNK_OVERLAP_CHARS: usize = 150;
const MAX_DOC_CHARS: usize = 250_000;

#[tauri::command]
pub async fn ingest_knowledge_file(
    state: State<'_, AppState>,
    path: String,
) -> Result<KnowledgeIngestResult, AppError> {
    let file_path = Path::new(&path);
    let file_name = file_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| AppError::Config("Invalid file name".to_string()))?
        .to_string();

    let bytes = std::fs::read(file_path)
        .map_err(|e| AppError::Config(format!("Failed to read file '{}': {}", path, e)))?;

    if bytes.is_empty() {
        return Err(AppError::Config("Selected file is empty".to_string()));
    }

    let raw_content = extract_text_from_file(file_path, &bytes, &path)?;
    let content = sanitize_indexable_text(raw_content)?;

    if let Some(existing_id) = storage::get_knowledge_document_id_by_path(&state.db, &path).await? {
        storage::delete_knowledge_document(&state.db, &existing_id).await?;
    }

    let chunks = chunk_text(&content, CHUNK_SIZE_CHARS, CHUNK_OVERLAP_CHARS);
    if chunks.is_empty() {
        return Err(AppError::Config(
            "Unable to derive any searchable text chunks from file".to_string(),
        ));
    }

    let document_id = Uuid::new_v4().to_string();
    let document_embedding =
        embedding_to_json(&embed_text(&content, &format!("document '{}'", file_name))?)?;

    storage::insert_knowledge_document(
        &state.db,
        &document_id,
        &file_name,
        &path,
        &content,
        &document_embedding,
    )
    .await?;

    for (index, chunk) in chunks.iter().enumerate() {
        let chunk_id = Uuid::new_v4().to_string();
        let chunk_embedding = embedding_to_json(&embed_text(
            chunk,
            &format!("chunk {} in '{}'", index + 1, file_name),
        )?)?;
        storage::insert_knowledge_chunk(
            &state.db,
            &chunk_id,
            &document_id,
            index as i64,
            chunk,
            &chunk_embedding,
        )
        .await?;
    }

    Ok(KnowledgeIngestResult {
        document_id,
        file_name,
        chunks: chunks.len(),
    })
}

#[tauri::command]
pub async fn list_knowledge_documents(
    state: State<'_, AppState>,
) -> Result<Vec<KnowledgeDocument>, AppError> {
    storage::list_knowledge_documents(&state.db).await
}

#[tauri::command]
pub async fn list_knowledge_document_chunks(
    state: State<'_, AppState>,
    document_id: String,
) -> Result<Vec<KnowledgeSearchResult>, AppError> {
    let chunks = storage::list_knowledge_chunks(&state.db, Some(document_id.as_str())).await?;
    if chunks.is_empty() {
        return Ok(vec![]);
    }

    let results = chunks
        .into_iter()
        .map(|row| KnowledgeSearchResult {
            chunk_id: row.chunk_id,
            document_id: row.document_id,
            file_name: row.file_name,
            content: row.content,
            score: 0.0,
        })
        .collect();

    Ok(results)
}

#[tauri::command]
pub async fn delete_knowledge_document(
    state: State<'_, AppState>,
    document_id: String,
) -> Result<(), AppError> {
    storage::delete_knowledge_document(&state.db, &document_id).await
}

#[tauri::command]
pub async fn search_knowledge(
    state: State<'_, AppState>,
    query: String,
    limit: Option<u32>,
    document_id: Option<String>,
    top_three_only: Option<bool>,
) -> Result<Vec<KnowledgeSearchResult>, AppError> {
    // Backward-compatible alias: default search path is vector search.
    search_knowledge_vector(state, query, limit, document_id, top_three_only).await
}

#[tauri::command]
pub async fn search_knowledge_vector(
    state: State<'_, AppState>,
    query: String,
    limit: Option<u32>,
    document_id: Option<String>,
    top_three_only: Option<bool>,
) -> Result<Vec<KnowledgeSearchResult>, AppError> {
    let normalized_query = query.trim();
    if normalized_query.is_empty() {
        return Ok(vec![]);
    }

    let query_embedding = embed_text(normalized_query, "search query")?;
    let max_results = resolve_result_limit(limit, top_three_only);
    let chunks = storage::list_knowledge_chunks(&state.db, document_id.as_deref()).await?;
    if chunks.is_empty() {
        return Ok(vec![]);
    }

    let mut candidates: Vec<(String, String, String, String, Vec<f32>)> =
        Vec::with_capacity(chunks.len());
    for row in chunks {
        let context = format!("chunk '{}' from '{}'", row.chunk_id, row.file_name);
        let embedding = parse_or_rebuild_embedding(&row.embedding, &row.content, &context)?;
        candidates.push((
            row.chunk_id,
            row.document_id,
            row.file_name,
            row.content,
            embedding,
        ));
    }

    if candidates.is_empty() {
        return Ok(vec![]);
    }

    let knbn = max_results.min(candidates.len());
    let max_nb_connection = candidates.len().max(2).min(32);
    let max_layer = ((candidates.len() as f32).ln().ceil() as usize).clamp(2, 16);
    let ef_c = (max_nb_connection * 4).max(24);
    let ef_search = (max_nb_connection * 4).max(knbn);

    let hnsw = Hnsw::<f32, DistCosine>::new(
        max_nb_connection,
        candidates.len(),
        max_layer,
        ef_c,
        DistCosine {},
    );
    for (idx, candidate) in candidates.iter().enumerate() {
        hnsw.insert((candidate.4.as_slice(), idx));
    }

    let query_lc = normalized_query.to_lowercase();
    let mut neighbours = hnsw.search(&query_embedding, knbn, ef_search);
    if neighbours.is_empty() {
        return Ok(vec![]);
    }
    neighbours.sort_by(|a, b| a.distance.total_cmp(&b.distance));

    let mut results = Vec::with_capacity(neighbours.len());
    for neighbour in neighbours {
        let idx = neighbour.d_id;
        let Some((chunk_id, doc_id, file_name, content, _embedding)) = candidates.get(idx) else {
            continue;
        };

        let base_score = (1.0 - neighbour.distance).clamp(-1.0, 1.0);
        let lexical_boost = if content.to_lowercase().contains(&query_lc) {
            0.15
        } else {
            0.0
        };
        let score = (base_score + lexical_boost).clamp(-1.0, 1.0);

        results.push(KnowledgeSearchResult {
            chunk_id: chunk_id.clone(),
            document_id: doc_id.clone(),
            file_name: file_name.clone(),
            content: content.clone(),
            score,
        });
    }

    results.sort_by(|a, b| b.score.total_cmp(&a.score));
    results.truncate(knbn);
    Ok(results)
}

#[derive(Clone)]
struct GraphNode {
    chunk_id: String,
    document_id: String,
    file_name: String,
    content: String,
    content_lc: String,
    chunk_index: i64,
    tokens: Vec<String>,
    token_set: HashSet<String>,
}

#[tauri::command]
pub async fn search_knowledge_graph(
    state: State<'_, AppState>,
    query: String,
    limit: Option<u32>,
    document_id: Option<String>,
    top_three_only: Option<bool>,
) -> Result<Vec<KnowledgeSearchResult>, AppError> {
    let normalized_query = query.trim();
    if normalized_query.is_empty() {
        return Ok(vec![]);
    }

    let max_results = resolve_result_limit(limit, top_three_only);
    let chunks = storage::list_knowledge_chunks(&state.db, document_id.as_deref()).await?;
    if chunks.is_empty() {
        return Ok(vec![]);
    }

    let nodes: Vec<GraphNode> = chunks
        .into_iter()
        .map(|row| {
            let tokens = graph_tokens(&row.content);
            let token_set = tokens.iter().cloned().collect::<HashSet<_>>();
            GraphNode {
                chunk_id: row.chunk_id,
                document_id: row.document_id,
                file_name: row.file_name,
                content_lc: row.content.to_lowercase(),
                content: row.content,
                chunk_index: row.chunk_index,
                tokens,
                token_set,
            }
        })
        .collect();

    if nodes.is_empty() {
        return Ok(vec![]);
    }

    let query_lc = normalized_query.to_lowercase();
    let query_tokens = graph_tokens(normalized_query);
    let query_token_set = query_tokens.into_iter().collect::<HashSet<_>>();
    let query_token_count = query_token_set.len().max(1) as f32;

    // Build graph edges:
    // 1) adjacency edges inside each document by chunk order
    // 2) lexical-similarity edges based on token overlap
    let mut edges: Vec<Vec<(usize, f32)>> = vec![Vec::new(); nodes.len()];

    let mut by_doc: HashMap<&str, Vec<(i64, usize)>> = HashMap::new();
    for (idx, node) in nodes.iter().enumerate() {
        by_doc
            .entry(node.document_id.as_str())
            .or_default()
            .push((node.chunk_index, idx));
    }
    for chunks_in_doc in by_doc.values_mut() {
        chunks_in_doc.sort_by(|a, b| a.0.cmp(&b.0));
        for pair in chunks_in_doc.windows(2) {
            let a = pair[0].1;
            let b = pair[1].1;
            add_weighted_edge(&mut edges, a, b, 0.72);
        }
    }

    let mut postings: HashMap<String, Vec<usize>> = HashMap::new();
    for (idx, node) in nodes.iter().enumerate() {
        for token in node.tokens.iter().take(24) {
            postings.entry(token.clone()).or_default().push(idx);
        }
    }

    for idx in 0..nodes.len() {
        let node = &nodes[idx];
        let mut overlap_counter: HashMap<usize, usize> = HashMap::new();

        for token in node.tokens.iter().take(18) {
            let Some(posting) = postings.get(token) else {
                continue;
            };
            if posting.len() > 96 {
                continue;
            }

            for &other_idx in posting {
                if other_idx == idx {
                    continue;
                }
                *overlap_counter.entry(other_idx).or_insert(0) += 1;
            }
        }

        let mut candidates = overlap_counter
            .into_iter()
            .filter_map(|(other_idx, overlap)| {
                let union = node.token_set.len() + nodes[other_idx].token_set.len() - overlap;
                if union == 0 {
                    return None;
                }
                let jaccard = overlap as f32 / union as f32;
                if jaccard < 0.14 {
                    return None;
                }
                let weight = (0.45 + jaccard * 0.8).min(0.92);
                Some((other_idx, weight))
            })
            .collect::<Vec<_>>();

        candidates.sort_by(|a, b| b.1.total_cmp(&a.1));
        candidates.truncate(6);
        for (other_idx, weight) in candidates {
            add_weighted_edge(&mut edges, idx, other_idx, weight);
        }
    }

    let mut seed_scores = vec![0.0_f32; nodes.len()];
    let mut frontier: HashMap<usize, f32> = HashMap::new();
    for (idx, node) in nodes.iter().enumerate() {
        let overlap = query_token_set.intersection(&node.token_set).count() as f32;
        let overlap_score = overlap / query_token_count;
        let exact_boost = if node.content_lc.contains(&query_lc) {
            0.35
        } else {
            0.0
        };
        let seed_score = (overlap_score + exact_boost).clamp(0.0, 1.0);
        if seed_score > 0.0 {
            seed_scores[idx] = seed_score;
            frontier.insert(idx, seed_score);
        }
    }

    if frontier.is_empty() {
        return Ok(vec![]);
    }

    let mut graph_scores = seed_scores;
    let max_hops = 2usize;
    for _ in 0..max_hops {
        let mut next_frontier: HashMap<usize, f32> = HashMap::new();

        for (node_idx, node_score) in &frontier {
            for (neighbor_idx, edge_weight) in &edges[*node_idx] {
                let propagated = (node_score * edge_weight * 0.82).clamp(0.0, 1.0);
                if propagated < 0.05 {
                    continue;
                }

                let entry = next_frontier.entry(*neighbor_idx).or_insert(0.0);
                if propagated > *entry {
                    *entry = propagated;
                }
            }
        }

        if next_frontier.is_empty() {
            break;
        }

        for (idx, score) in &next_frontier {
            if *score > graph_scores[*idx] {
                graph_scores[*idx] = *score;
            }
        }

        frontier = next_frontier;
    }

    let mut ranked = graph_scores
        .iter()
        .enumerate()
        .filter_map(|(idx, base)| {
            if *base <= 0.0 {
                return None;
            }
            let lexical_boost = if nodes[idx].content_lc.contains(&query_lc) {
                0.12
            } else {
                0.0
            };
            Some((idx, (base + lexical_boost).clamp(0.0, 1.0)))
        })
        .collect::<Vec<_>>();

    ranked.sort_by(|a, b| b.1.total_cmp(&a.1));
    ranked.truncate(max_results.min(ranked.len()));

    let results = ranked
        .into_iter()
        .map(|(idx, score)| KnowledgeSearchResult {
            chunk_id: nodes[idx].chunk_id.clone(),
            document_id: nodes[idx].document_id.clone(),
            file_name: nodes[idx].file_name.clone(),
            content: nodes[idx].content.clone(),
            score,
        })
        .collect::<Vec<_>>();

    Ok(results)
}

fn resolve_result_limit(limit: Option<u32>, top_three_only: Option<bool>) -> usize {
    if top_three_only.unwrap_or(false) {
        3
    } else {
        limit.unwrap_or(8).clamp(1, 50) as usize
    }
}

fn graph_tokens(text: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    token_regex()
        .find_iter(text)
        .map(|m| m.as_str().to_lowercase())
        .filter(|token| token.len() >= 2)
        .filter(|token| seen.insert(token.clone()))
        .collect()
}

fn add_weighted_edge(edges: &mut [Vec<(usize, f32)>], a: usize, b: usize, weight: f32) {
    if a == b {
        return;
    }
    upsert_edge(&mut edges[a], b, weight);
    upsert_edge(&mut edges[b], a, weight);
}

fn upsert_edge(neighbors: &mut Vec<(usize, f32)>, target: usize, weight: f32) {
    if let Some((_, existing)) = neighbors.iter_mut().find(|(idx, _)| *idx == target) {
        if weight > *existing {
            *existing = weight;
        }
        return;
    }
    neighbors.push((target, weight));
}

fn extract_text_from_file(
    path: &Path,
    bytes: &[u8],
    original_path: &str,
) -> Result<String, AppError> {
    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase());

    match extension.as_deref() {
        Some("pdf") => extract_pdf_text(bytes, original_path),
        Some("docx") => extract_docx_text(bytes, original_path),
        Some("csv") => extract_csv_text(bytes, original_path),
        Some("doc") => Err(AppError::Config(format!(
            "Unsupported Word format for '{}'. Please convert .doc to .docx first.",
            original_path
        ))),
        _ => extract_plain_text(bytes),
    }
}

fn extract_pdf_text(bytes: &[u8], path: &str) -> Result<String, AppError> {
    pdf_extract::extract_text_from_mem(bytes).map_err(|e| {
        AppError::Config(format!(
            "Failed to extract text from PDF '{}': {}. If this PDF is scanned images, OCR is required.",
            path, e
        ))
    })
}

fn extract_docx_text(bytes: &[u8], path: &str) -> Result<String, AppError> {
    let cursor = Cursor::new(bytes);
    let mut archive = ZipArchive::new(cursor)
        .map_err(|e| AppError::Config(format!("Failed to open DOCX '{}': {}", path, e)))?;

    let mut document_xml = archive.by_name("word/document.xml").map_err(|e| {
        AppError::Config(format!(
            "Invalid DOCX '{}': missing word/document.xml ({})",
            path, e
        ))
    })?;

    let mut xml_content = String::new();
    document_xml.read_to_string(&mut xml_content).map_err(|e| {
        AppError::Config(format!(
            "Failed to read DOCX XML content from '{}': {}",
            path, e
        ))
    })?;

    extract_text_from_docx_xml(&xml_content, path)
}

fn extract_text_from_docx_xml(xml: &str, path: &str) -> Result<String, AppError> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);

    let mut output = String::new();
    loop {
        match reader.read_event() {
            Ok(Event::Text(text)) => {
                let text_value = text.decode().map_err(|e| {
                    AppError::Config(format!("Failed to decode DOCX text from '{}': {}", path, e))
                })?;
                push_extracted_text(&mut output, text_value.as_ref());
            }
            Ok(Event::CData(text)) => {
                let text_value = text.decode().map_err(|e| {
                    AppError::Config(format!(
                        "Failed to decode DOCX CDATA from '{}': {}",
                        path, e
                    ))
                })?;
                push_extracted_text(&mut output, text_value.as_ref());
            }
            Ok(Event::End(end)) => {
                let tag = end.name();
                let tag_name = tag.as_ref();
                if tag_name == b"w:p" || tag_name == b"w:tr" || tag_name == b"w:tbl" {
                    if !output.ends_with('\n') {
                        output.push('\n');
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => {
                return Err(AppError::Config(format!(
                    "Failed to parse DOCX XML for '{}': {}",
                    path, e
                )))
            }
            _ => {}
        }
    }

    Ok(output)
}

fn extract_csv_text(bytes: &[u8], path: &str) -> Result<String, AppError> {
    let mut reader = csv::ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .from_reader(Cursor::new(bytes));

    let mut rows = Vec::new();
    for (index, record) in reader.records().enumerate() {
        let record = record.map_err(|e| {
            AppError::Config(format!(
                "Failed to parse CSV '{}' at row {}: {}",
                path,
                index + 1,
                e
            ))
        })?;

        let line = record
            .iter()
            .map(str::trim)
            .filter(|field| !field.is_empty())
            .collect::<Vec<_>>()
            .join(" | ");

        if !line.is_empty() {
            rows.push(line);
        }
    }

    if rows.is_empty() {
        return Ok(extract_plain_text(bytes)?);
    }

    Ok(rows.join("\n"))
}

fn extract_plain_text(bytes: &[u8]) -> Result<String, AppError> {
    if bytes.is_empty() {
        return Err(AppError::Config("Selected file is empty".to_string()));
    }
    Ok(String::from_utf8_lossy(bytes).to_string())
}

fn push_extracted_text(target: &mut String, value: &str) {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return;
    }

    if !target.is_empty() && !target.ends_with(char::is_whitespace) {
        target.push(' ');
    }
    target.push_str(trimmed);
}

fn sanitize_indexable_text(content: String) -> Result<String, AppError> {
    let mut normalized = content.replace('\u{0000}', " ");
    normalized = normalized.trim().to_string();
    if normalized.is_empty() {
        return Err(AppError::Config(
            "File does not contain extractable text that can be indexed".to_string(),
        ));
    }

    if normalized.chars().count() > MAX_DOC_CHARS {
        normalized = normalized.chars().take(MAX_DOC_CHARS).collect();
    }
    Ok(normalized)
}

fn embedding_to_json(embedding: &[f32]) -> Result<String, AppError> {
    serde_json::to_string(embedding)
        .map_err(|e| AppError::Config(format!("Failed to serialize embedding: {}", e)))
}

fn embed_text(text: &str, context: &str) -> Result<Vec<f32>, AppError> {
    if text.trim().is_empty() {
        return Err(AppError::Config(format!(
            "Embedding failed for {}: input text is empty",
            context
        )));
    }

    let embedding = simple_embed(text);
    if embedding.len() != EMBEDDING_DIM {
        return Err(AppError::Config(format!(
            "Embedding failed for {}: expected {} dimensions, got {}",
            context,
            EMBEDDING_DIM,
            embedding.len()
        )));
    }

    if embedding.iter().all(|v| v.abs() < f32::EPSILON) {
        return Err(AppError::Config(format!(
            "Embedding failed for {}: no searchable tokens found",
            context
        )));
    }

    Ok(embedding)
}

fn parse_or_rebuild_embedding(
    serialized_embedding: &str,
    source_content: &str,
    context: &str,
) -> Result<Vec<f32>, AppError> {
    match serde_json::from_str::<Vec<f32>>(serialized_embedding) {
        Ok(vector) if vector.len() == EMBEDDING_DIM => {
            if vector.iter().all(|v| v.abs() < f32::EPSILON) {
                embed_text(source_content, context)
            } else {
                Ok(vector)
            }
        }
        Ok(_) | Err(_) => embed_text(source_content, context).map_err(|e| {
            AppError::Config(format!(
                "Vector recovery failed for {}: {}. Re-index this file.",
                context, e
            ))
        }),
    }
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
            let token_chars: Vec<char> = token.chars().collect();
            for window in token_chars.windows(3) {
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

#[cfg(test)]
fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    a.iter().zip(b.iter()).map(|(x, y)| x * y).sum()
}

#[derive(Clone)]
struct Segment {
    text: String,
    paragraph_break_before: bool,
}

fn paragraph_split_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\n\s*\n+").expect("valid paragraph regex"))
}

fn sentence_split_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        // Captures sentence-like spans ending in punctuation or end-of-paragraph.
        Regex::new(r"(?s)[^.!?]+(?:[.!?]+|$)").expect("valid sentence regex")
    })
}

fn token_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"[A-Za-z0-9]+").expect("valid token regex"))
}

fn split_into_segments(content: &str) -> Vec<Segment> {
    let paragraph_re = paragraph_split_regex();
    let sentence_re = sentence_split_regex();
    let paragraphs: Vec<&str> = paragraph_re
        .split(content)
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .collect();

    let mut segments = Vec::new();
    for (p_idx, paragraph) in paragraphs.iter().enumerate() {
        let mut found_sentence = false;
        for sentence in sentence_re.find_iter(paragraph) {
            let text = sentence.as_str().trim();
            if text.is_empty() {
                continue;
            }
            segments.push(Segment {
                text: text.to_string(),
                paragraph_break_before: p_idx > 0 && !found_sentence,
            });
            found_sentence = true;
        }

        if !found_sentence {
            segments.push(Segment {
                text: (*paragraph).to_string(),
                paragraph_break_before: p_idx > 0,
            });
        }
    }

    segments
}

fn ends_with_whitespace(input: &str) -> bool {
    input.chars().last().is_some_and(char::is_whitespace)
}

fn append_segment(target: &mut String, segment: &Segment) {
    let text = segment.text.trim();
    if text.is_empty() {
        return;
    }

    if target.is_empty() {
        target.push_str(text);
        return;
    }

    if segment.paragraph_break_before {
        if !target.ends_with("\n\n") {
            target.push_str("\n\n");
        }
    } else if !ends_with_whitespace(target) {
        target.push(' ');
    }

    target.push_str(text);
}

fn tail_segments_for_overlap(segments: &[Segment], overlap_chars: usize) -> Vec<Segment> {
    if overlap_chars == 0 || segments.is_empty() {
        return vec![];
    }

    let mut collected = Vec::new();
    let mut total = 0usize;
    for segment in segments.iter().rev() {
        collected.push(segment.clone());
        total += segment.text.chars().count();
        if total >= overlap_chars {
            break;
        }
    }
    collected.reverse();

    if let Some(first) = collected.first_mut() {
        first.paragraph_break_before = false;
    }
    collected
}

fn split_long_segment(text: &str, max_chars: usize, overlap_chars: usize) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    if chars.is_empty() {
        return vec![];
    }

    let mut chunks = Vec::new();
    let mut start = 0usize;
    let fallback_overlap = overlap_chars.min(max_chars.saturating_sub(1));

    while start < chars.len() {
        let end = (start + max_chars).min(chars.len());
        let chunk = chars[start..end]
            .iter()
            .collect::<String>()
            .trim()
            .to_string();
        if !chunk.is_empty() {
            chunks.push(chunk);
        }
        if end >= chars.len() {
            break;
        }
        start = end.saturating_sub(fallback_overlap);
    }

    chunks
}

fn chunk_text(content: &str, max_chars: usize, overlap_chars: usize) -> Vec<String> {
    let cleaned = content.replace("\r\n", "\n");
    let segments = split_into_segments(&cleaned);
    if segments.is_empty() {
        return vec![];
    }

    let mut chunks = Vec::new();
    let mut current = String::new();
    let mut current_segments: Vec<Segment> = Vec::new();

    for segment in segments {
        let mut candidate = current.clone();
        append_segment(&mut candidate, &segment);
        if candidate.chars().count() <= max_chars {
            current = candidate;
            current_segments.push(segment);
            continue;
        }

        if !current.trim().is_empty() {
            chunks.push(current.trim().to_string());
        }

        let overlap_seed = tail_segments_for_overlap(&current_segments, overlap_chars);
        current_segments = overlap_seed;
        current.clear();
        for retained in &current_segments {
            append_segment(&mut current, retained);
        }

        let mut with_segment = current.clone();
        append_segment(&mut with_segment, &segment);
        if with_segment.chars().count() <= max_chars {
            current = with_segment;
            current_segments.push(segment);
            continue;
        }

        if !current.trim().is_empty() {
            chunks.push(current.trim().to_string());
            current.clear();
            current_segments.clear();
        }

        let long_parts = split_long_segment(&segment.text, max_chars, overlap_chars);
        chunks.extend(long_parts);
    }

    if !current.trim().is_empty() {
        chunks.push(current.trim().to_string());
    }

    chunks
}

#[cfg(test)]
mod tests {
    use super::{
        chunk_text, cosine_similarity, embed_text, parse_or_rebuild_embedding, simple_embed,
        EMBEDDING_DIM,
    };

    #[test]
    fn chunk_text_splits_large_content() {
        let text = "hello ".repeat(500);
        let chunks = chunk_text(&text, 200, 50);
        assert!(chunks.len() > 1);
        assert!(chunks.iter().all(|chunk| !chunk.trim().is_empty()));
    }

    #[test]
    fn chunk_text_preserves_paragraph_boundaries_when_possible() {
        let text =
            "First sentence. Second sentence.\n\nThird paragraph starts here. Fourth follows.";
        let chunks = chunk_text(text, 500, 100);
        assert_eq!(chunks.len(), 1);
        assert!(chunks[0].contains("\n\nThird paragraph"));
    }

    #[test]
    fn chunk_text_prefers_sentence_boundaries() {
        let text = "Sentence one. Sentence two is a bit longer. Sentence three. Sentence four.";
        let chunks = chunk_text(text, 50, 10);
        assert!(chunks.len() > 1);
        assert!(chunks.iter().all(|chunk| !chunk.ends_with(" Sent")));
    }

    #[test]
    fn simple_embed_is_stable_for_same_input() {
        let a = simple_embed("semantic search for docs");
        let b = simple_embed("semantic search for docs");
        assert_eq!(a, b);
    }

    #[test]
    fn cosine_similarity_prefers_related_text() {
        let query = simple_embed("rust async streaming");
        let related = simple_embed("async rust task streaming tokens");
        let unrelated = simple_embed("banana orange mango");

        let related_score = cosine_similarity(&query, &related);
        let unrelated_score = cosine_similarity(&query, &unrelated);
        assert!(related_score > unrelated_score);
    }

    #[test]
    fn embed_text_rejects_non_searchable_input() {
        let result = embed_text("!!! ??? ###", "search query");
        assert!(result.is_err());
        assert!(result
            .expect_err("expected embedding error")
            .to_string()
            .contains("no searchable tokens"));
    }

    #[test]
    fn parse_or_rebuild_embedding_recovers_invalid_vector_json() {
        let rebuilt = parse_or_rebuild_embedding("not-json", "rust async", "chunk test")
            .expect("should rebuild embedding from source content");
        assert_eq!(rebuilt.len(), EMBEDDING_DIM);
    }
}
