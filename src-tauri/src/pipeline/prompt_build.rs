use std::collections::HashMap;
use std::time::Instant;

use serde_json::{json, Value};
use sqlx::SqlitePool;

use crate::config::REASONING_OPEN_MARKERS;
use crate::models::KnowledgeSearchResult;
use crate::models::Role;
use crate::storage;

use super::types::{LayerOutcome, PipelineWarning, PipelineWarningCode};

pub const LAYER_NAME: &str = "prompt_build";
const SYSTEM_INSTRUCTION: &str = "You are a helpful assistant. Use knowledge context only when it is relevant to the question. If context is insufficient or unrelated, say so clearly and continue with best-effort reasoning.";
const DEFAULT_MAX_CONTEXT_CHARS: usize = 12_000;
const DEFAULT_MAX_PROMPT_CHARS: usize = 24_000;
const DEFAULT_MAX_HISTORY_CHARS: usize = 8_000;
const MIN_MAX_CONTEXT_CHARS: usize = 1_500;
const MIN_MAX_PROMPT_CHARS: usize = 4_000;
const MIN_MAX_HISTORY_CHARS: usize = 1_000;
const HISTORY_RECENT_FRACTION: f32 = 0.72;
const HISTORY_SUMMARY_ITEM_MAX_CHARS: usize = 150;
const HISTORY_SUMMARY_MAX_ITEMS: usize = 12;

pub async fn run(
    pool: &SqlitePool,
    request_id: &str,
    chat_id: &str,
    user_prompt: &str,
    chunks: &[KnowledgeSearchResult],
) -> LayerOutcome<String> {
    let started = Instant::now();
    let safe_prompt = user_prompt.trim();
    let settings = match load_settings_map(pool).await {
        Ok(map) => map,
        Err(err) => {
            let elapsed = started.elapsed().as_millis() as u64;
            return LayerOutcome::fallback(
                build_plain_prompt(
                    safe_prompt,
                    "",
                    &build_context(chunks, DEFAULT_MAX_CONTEXT_CHARS).context,
                ),
                vec![PipelineWarning {
                    code: PipelineWarningCode::PromptFallbackTemplate,
                    layer: LAYER_NAME.to_string(),
                    message: format!(
                        "Unable to load prompt settings; using safe defaults. ({})",
                        err
                    ),
                }],
                elapsed,
            );
        }
    };
    let budget = PromptBudget::from_settings(&settings);
    let mut context_warnings = Vec::new();
    let conversation_context =
        match build_conversation_context(pool, chat_id, budget.max_history_chars).await {
            Ok(context) => context,
            Err(err) => {
                context_warnings.push(PipelineWarning {
                    code: PipelineWarningCode::PromptContextTrimmed,
                    layer: LAYER_NAME.to_string(),
                    message: format!(
                        "Unable to load prior conversation context. Continuing with current turn only. ({})",
                        err
                    ),
                });
                ConversationContextBuild::default()
            }
        };
    let mut plain_build =
        build_plain_prompt_with_budget(safe_prompt, &conversation_context, chunks, &budget);
    plain_build.warnings.splice(0..0, context_warnings);
    let plain_prompt = plain_build.prompt;
    let mut warnings = plain_build.warnings;
    tracing::info!(
        target: "state_logger",
        module = "pipeline",
        event = "raw_prompt_plain",
        request_id = %request_id,
        prompt_chars = plain_prompt.chars().count(),
        prompt_tokens_est = estimate_tokens(&plain_prompt),
        prompt = %plain_prompt,
        "Raw plain prompt constructed"
    );

    let template_result = apply_model_chat_template(request_id, &plain_prompt, settings).await;
    let elapsed = started.elapsed().as_millis() as u64;

    match template_result {
        Ok(prompt) => {
            let final_prompt = enforce_prompt_budget(prompt, &budget, &mut warnings);
            tracing::info!(
                target: "state_logger",
                module = "pipeline",
                event = "raw_prompt_templated",
                request_id = %request_id,
                prompt_chars = final_prompt.chars().count(),
                prompt_tokens_est = estimate_tokens(&final_prompt),
                prompt = %final_prompt,
                "Raw prompt after chat_template application"
            );
            if warnings.is_empty() {
                LayerOutcome::success(final_prompt, elapsed)
            } else {
                LayerOutcome::fallback(final_prompt, warnings, elapsed)
            }
        }
        Err(reason) => {
            warnings.push(PipelineWarning {
                code: PipelineWarningCode::PromptFallbackTemplate,
                layer: LAYER_NAME.to_string(),
                message: format!(
                    "Could not apply model chat_template metadata. Falling back to plain prompt. ({})",
                    reason
                ),
            });
            LayerOutcome::fallback(plain_prompt, warnings, elapsed)
        }
    }
}

