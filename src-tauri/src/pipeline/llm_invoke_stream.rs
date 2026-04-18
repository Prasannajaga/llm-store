use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use serde::Deserialize;
use serde_json::json;
use sqlx::SqlitePool;
use tauri::{AppHandle, Emitter};

use crate::config::{REASONING_CLOSE_MARKERS, REASONING_OPEN_MARKERS};
use crate::events::TOKEN_STREAM;
use crate::storage;

use super::types::{
    LayerOutcome, LlmInvokeResult, PipelineError, PipelineErrorCode, PipelineWarning,
    PipelineWarningCode, TokenStreamEvent,
};

pub const LAYER_NAME: &str = "llm_invoke_stream";
const MAX_STREAM_REMAINDER_BYTES: usize = 128 * 1024;

pub async fn run(
    app: &AppHandle,
    pool: &SqlitePool,
    cancellation_flag: Arc<AtomicBool>,
    request_id: &str,
    prompt: &str,
) -> Result<LayerOutcome<LlmInvokeResult>, PipelineError> {
    let settings = load_settings_map(pool, request_id).await?;
    run_with_settings(app, cancellation_flag, request_id, prompt, &settings).await
}

pub async fn run_with_settings(
    app: &AppHandle,
    cancellation_flag: Arc<AtomicBool>,
    request_id: &str,
    prompt: &str,
    settings: &HashMap<String, String>,
) -> Result<LayerOutcome<LlmInvokeResult>, PipelineError> {
    let started = Instant::now();
    let config = LlmConfig::from_settings(settings);

    let client = reqwest::Client::new();
    let request_body = json!({
        "prompt": prompt,
        "stream": true,
        "n_predict": config.max_tokens,
        "temperature": config.temperature,
        "top_p": config.top_p,
        "top_k": config.top_k,
        "repeat_penalty": config.repeat_penalty,
    });
    tracing::info!(
        target: "state_logger",
        module = "pipeline",
        event = "llama_completion_request_payload",
        request_id = %request_id,
        endpoint_url = %config.endpoint_url,
        payload = %request_body,
        "Exact JSON payload sent to llama-server /completion"
    );

    let mut request_builder = client.post(&config.endpoint_url).json(&request_body);
    if let Some(auth_header) = &config.authorization_header {
        request_builder = request_builder.header(reqwest::header::AUTHORIZATION, auth_header);
    }

    let mut response = request_builder.send().await.map_err(|err| {
        PipelineError::new(
            PipelineErrorCode::LlmInvoke,
            LAYER_NAME,
            "Unable to generate a response right now. Please try again.",
            format!(
                "Failed POST to model endpoint '{}': {}",
                config.endpoint_url, err
            ),
            request_id,
        )
    })?;

    if !response.status().is_success() {
        return Err(PipelineError::new(
            PipelineErrorCode::LlmInvoke,
            LAYER_NAME,
            "Generation service returned an unexpected status. Please try again.",
            format!(
                "Model endpoint '{}' returned HTTP {} {}",
                config.endpoint_url,
                response.status().as_u16(),
                response.status()
            ),
            request_id,
        ));
    }

    let reserved_chars = (config.max_tokens as usize)
        .saturating_mul(5)
        .min(256 * 1024);
    let mut full_text = String::with_capacity(reserved_chars);
    let mut buffer = String::new();
    let mut finish_reason = "completed".to_string();
    let mut parse_skips = 0usize;
    let mut remainder_trims = 0usize;
    let mut saw_reasoning_field = false;
    let mut implicit_think_open_emitted = false;
    let prompt_prefills_reasoning =
        config.thinking_mode && prompt_ends_with_reasoning_open_marker(prompt);
    let mut done = false;

    while let Some(chunk) = response.chunk().await.map_err(|err| {
        PipelineError::new(
            PipelineErrorCode::LlmInvoke,
            LAYER_NAME,
            "Streaming interrupted unexpectedly. Please try again.",
            format!("Failed while reading model stream: {}", err),
            request_id,
        )
    })? {
        if cancellation_flag.load(Ordering::SeqCst) {
            finish_reason = "cancelled".to_string();
            break;
        }

        buffer.push_str(&String::from_utf8_lossy(&chunk));
        let (payloads, remainder) = extract_sse_payloads(&buffer);
        buffer = remainder;
        if buffer.len() > MAX_STREAM_REMAINDER_BYTES {
            buffer = keep_recent_utf8_bytes(buffer, MAX_STREAM_REMAINDER_BYTES);
            remainder_trims += 1;
        }

        for payload in payloads {
            if payload == "[DONE]" {
                finish_reason = "done".to_string();
                done = true;
                break;
            }

            match serde_json::from_str::<LlamaStreamChunk>(&payload) {
                Ok(parsed) => {
                    if config.thinking_mode {
                        if let Some(reasoning_chunk) = parsed.reasoning_chunk() {
                            saw_reasoning_field = true;
                            let wrapped = format!("<think>{}</think>", reasoning_chunk);
                            full_text.push_str(&wrapped);
                            app.emit(
                                TOKEN_STREAM,
                                TokenStreamEvent {
                                    request_id: request_id.to_string(),
                                    token: wrapped,
                                },
                            )
                            .map_err(|err| {
                                PipelineError::new(
                                    PipelineErrorCode::LlmInvoke,
                                    LAYER_NAME,
                                    "Failed to stream response to UI. Please retry.",
                                    format!("Event emit failed for token stream: {}", err),
                                    request_id,
                                )
                            })?;
                        }
                    }

                    if let Some(content) = parsed.answer_chunk() {
                        if prompt_prefills_reasoning
                            && !saw_reasoning_field
                            && !implicit_think_open_emitted
                        {
                            let implicit_open = "<think>";
                            full_text.push_str(implicit_open);
                            app.emit(
                                TOKEN_STREAM,
                                TokenStreamEvent {
                                    request_id: request_id.to_string(),
                                    token: implicit_open.to_string(),
                                },
                            )
                            .map_err(|err| {
                                PipelineError::new(
                                    PipelineErrorCode::LlmInvoke,
                                    LAYER_NAME,
                                    "Failed to stream response to UI. Please retry.",
                                    format!("Event emit failed for token stream: {}", err),
                                    request_id,
                                )
                            })?;
                            implicit_think_open_emitted = true;
                        }

                        full_text.push_str(content);
                        app.emit(
                            TOKEN_STREAM,
                            TokenStreamEvent {
                                request_id: request_id.to_string(),
                                token: content.to_string(),
                            },
                        )
                        .map_err(|err| {
                            PipelineError::new(
                                PipelineErrorCode::LlmInvoke,
                                LAYER_NAME,
                                "Failed to stream response to UI. Please retry.",
                                format!("Event emit failed for token stream: {}", err),
                                request_id,
                            )
                        })?;
                    }

                    if parsed.stop.unwrap_or(false) {
                        finish_reason = parsed.finish_reason();
                        done = true;
                        break;
                    }
                }
                Err(_) => {
                    parse_skips += 1;
                }
            }
        }

        if done {
            break;
        }
    }

    if done && finish_reason == "completed" {
        finish_reason = "done".to_string();
    }

    let elapsed = started.elapsed().as_millis() as u64;
    let (answer_text, reasoning_text) = if config.thinking_mode {
        let (answer, reasoning) = split_reasoning_from_text(&full_text);
        let reasoning_text = {
            let trimmed = reasoning.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        };
        (answer, reasoning_text)
    } else {
        (full_text, None)
    };
    let mut outcome = LayerOutcome::success(
        LlmInvokeResult {
            answer_text,
            reasoning_text,
            finish_reason,
        },
        elapsed,
    );
    if parse_skips > 0 {
        outcome.warnings.push(PipelineWarning {
            code: PipelineWarningCode::ParsingSkipped,
            layer: LAYER_NAME.to_string(),
            message: format!(
                "{} stream payload fragments could not be parsed and were skipped.",
                parse_skips
            ),
        });
    }
    if remainder_trims > 0 {
        outcome.warnings.push(PipelineWarning {
            code: PipelineWarningCode::ParsingSkipped,
            layer: LAYER_NAME.to_string(),
            message: format!(
                "Trimmed oversized stream remainder buffer {} time(s) to protect memory.",
                remainder_trims
            ),
        });
    }

    Ok(outcome)
}

