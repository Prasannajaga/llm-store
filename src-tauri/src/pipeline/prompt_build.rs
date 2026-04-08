use std::collections::HashMap;
use std::time::Instant;

use serde_json::{json, Value};
use sqlx::SqlitePool;

use crate::config::REASONING_OPEN_MARKERS;
use crate::models::KnowledgeSearchResult;
use crate::storage;

use super::types::{LayerOutcome, PipelineWarning, PipelineWarningCode};

pub const LAYER_NAME: &str = "prompt_build";
const SYSTEM_INSTRUCTION: &str = "You are a helpful assistant. Use knowledge context only when it is relevant to the question. If context is insufficient or unrelated, say so clearly and continue with best-effort reasoning.";

pub async fn run(
    pool: &SqlitePool,
    request_id: &str,
    user_prompt: &str,
    chunks: &[KnowledgeSearchResult],
) -> LayerOutcome<String> {
    let started = Instant::now();
    let safe_prompt = user_prompt.trim();
    let plain_prompt = build_plain_prompt(safe_prompt, chunks);
    tracing::info!(
        target: "state_logger",
        module = "pipeline",
        event = "raw_prompt_plain",
        request_id = %request_id,
        prompt = %plain_prompt,
        "Raw plain prompt constructed"
    );

    let template_result = apply_model_chat_template(pool, request_id, &plain_prompt).await;
    let elapsed = started.elapsed().as_millis() as u64;

    match template_result {
        Ok(prompt) => {
            tracing::info!(
                target: "state_logger",
                module = "pipeline",
                event = "raw_prompt_templated",
                request_id = %request_id,
                prompt = %prompt,
                "Raw prompt after chat_template application"
            );
            LayerOutcome::success(prompt, elapsed)
        }
        Err(reason) => LayerOutcome::fallback(
            plain_prompt,
            vec![PipelineWarning {
                code: PipelineWarningCode::PromptFallbackTemplate,
                layer: LAYER_NAME.to_string(),
                message: format!(
                    "Could not apply model chat_template metadata. Falling back to plain prompt. ({})",
                    reason
                ),
            }],
            elapsed,
        ),
    }
}

#[derive(Debug, Clone)]
struct PromptBuildConfig {
    apply_template_url: String,
    thinking_mode: bool,
}

impl PromptBuildConfig {
    fn from_settings(settings: &HashMap<String, String>) -> Self {
        let port = settings
            .get("llamaServer.port")
            .and_then(|value| value.parse::<u16>().ok())
            .unwrap_or(8080);

        let endpoint_url = settings
            .get("pipeline.endpoint_url")
            .cloned()
            .unwrap_or_else(|| format!("http://127.0.0.1:{}/completion", port));

        let apply_template_url = settings
            .get("pipeline.apply_template_url")
            .cloned()
            .unwrap_or_else(|| derive_apply_template_url(&endpoint_url, port));

        let thinking_mode = setting_bool(settings, "generation.thinkingMode", false);

        Self {
            apply_template_url,
            thinking_mode,
        }
    }
}

fn derive_apply_template_url(endpoint_url: &str, port: u16) -> String {
    if let Some(prefix) = endpoint_url.strip_suffix("/completion") {
        return format!("{}/apply-template", prefix);
    }
    if let Some(prefix) = endpoint_url.strip_suffix("/v1/chat/completions") {
        return format!("{}/apply-template", prefix);
    }
    format!("http://127.0.0.1:{}/apply-template", port)
}

async fn apply_model_chat_template(
    pool: &SqlitePool,
    request_id: &str,
    plain_prompt: &str,
) -> Result<String, String> {
    let settings = load_settings_map(pool)
        .await
        .map_err(|err| format!("unable to load settings: {}", err))?;
    let config = PromptBuildConfig::from_settings(&settings);

    let body = json!({
        "messages": [
            { "role": "system", "content": SYSTEM_INSTRUCTION },
            { "role": "user", "content": plain_prompt }
        ],
        "add_generation_prompt": true
    });
    tracing::info!(
        target: "state_logger",
        module = "pipeline",
        event = "llama_apply_template_request_payload",
        request_id = %request_id,
        endpoint_url = %config.apply_template_url,
        payload = %body,
        "Exact JSON payload sent to llama-server /apply-template"
    );

    let response = reqwest::Client::new()
        .post(&config.apply_template_url)
        .json(&body)
        .send()
        .await
        .map_err(|err| {
            format!(
                "failed to call apply-template '{}' for request {}: {}",
                config.apply_template_url, request_id, err
            )
        })?;

    if !response.status().is_success() {
        return Err(format!(
            "apply-template endpoint '{}' returned HTTP {} {}",
            config.apply_template_url,
            response.status().as_u16(),
            response.status()
        ));
    }

    let payload = response
        .json::<Value>()
        .await
        .map_err(|err| format!("invalid apply-template response body: {}", err))?;

    let templated = extract_template_prompt(&payload)
        .ok_or_else(|| "apply-template response did not include a usable prompt string".to_string())?;

    if config.thinking_mode {
        return Ok(templated);
    }

    Ok(strip_trailing_reasoning_open_marker(&templated))
}