#[derive(Debug, Clone)]
struct PromptBuildConfig {
    apply_template_url: Option<String>,
    authorization_header: Option<String>,
    thinking_mode: bool,
}

impl PromptBuildConfig {
    fn from_settings(settings: &HashMap<String, String>) -> Self {
        let port = settings
            .get("llamaServer.port")
            .and_then(|value| value.parse::<u16>().ok())
            .unwrap_or(8080);
        let (endpoint_url, use_custom_url) = resolve_generation_endpoint(settings, port);
        let explicit_apply_template = settings
            .get("pipeline.apply_template_url")
            .map(|raw| raw.trim())
            .filter(|raw| !raw.is_empty())
            .map(ToOwned::to_owned);
        let apply_template_url = explicit_apply_template.or_else(|| {
            if use_custom_url {
                None
            } else {
                Some(derive_apply_template_url(&endpoint_url, port))
            }
        });

        let authorization_header = if use_custom_url {
            settings
                .get("model.customApiKey")
                .map(|raw| raw.trim())
                .filter(|raw| !raw.is_empty())
                .map(normalize_auth_header)
        } else {
            None
        };

        let thinking_mode = setting_bool(settings, "generation.thinkingMode", false);

        Self {
            apply_template_url,
            authorization_header,
            thinking_mode,
        }
    }
}

#[derive(Debug, Clone)]
struct PromptBudget {
    max_context_chars: usize,
    max_prompt_chars: usize,
    max_history_chars: usize,
}

impl PromptBudget {
    fn from_settings(settings: &HashMap<String, String>) -> Self {
        let max_context_chars = setting_usize(
            settings,
            "pipeline.prompt.max_context_chars",
            DEFAULT_MAX_CONTEXT_CHARS,
        )
        .max(MIN_MAX_CONTEXT_CHARS);
        let max_prompt_chars = setting_usize(
            settings,
            "pipeline.prompt.max_prompt_chars",
            DEFAULT_MAX_PROMPT_CHARS,
        )
        .max(MIN_MAX_PROMPT_CHARS);
        let max_history_chars = setting_usize(
            settings,
            "pipeline.prompt.max_history_chars",
            DEFAULT_MAX_HISTORY_CHARS,
        )
        .max(MIN_MAX_HISTORY_CHARS);

        // Keep prompt budget safely above context budget.
        let max_prompt_chars = max_prompt_chars.max(max_context_chars + max_history_chars / 2 + 1_000);

        Self {
            max_context_chars,
            max_prompt_chars,
            max_history_chars,
        }
    }
}

#[derive(Debug)]
struct PlainPromptBuild {
    prompt: String,
    warnings: Vec<PipelineWarning>,
}

#[derive(Debug, Default)]
struct ConversationContextBuild {
    context: String,
    source_chars: usize,
    emitted_chars: usize,
    summarized_turns: usize,
}