#[derive(Debug, Clone)]
struct LlmConfig {
    endpoint_url: String,
    authorization_header: Option<String>,
    max_tokens: u32,
    temperature: f32,
    top_p: f32,
    top_k: u32,
    repeat_penalty: f32,
    thinking_mode: bool,
}

impl LlmConfig {
    fn from_settings(settings: &HashMap<String, String>) -> Self {
        let port = settings
            .get("llamaServer.port")
            .and_then(|value| value.parse::<u16>().ok())
            .unwrap_or(8080);
        let (endpoint_url, use_custom_url) = resolve_generation_endpoint(settings, port);
        let authorization_header = if use_custom_url {
            settings
                .get("model.customApiKey")
                .map(|raw| raw.trim())
                .filter(|raw| !raw.is_empty())
                .map(normalize_auth_header)
        } else {
            None
        };

        let max_tokens = settings
            .get("generation.maxTokens")
            .and_then(|value| value.parse::<u32>().ok())
            .unwrap_or(512);
        let temperature = settings
            .get("generation.temperature")
            .and_then(|value| value.parse::<f32>().ok())
            .unwrap_or(0.7);
        let top_p = settings
            .get("generation.topP")
            .and_then(|value| value.parse::<f32>().ok())
            .unwrap_or(0.9);
        let top_k = settings
            .get("generation.topK")
            .and_then(|value| value.parse::<u32>().ok())
            .unwrap_or(40);
        let repeat_penalty = settings
            .get("generation.repeatPenalty")
            .and_then(|value| value.parse::<f32>().ok())
            .unwrap_or(1.1);
        let thinking_mode = settings
            .get("generation.thinkingMode")
            .map_or(false, |raw| {
                matches!(
                    raw.trim().to_ascii_lowercase().as_str(),
                    "1" | "true" | "yes" | "on"
                )
            });

        Self {
            endpoint_url,
            authorization_header,
            max_tokens,
            temperature,
            top_p,
            top_k,
            repeat_penalty,
            thinking_mode,
        }
    }
}