fn extract_template_prompt(payload: &Value) -> Option<String> {
    if let Some(value) = payload.as_str() {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }

    for key in ["prompt", "formatted_prompt", "result", "content"] {
        if let Some(value) = payload.get(key).and_then(|value| value.as_str()) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }

    None
}

async fn load_settings_map(pool: &SqlitePool) -> Result<HashMap<String, String>, String> {
    let entries = storage::load_all_settings(pool)
        .await
        .map_err(|e| e.to_string())?;

    Ok(entries
        .into_iter()
        .map(|entry| (entry.key, entry.value))
        .collect())
}

fn setting_bool(settings: &HashMap<String, String>, key: &str, default: bool) -> bool {
    settings.get(key).map_or(default, |raw| {
        matches!(
            raw.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        )
    })
}

fn strip_trailing_reasoning_open_marker(prompt: &str) -> String {
    let trimmed = prompt.trim_end();
    let trimmed_lower = trimmed.to_ascii_lowercase();

    let mut best_marker_len: usize = 0;
    let mut best_char_len: usize = 0;
    for marker in REASONING_OPEN_MARKERS {
        let normalized_marker = marker.trim();
        if normalized_marker.is_empty() {
            continue;
        }
        let marker_lower = normalized_marker.to_ascii_lowercase();
        if trimmed_lower.ends_with(&marker_lower) {
            let marker_chars = normalized_marker.chars().count();
            if marker_chars > best_marker_len {
                best_marker_len = marker_chars;
                best_char_len = marker_chars;
            }
        }
    }

    if best_char_len == 0 {
        return prompt.to_string();
    }

    let remove_start_char = trimmed.chars().count().saturating_sub(best_char_len);
    let mut remove_start_byte = trimmed.len();
    for (char_index, (byte_index, _)) in trimmed.char_indices().enumerate() {
        if char_index == remove_start_char {
            remove_start_byte = byte_index;
            break;
        }
    }

    let mut out = trimmed[..remove_start_byte].to_string();
    out.push_str(&prompt[trimmed.len()..]);
    out
}

fn build_plain_prompt(user_prompt: &str, chunks: &[KnowledgeSearchResult]) -> String {
    if user_prompt.is_empty() {
        return minimal_template(user_prompt);
    }

    if chunks.is_empty() {
        return user_prompt.to_string();
    }

    let context = chunks
        .iter()
        .enumerate()
        .map(|(index, hit)| {
            format!(
                "[{}] {} (score {:.3})\n{}",
                index + 1,
                hit.file_name,
                hit.score,
                hit.content
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n");

    [
        "Use the following knowledge context when it is relevant to the user question.",
        "If context is insufficient or unrelated, clearly say so and continue with best-effort reasoning.",
        "",
        "Knowledge Context:",
        &context,
        "",
        &format!("User Question: {}", user_prompt),
    ]
    .join("\n")
}

fn minimal_template(user_prompt: &str) -> String {
    let final_prompt = if user_prompt.is_empty() {
        "Please answer clearly and safely."
    } else {
        user_prompt
    };

    [
        "You are a helpful assistant.",
        "Answer clearly, and mention uncertainty when context is missing.",
        "",
        &format!("User Question: {}", final_prompt),
    ]
    .join("\n")
}

#[cfg(test)]
mod tests {
    use super::build_plain_prompt;
    use crate::models::KnowledgeSearchResult;

    #[test]
    fn empty_context_uses_raw_user_prompt() {
        let prompt = build_plain_prompt("How do I deploy this app?", &[]);
        assert_eq!(prompt, "How do I deploy this app?");
    }

    #[test]
    fn empty_user_prompt_still_uses_minimal_template() {
        let prompt = build_plain_prompt("", &[]);
        assert!(prompt.contains("You are a helpful assistant."));
        assert!(prompt.contains("Please answer clearly and safely."));
    }

    #[test]
    fn knowledge_context_is_embedded_in_plain_prompt() {
        let chunks = vec![KnowledgeSearchResult {
            chunk_id: "c1".to_string(),
            document_id: "d1".to_string(),
            file_name: "guide.md".to_string(),
            content: "Deployment steps here.".to_string(),
            score: 0.91,
        }];

        let prompt = build_plain_prompt("How to deploy?", &chunks);
        assert!(prompt.contains("Knowledge Context:"));
        assert!(prompt.contains("guide.md"));
        assert!(prompt.contains("User Question: How to deploy?"));
    }

    #[test]
    fn strips_trailing_think_marker_when_reasoning_disabled() {
        let prompt = "<|im_start|>assistant\n<think>";
        let stripped = super::strip_trailing_reasoning_open_marker(prompt);
        assert_eq!(stripped, "<|im_start|>assistant\n");
    }
}