#[derive(Debug, Default)]
struct KnowledgeContextBuild {
    context: String,
    source_chars: usize,
    emitted_chars: usize,
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

fn normalize_auth_header(raw: &str) -> String {
    if raw.to_ascii_lowercase().starts_with("bearer ") {
        raw.to_string()
    } else {
        format!("Bearer {}", raw)
    }
}

async fn apply_model_chat_template(
    request_id: &str,
    plain_prompt: &str,
    settings: HashMap<String, String>,
) -> Result<String, String> {
    let config = PromptBuildConfig::from_settings(&settings);
    let Some(apply_template_url) = config.apply_template_url.clone() else {
        if config.thinking_mode {
            return Ok(plain_prompt.to_string());
        }
        return Ok(strip_trailing_reasoning_open_marker(plain_prompt));
    };

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
        endpoint_url = %apply_template_url,
        payload = %body,
        "Exact JSON payload sent to llama-server /apply-template"
    );

    let mut request_builder = reqwest::Client::new().post(&apply_template_url).json(&body);
    if let Some(auth_header) = &config.authorization_header {
        request_builder = request_builder.header(reqwest::header::AUTHORIZATION, auth_header);
    }

    let response = request_builder
        .send()
        .await
        .map_err(|err| {
            format!(
                "failed to call apply-template '{}' for request {}: {}",
                apply_template_url, request_id, err
            )
        })?;