fn resolve_generation_endpoint(settings: &HashMap<String, String>, port: u16) -> (String, bool) {
    let fallback_endpoint = format!("http://127.0.0.1:{}/completion", port);
    let use_custom_url = setting_bool(settings, "model.useCustomUrl", false);
    let custom_url = settings
        .get("model.customUrl")
        .map(|raw| raw.trim())
        .filter(|raw| !raw.is_empty())
        .map(ToOwned::to_owned);
    let pipeline_override = settings
        .get("pipeline.endpoint_url")
        .map(|raw| raw.trim())
        .filter(|raw| !raw.is_empty())
        .map(ToOwned::to_owned);

    if use_custom_url {
        let endpoint = custom_url
            .or(pipeline_override)
            .unwrap_or_else(|| fallback_endpoint.clone());
        return (endpoint, true);
    }

    (
        pipeline_override.unwrap_or_else(|| fallback_endpoint),
        false,
    )
}

fn setting_bool(settings: &HashMap<String, String>, key: &str, default: bool) -> bool {
    settings.get(key).map_or(default, |raw| {
        matches!(
            raw.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        )
    })
}

fn normalize_auth_header(raw: &str) -> String {
    if raw.to_ascii_lowercase().starts_with("bearer ") {
        raw.to_string()
    } else {
        format!("Bearer {}", raw)
    }
}

async fn load_settings_map(
    pool: &SqlitePool,
    request_id: &str,
) -> Result<HashMap<String, String>, PipelineError> {
    let entries = storage::load_all_settings(pool).await.map_err(|err| {
        PipelineError::new(
            PipelineErrorCode::LlmInvoke,
            LAYER_NAME,
            "Unable to load generation settings. Please retry.",
            format!("Failed to load settings for stream invoke: {}", err),
            request_id,
        )
    })?;

    Ok(entries
        .into_iter()
        .map(|entry| (entry.key, entry.value))
        .collect())
}

#[derive(Debug, Deserialize)]
struct LlamaStreamChunk {
    content: Option<String>,
    text: Option<String>,
    token: Option<String>,
    reasoning_content: Option<String>,
    reasoning: Option<String>,
    thinking: Option<String>,
    thought: Option<String>,
    stop: Option<bool>,
    stopped_word: Option<bool>,
    stopped_limit: Option<bool>,
    stopped_eos: Option<bool>,
}

