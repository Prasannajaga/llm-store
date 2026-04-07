use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use serde::Deserialize;
use serde_json::json;
use sqlx::SqlitePool;
use tauri::{AppHandle, Emitter};

use crate::events::TOKEN_STREAM;
use crate::storage;

use super::types::{
    LayerOutcome, LlmInvokeResult, PipelineError, PipelineErrorCode, PipelineWarning,
    PipelineWarningCode, TokenStreamEvent,
};

pub const LAYER_NAME: &str = "llm_invoke_stream";

pub async fn run(
    app: &AppHandle,
    pool: &SqlitePool,
    cancellation_flag: Arc<AtomicBool>,
    request_id: &str,
    prompt: &str,
) -> Result<LayerOutcome<LlmInvokeResult>, PipelineError> {
    let started = Instant::now();
    let settings = load_settings_map(pool, request_id).await?;
    let config = LlmConfig::from_settings(&settings);

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

    let mut response = client
        .post(&config.endpoint_url)
        .json(&request_body)
        .send()
        .await
        .map_err(|err| {
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

    let mut full_text = String::new();
    let mut buffer = String::new();
    let mut finish_reason = "completed".to_string();
    let mut parse_skips = 0usize;
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

        for payload in payloads {
            if payload == "[DONE]" {
                finish_reason = "done".to_string();
                done = true;
                break;
            }

            match serde_json::from_str::<LlamaStreamChunk>(&payload) {
                Ok(parsed) => {
                    if let Some(content) = parsed.content.as_ref() {
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
    let mut outcome = LayerOutcome::success(
        LlmInvokeResult {
            full_text,
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

    Ok(outcome)
}

#[derive(Debug, Clone)]
struct LlmConfig {
    endpoint_url: String,
    max_tokens: u32,
    temperature: f32,
    top_p: f32,
    top_k: u32,
    repeat_penalty: f32,
}

impl LlmConfig {
    fn from_settings(settings: &HashMap<String, String>) -> Self {
        let port = settings
            .get("llamaServer.port")
            .and_then(|value| value.parse::<u16>().ok())
            .unwrap_or(8080);
        let endpoint_url = settings
            .get("pipeline.endpoint_url")
            .cloned()
            .unwrap_or_else(|| format!("http://127.0.0.1:{}/completion", port));

        let max_tokens = settings
            .get("generation.maxTokens")
            .and_then(|value| value.parse::<u32>().ok())
            .unwrap_or(1024);
        let temperature = settings
            .get("generation.temperature")
            .and_then(|value| value.parse::<f32>().ok())
            .unwrap_or(0.7);
        let top_p = settings
            .get("generation.topP")
            .and_then(|value| value.parse::<f32>().ok())
            .unwrap_or(0.95);
        let top_k = settings
            .get("generation.topK")
            .and_then(|value| value.parse::<u32>().ok())
            .unwrap_or(40);
        let repeat_penalty = settings
            .get("generation.repeatPenalty")
            .and_then(|value| value.parse::<f32>().ok())
            .unwrap_or(1.1);

        Self {
            endpoint_url,
            max_tokens,
            temperature,
            top_p,
            top_k,
            repeat_penalty,
        }
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
    stop: Option<bool>,
    stopped_word: Option<bool>,
    stopped_limit: Option<bool>,
    stopped_eos: Option<bool>,
}

impl LlamaStreamChunk {
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