    if !response.status().is_success() {
        return Err(format!(
            "apply-template endpoint '{}' returned HTTP {} {}",
            apply_template_url,
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

fn setting_usize(settings: &HashMap<String, String>, key: &str, default: usize) -> usize {
    settings
        .get(key)
        .and_then(|raw| raw.trim().parse::<usize>().ok())
        .unwrap_or(default)
}

fn estimate_tokens(input: &str) -> usize {
    // Simple deterministic estimate for llama-like tokenizers.
    input.chars().count().div_ceil(4)
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

async fn build_conversation_context(
    pool: &SqlitePool,
    chat_id: &str,
    max_history_chars: usize,
) -> Result<ConversationContextBuild, String> {
    if max_history_chars == 0 {
        return Ok(ConversationContextBuild::default());
    }

    let messages = storage::get_messages(pool, chat_id)
        .await
        .map_err(|err| err.to_string())?;
    let turns = messages
        .into_iter()
        .filter_map(|message| {
            let role = match message.role {
                Role::User => "User",
                Role::Assistant => "Assistant",
                Role::System => return None,
            };
            let content = normalize_inline_text(&message.content);
            if content.is_empty() {
                return None;
            }
            Some(format!("{role}: {content}"))
        })
        .collect::<Vec<_>>();
    if turns.is_empty() {
        return Ok(ConversationContextBuild::default());
    }

    let source_chars = turns.iter().map(|turn| turn.chars().count()).sum::<usize>();
    let detailed_budget = ((max_history_chars as f32) * HISTORY_RECENT_FRACTION)
        .round()
        .clamp(320.0, max_history_chars as f32) as usize;
    let summary_budget = max_history_chars.saturating_sub(detailed_budget);

    let mut detailed_turns = Vec::new();
    let mut detailed_chars = 0usize;
    for turn in turns.iter().rev() {
        let turn_chars = turn.chars().count();
        let with_separator = if detailed_turns.is_empty() {
            turn_chars
        } else {
            turn_chars + 1
        };
        if !detailed_turns.is_empty() && detailed_chars + with_separator > detailed_budget {
            break;
        }
        detailed_turns.push(turn.clone());
        detailed_chars += with_separator;
        if detailed_turns.len() >= 18 {
            break;
        }
    }
    detailed_turns.reverse();

    let summarized_turns = turns.len().saturating_sub(detailed_turns.len());
    let summary = if summarized_turns == 0 || summary_budget < 96 {
        String::new()
    } else {
        build_turn_summary(
            &turns[..summarized_turns],
            summary_budget,
            summarized_turns,
        )
    };

    let mut sections: Vec<String> = Vec::new();
    if !summary.is_empty() {
        sections.push("Earlier conversation summary:".to_string());
        sections.push(summary.clone());
    }
    if !detailed_turns.is_empty() {
        sections.push("Recent conversation turns:".to_string());
        sections.push(detailed_turns.join("\n"));
    }
    let mut context = sections.join("\n\n");
    if context.chars().count() > max_history_chars {
        context = context.chars().take(max_history_chars).collect();
    }
    let emitted_chars = context.chars().count();

    Ok(ConversationContextBuild {
        context,
        source_chars,
        emitted_chars,
        summarized_turns,
    })
}

fn build_turn_summary(turns: &[String], max_chars: usize, summarized_turns: usize) -> String {
    let mut bullets = Vec::new();
    let mut used = 0usize;
    for turn in turns.iter().rev().take(HISTORY_SUMMARY_MAX_ITEMS).rev() {
        let clipped = clip_chars(turn, HISTORY_SUMMARY_ITEM_MAX_CHARS);
        if clipped.is_empty() {
            continue;
        }
        let line = format!("- {}", clipped);
        let line_chars = line.chars().count();
        let with_separator = if bullets.is_empty() {
            line_chars
        } else {
            line_chars + 1
        };
        if !bullets.is_empty() && used + with_separator > max_chars {
            break;
        }
        bullets.push(line);
        used += with_separator;
    }

    let omitted = summarized_turns.saturating_sub(bullets.len());
    if omitted > 0 {
        let marker = format!("- ... {} older turn(s) compacted", omitted);
        let marker_chars = marker.chars().count();
        if bullets.is_empty() || used + marker_chars + 1 <= max_chars {
            bullets.push(marker);
        }
    }

    bullets.join("\n")
}

fn normalize_inline_text(input: &str) -> String {
    input.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn clip_chars(input: &str, max_chars: usize) -> String {
    if max_chars == 0 {
        return String::new();
    }
    let trimmed = input.trim();
    if trimmed.chars().count() <= max_chars {
        return trimmed.to_string();
    }

    let clipped: String = trimmed.chars().take(max_chars.saturating_sub(1)).collect();
    format!("{}…", clipped.trim_end())
}

fn build_plain_prompt(
    user_prompt: &str,
    conversation_context: &str,
    knowledge_context: &str,
) -> String {
    if user_prompt.is_empty() {
        return minimal_template(user_prompt);
    }

    if conversation_context.is_empty() && knowledge_context.is_empty() {
        return user_prompt.to_string();
    }

    let mut sections = vec![
        "Use the provided context when it is relevant to the user question.".to_string(),
        "If context is insufficient or unrelated, clearly say so and continue with best-effort reasoning.".to_string(),
    ];

    if !conversation_context.is_empty() {
        sections.push(String::new());
        sections.push("Conversation Context (auto-compacted):".to_string());
        sections.push(conversation_context.to_string());
    }

    if !knowledge_context.is_empty() {
        sections.push(String::new());
        sections.push("Knowledge Context:".to_string());
        sections.push(knowledge_context.to_string());
    }

    sections.push(String::new());
    sections.push(format!("User Question: {}", user_prompt));
    sections.join("\n")
}

fn build_plain_prompt_with_budget(
    user_prompt: &str,
    conversation: &ConversationContextBuild,
    chunks: &[KnowledgeSearchResult],
    budget: &PromptBudget,
) -> PlainPromptBuild {
    let knowledge = build_context(chunks, budget.max_context_chars);
    let prompt = build_plain_prompt(user_prompt, &conversation.context, &knowledge.context);
    let mut warnings = Vec::new();

    if knowledge.emitted_chars < knowledge.source_chars {
        warnings.push(PipelineWarning {
            code: PipelineWarningCode::PromptContextTrimmed,
            layer: LAYER_NAME.to_string(),
            message: format!(
                "Knowledge context truncated to {} chars (kept {} of {} chars).",
                budget.max_context_chars, knowledge.emitted_chars, knowledge.source_chars
            ),
        });
    }

    if conversation.emitted_chars > 0 && conversation.emitted_chars < conversation.source_chars {
        warnings.push(PipelineWarning {
            code: PipelineWarningCode::PromptContextTrimmed,
            layer: LAYER_NAME.to_string(),
            message: format!(
                "Conversation context auto-compacted to {} chars (kept {} of {} chars; summarized {} turn(s)).",
                budget.max_history_chars,
                conversation.emitted_chars,
                conversation.source_chars,
                conversation.summarized_turns
            ),
        });
    }

    PlainPromptBuild { prompt, warnings }
}

fn enforce_prompt_budget(
    prompt: String,
    budget: &PromptBudget,
    warnings: &mut Vec<PipelineWarning>,
) -> String {
    let prompt_chars = prompt.chars().count();
    if prompt_chars <= budget.max_prompt_chars {
        return prompt;
    }

    let trimmed: String = prompt.chars().take(budget.max_prompt_chars).collect();
    warnings.push(PipelineWarning {
        code: PipelineWarningCode::PromptTokenBudgetApplied,
        layer: LAYER_NAME.to_string(),
        message: format!(
            "Prompt length exceeded budget ({} chars). Trimmed from {} to {} chars.",
            budget.max_prompt_chars, prompt_chars, budget.max_prompt_chars
        ),
    });
    trimmed
}

fn build_context(chunks: &[KnowledgeSearchResult], max_context_chars: usize) -> KnowledgeContextBuild {
    if chunks.is_empty() || max_context_chars == 0 {
        return KnowledgeContextBuild::default();
    }

    let mut remaining = max_context_chars;
    let mut blocks = Vec::new();
    let source_chars = chunks
        .iter()
        .map(|hit| hit.content.chars().count())
        .sum::<usize>();
    for (index, hit) in chunks.iter().enumerate() {
        if remaining == 0 {
            break;
        }
        let header = format!("[{}] {} (score {:.3})\n", index + 1, hit.file_name, hit.score);
        let header_chars = header.chars().count();
        if header_chars >= remaining {
            break;
        }
        let available_for_content = remaining - header_chars;
        let content: String = hit.content.chars().take(available_for_content).collect();
        if content.is_empty() {
            break;
        }
        let block = format!("{}{}", header, content);
        let block_chars = block.chars().count();
        blocks.push(block);
        remaining = remaining.saturating_sub(block_chars);
        if remaining <= 2 {
            break;
        }
        remaining = remaining.saturating_sub(2); // \n\n between blocks
    }

    let context = blocks.join("\n\n");
    let emitted_chars = context.chars().count();
    KnowledgeContextBuild {
        context,
        source_chars,
        emitted_chars,
    }
}

fn minimal_template(user_prompt: &str) -> String {
    let normalized = user_prompt.trim();
    if normalized.is_empty() {
        return "User Question:".to_string();
    }

    [
        "Use the following knowledge context when it is relevant to the user question.",
        "If context is insufficient or unrelated, clearly say so and continue with best-effort reasoning.",
        "",
        &format!("User Question: {}", normalized),
    ]
    .join("\n")
}

#[cfg(test)]
mod tests {
    use super::{build_context, build_plain_prompt, DEFAULT_MAX_CONTEXT_CHARS};
    use crate::models::KnowledgeSearchResult;

    #[test]
    fn empty_context_uses_raw_user_prompt() {
        let prompt = build_plain_prompt("How do I deploy this app?", "", "");
        assert_eq!(prompt, "How do I deploy this app?");
    }

    #[test]
    fn empty_user_prompt_still_uses_minimal_template() {
        let prompt = build_plain_prompt("", "", "");
        assert!(prompt.contains("User Question:"));
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

        let knowledge = build_context(&chunks, DEFAULT_MAX_CONTEXT_CHARS);
        let prompt = build_plain_prompt("How to deploy?", "", &knowledge.context);
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