impl LlamaStreamChunk {
    fn answer_chunk(&self) -> Option<&str> {
        for chunk in [&self.content, &self.text, &self.token] {
            if let Some(value) = chunk.as_deref() {
                if !value.is_empty() {
                    return Some(value);
                }
            }
        }
        None
    }

    fn reasoning_chunk(&self) -> Option<&str> {
        for chunk in [
            &self.reasoning_content,
            &self.reasoning,
            &self.thinking,
            &self.thought,
        ] {
            if let Some(value) = chunk.as_deref() {
                if !value.is_empty() {
                    return Some(value);
                }
            }
        }
        None
    }

    fn finish_reason(&self) -> String {
        if self.stopped_word.unwrap_or(false) {
            "stopped_word".to_string()
        } else if self.stopped_limit.unwrap_or(false) {
            "stopped_limit".to_string()
        } else if self.stopped_eos.unwrap_or(false) {
            "stopped_eos".to_string()
        } else {
            "stopped".to_string()
        }
    }
}

fn extract_sse_payloads(buffer: &str) -> (Vec<String>, String) {
    let mut payloads = Vec::new();
    let mut consumed_until = 0usize;

    for (idx, _) in buffer.match_indices("\n\n") {
        let event_block = &buffer[consumed_until..idx];
        consumed_until = idx + 2;

        let mut data_lines = Vec::new();
        for line in event_block.lines() {
            if let Some(data) = line.strip_prefix("data:") {
                data_lines.push(data.trim().to_string());
            }
        }

        if data_lines.is_empty() {
            continue;
        }

        payloads.push(data_lines.join("\n"));
    }

    let remainder = if consumed_until < buffer.len() {
        buffer[consumed_until..].to_string()
    } else {
        String::new()
    };

    (payloads, remainder)
}

fn keep_recent_utf8_bytes(mut text: String, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text;
    }

    let mut start = text.len() - max_bytes;
    while start < text.len() && !text.is_char_boundary(start) {
        start += 1;
    }

    text.split_off(start)
}

fn prompt_ends_with_reasoning_open_marker(prompt: &str) -> bool {
    let normalized_prompt = prompt.trim_end().to_ascii_lowercase();
    REASONING_OPEN_MARKERS.iter().any(|marker| {
        let normalized_marker = marker.trim().to_ascii_lowercase();
        !normalized_marker.is_empty() && normalized_prompt.ends_with(&normalized_marker)
    })
}

fn split_reasoning_from_text(text: &str) -> (String, String) {
    let mut answer = String::with_capacity(text.len());
    let mut reasoning = String::new();
    let mut in_reasoning = false;
    let mut remaining = text;

    while !remaining.is_empty() {
        if in_reasoning {
            if let Some((idx, marker_len)) =
                find_earliest_marker_case_insensitive(remaining, REASONING_CLOSE_MARKERS)
            {
                reasoning.push_str(&remaining[..idx]);
                remaining = &remaining[idx + marker_len..];
                in_reasoning = false;
            } else {
                reasoning.push_str(remaining);
                break;
            }
        } else if let Some((idx, marker_len)) =
            find_earliest_marker_case_insensitive(remaining, REASONING_OPEN_MARKERS)
        {
            answer.push_str(&remaining[..idx]);
            remaining = &remaining[idx + marker_len..];
            in_reasoning = true;
        } else {
            answer.push_str(remaining);
            break;
        }
    }

    (answer, reasoning)
}

fn find_earliest_marker_case_insensitive(text: &str, markers: &[&str]) -> Option<(usize, usize)> {
    let lower = text.to_ascii_lowercase();
    let mut best: Option<(usize, usize)> = None;

    for marker in markers {
        let trimmed = marker.trim();
        if trimmed.is_empty() {
            continue;
        }
        let marker_lower = trimmed.to_ascii_lowercase();
        if let Some(idx) = lower.find(&marker_lower) {
            match best {
                None => {
                    best = Some((idx, trimmed.len()));
                }
                Some((best_idx, best_len)) => {
                    if idx < best_idx || (idx == best_idx && trimmed.len() > best_len) {
                        best = Some((idx, trimmed.len()));
                    }
                }
            }
        }
    }

    best
}
