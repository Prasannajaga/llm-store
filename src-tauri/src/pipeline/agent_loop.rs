use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use chrono::{SecondsFormat, Utc};
use reqwest::header::AUTHORIZATION;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::SqlitePool;
use tauri::{AppHandle, Emitter};
use tokio::process::Command;
use tokio::time::sleep;
use uuid::Uuid;

use crate::commands::streaming::GenerationState;
use crate::events::AGENT_TOOL_CONFIRMATION_REQUIRED;
use crate::models::KnowledgeSearchResult;
use crate::storage;

use super::types::{
    AgentRunSummary, AgentToolConfirmationRequiredEvent, AgentToolRiskLevel, LayerOutcome,
    PipelineWarning, PipelineWarningCode,
};

pub const LAYER_NAME: &str = "agent_loop";
const MAX_TOOL_STEPS: usize = 8;
const MAX_WALL_CLOCK: Duration = Duration::from_secs(120);
const TOOL_CONFIRMATION_TIMEOUT: Duration = Duration::from_secs(45);
const TOOL_OUTPUT_CHAR_CAP: usize = 8 * 1024;
const PROMPT_APPEND_CHAR_CAP: usize = 10 * 1024;
const PLANNER_MAX_TOKENS: u32 = 320;
const TOOL_COMMAND_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, Clone)]
pub struct AgentLoopOutput {
    pub final_prompt: String,
    pub summary: AgentRunSummary,
}

pub async fn run(
    app: &AppHandle,
    pool: &SqlitePool,
    cancellation_flag: Arc<AtomicBool>,
    generation_state: &GenerationState,
    request_id: &str,
    user_prompt: &str,
    base_prompt: &str,
    retrieved_chunks: &[KnowledgeSearchResult],
    selected_doc_ids: Option<&Vec<String>>,
) -> LayerOutcome<AgentLoopOutput> {
    tracing::info!(
        target: "state_logger",
        module = "pipeline",
        event = "agent_loop_started",
        request_id = %request_id,
        max_tool_steps = MAX_TOOL_STEPS,
        max_wall_clock_seconds = MAX_WALL_CLOCK.as_secs(),
        retrieved_chunk_count = retrieved_chunks.len(),
        selected_doc_count = selected_doc_ids.map_or(0, |ids| ids.len()),
        "Agent loop started"
    );

    let started = Instant::now();
    let mut warnings = Vec::new();
    let mut observations: Vec<String> = Vec::new();
    let mut planner_hint: Option<String> = None;
    let mut timed_out = false;
    let mut tool_calls_total = 0usize;
    let mut approvals_required = 0usize;
    let mut approvals_denied = 0usize;

    let settings = match load_settings_map(pool).await {
        Ok(map) => map,
        Err(err) => {
            warnings.push(PipelineWarning {
                code: PipelineWarningCode::AgentPlannerFallback,
                layer: LAYER_NAME.to_string(),
                message: format!(
                    "Agent loop could not load runtime settings. Continuing without tools. ({})",
                    err
                ),
            });
            return LayerOutcome::fallback(
                AgentLoopOutput {
                    final_prompt: base_prompt.to_string(),
                    summary: AgentRunSummary {
                        tool_calls_total,
                        approvals_required,
                        approvals_denied,
                        timed_out,
                    },
                },
                warnings,
                started.elapsed().as_millis() as u64,
            );
        }
    };
    let planner_config = PlannerConfig::from_settings(&settings);

    for step in 0..MAX_TOOL_STEPS {
        if cancellation_flag.load(Ordering::SeqCst) {
            tracing::info!(
                target: "state_logger",
                module = "pipeline",
                event = "agent_loop_cancelled",
                request_id = %request_id,
                step = step + 1,
                "Agent loop cancelled before planner step"
            );
            break;
        }
        if started.elapsed() >= MAX_WALL_CLOCK {
            timed_out = true;
            warnings.push(PipelineWarning {
                code: PipelineWarningCode::AgentToolTimedOut,
                layer: LAYER_NAME.to_string(),
                message: "Agent run reached the 120-second budget and was stopped".to_string(),
            });
            break;
        }

        let planner_prompt = build_planner_prompt(user_prompt, retrieved_chunks, &observations);
        tracing::info!(
            target: "state_logger",
            module = "pipeline",
            event = "agent_planner_invoking",
            request_id = %request_id,
            step = step + 1,
            planner_prompt_chars = planner_prompt.chars().count(),
            "Invoking planner for agent step"
        );
        let planner_raw = match call_planner(&planner_config, &planner_prompt).await {
            Ok(text) => text,
            Err(err) => {
                warnings.push(PipelineWarning {
                    code: PipelineWarningCode::AgentPlannerFallback,
                    layer: LAYER_NAME.to_string(),
                    message: format!(
                        "Planner request failed at step {}. Continuing to final response. ({})",
                        step + 1,
                        err
                    ),
                });
                break;
            }
        };

        match parse_planner_decision(&planner_raw) {
            PlannerDecision::Finish { final_answer } => {
                tracing::info!(
                    target: "state_logger",
                    module = "pipeline",
                    event = "agent_planner_finish",
                    request_id = %request_id,
                    step = step + 1,
                    final_answer_chars = final_answer.chars().count(),
                    "Planner signaled completion"
                );
                planner_hint = Some(final_answer);
                break;
            }
            PlannerDecision::Tool(tool_call) => {
                tracing::info!(
                    target: "state_logger",
                    module = "pipeline",
                    event = "agent_tool_selected",
                    request_id = %request_id,
                    step = step + 1,
                    tool = %tool_call.tool,
                    has_summary = tool_call.summary.is_some(),
                    "Planner selected tool call"
                );
                let execution = execute_tool_call(
                    app,
                    pool,
                    generation_state,
                    cancellation_flag.clone(),
                    request_id,
                    selected_doc_ids,
                    &tool_call,
                )
                .await;

                tool_calls_total += 1;
                if execution.approval_requested {
                    approvals_required += 1;
                }
                if execution.denied {
                    approvals_denied += 1;
                }
                if execution.timed_out {
                    timed_out = true;
                }
                if let Some(warning) = execution.warning {
                    warnings.push(warning);
                }
                tracing::info!(
                    target: "state_logger",
                    module = "pipeline",
                    event = "agent_tool_completed",
                    request_id = %request_id,
                    step = step + 1,
                    tool = %tool_call.tool,
                    approval_requested = execution.approval_requested,
                    denied = execution.denied,
                    timed_out = execution.timed_out,
                    output_chars = execution.output_excerpt.chars().count(),
                    "Agent tool execution completed"
                );
                observations.push(format!(
                    "Step {} | {} | {}\n{}",
                    step + 1,
                    tool_call.tool,
                    execution.summary,
                    execution.output_excerpt
                ));
            }
            PlannerDecision::Invalid(raw) => {
                tracing::warn!(
                    target: "state_logger",
                    module = "pipeline",
                    event = "agent_planner_invalid_output",
                    request_id = %request_id,
                    step = step + 1,
                    raw_chars = raw.chars().count(),
                    "Planner output was not valid decision JSON"
                );
                warnings.push(PipelineWarning {
                    code: PipelineWarningCode::AgentPlannerFallback,
                    layer: LAYER_NAME.to_string(),
                    message: "Planner output could not be parsed as tool/finish JSON. Using fallback."
                        .to_string(),
                });
                if !raw.trim().is_empty() {
                    planner_hint = Some(raw);
                }
                break;
            }
        }
    }

    let mut final_prompt = base_prompt.to_string();
    let agent_appendix = build_agent_prompt_appendix(&observations, planner_hint.as_deref(), timed_out);
    if !agent_appendix.is_empty() {
        final_prompt.push_str("\n\n");
        final_prompt.push_str(&agent_appendix);
    }

    let elapsed = started.elapsed().as_millis() as u64;
    let output = AgentLoopOutput {
        final_prompt,
        summary: AgentRunSummary {
            tool_calls_total,
            approvals_required,
            approvals_denied,
            timed_out,
        },
    };
    tracing::info!(
        target: "state_logger",
        module = "pipeline",
        event = "agent_loop_completed",
        request_id = %request_id,
        elapsed_ms = elapsed,
        tool_calls_total = output.summary.tool_calls_total,
        approvals_required = output.summary.approvals_required,
        approvals_denied = output.summary.approvals_denied,
        timed_out = output.summary.timed_out,
        warning_count = warnings.len(),
        "Agent loop completed"
    );
    if warnings.is_empty() {
        LayerOutcome::success(output, elapsed)
    } else {
        LayerOutcome::fallback(output, warnings, elapsed)
    }
}

#[derive(Debug, Clone)]
struct ToolExecutionResult {
    summary: String,
    output_excerpt: String,
    warning: Option<PipelineWarning>,
    approval_requested: bool,
    denied: bool,
    timed_out: bool,
}

#[derive(Debug, Clone)]
struct ToolCall {
    tool: String,
    args: Value,
    summary: Option<String>,
}

#[derive(Debug, Clone)]
enum PlannerDecision {
    Finish { final_answer: String },
    Tool(ToolCall),
    Invalid(String),
}

#[derive(Debug, Deserialize)]
struct RawPlannerDecision {
    action: String,
    tool: Option<String>,
    args: Option<Value>,
    summary: Option<String>,
    final_answer: Option<String>,
}

#[derive(Debug, Clone)]
struct PlannerConfig {
    endpoint_url: String,
    authorization_header: Option<String>,
    max_tokens: u32,
    temperature: f32,
    top_p: f32,
    top_k: u32,
    repeat_penalty: f32,
}

impl PlannerConfig {
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
            .unwrap_or(512)
            .min(PLANNER_MAX_TOKENS);
        let temperature = settings
            .get("generation.temperature")
            .and_then(|value| value.parse::<f32>().ok())
            .unwrap_or(0.5);
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

        Self {
            endpoint_url,
            authorization_header,
            max_tokens,
            temperature,
            top_p,
            top_k,
            repeat_penalty,
        }
    }
}

async fn execute_tool_call(
    app: &AppHandle,
    pool: &SqlitePool,
    generation_state: &GenerationState,
    cancellation_flag: Arc<AtomicBool>,
    request_id: &str,
    selected_doc_ids: Option<&Vec<String>>,
    tool_call: &ToolCall,
) -> ToolExecutionResult {
    let tool = tool_call.tool.trim();
    tracing::info!(
        target: "state_logger",
        module = "pipeline",
        event = "agent_tool_execution_started",
        request_id = %request_id,
        tool = %tool,
        "Executing agent tool"
    );
    match tool {
        "knowledge.search" => {
            let query = read_required_string_arg(&tool_call.args, "query");
            let limit = read_optional_u64_arg(&tool_call.args, "limit").unwrap_or(4) as usize;
            if let Some(query_text) = query {
                match execute_knowledge_search(pool, &query_text, selected_doc_ids, limit).await {
                    Ok(output) => ToolExecutionResult {
                        summary: tool_call
                            .summary
                            .clone()
                            .unwrap_or_else(|| "Knowledge search completed".to_string()),
                        output_excerpt: output,
                        warning: None,
                        approval_requested: false,
                        denied: false,
                        timed_out: false,
                    },
                    Err(err) => ToolExecutionResult {
                        summary: "Knowledge search failed".to_string(),
                        output_excerpt: clip_chars(&err, TOOL_OUTPUT_CHAR_CAP),
                        warning: Some(PipelineWarning {
                            code: PipelineWarningCode::AgentToolFailed,
                            layer: LAYER_NAME.to_string(),
                            message: format!("knowledge.search failed: {}", err),
                        }),
                        approval_requested: false,
                        denied: false,
                        timed_out: false,
                    },
                }
            } else {
                ToolExecutionResult {
                    summary: "Knowledge search skipped".to_string(),
                    output_excerpt: "Missing required argument: query".to_string(),
                    warning: Some(PipelineWarning {
                        code: PipelineWarningCode::AgentToolFailed,
                        layer: LAYER_NAME.to_string(),
                        message: "knowledge.search missing required query argument".to_string(),
                    }),
                    approval_requested: false,
                    denied: false,
                    timed_out: false,
                }
            }
        }
        "shell.exec" => {
            let command = read_required_string_arg(&tool_call.args, "command");
            let Some(command_text) = command else {
                return ToolExecutionResult {
                    summary: "Shell command skipped".to_string(),
                    output_excerpt: "Missing required argument: command".to_string(),
                    warning: Some(PipelineWarning {
                        code: PipelineWarningCode::AgentToolFailed,
                        layer: LAYER_NAME.to_string(),
                        message: "shell.exec missing required command argument".to_string(),
                    }),
                    approval_requested: false,
                    denied: false,
                    timed_out: false,
                };
            };

            let needs_confirmation = !is_allowlisted_shell_command(&command_text);
            let mut approval_requested = false;
            if needs_confirmation {
                approval_requested = true;
                let confirmation = request_confirmation(
                    app,
                    generation_state,
                    cancellation_flag,
                    request_id,
                    "shell.exec",
                    &format!("Run shell command: {}", command_text),
                    &command_text,
                    AgentToolRiskLevel::High,
                )
                .await;
                match confirmation {
                    ConfirmationDecision::Denied => {
                        return ToolExecutionResult {
                            summary: "Shell command denied".to_string(),
                            output_excerpt: "User denied command execution.".to_string(),
                            warning: Some(PipelineWarning {
                                code: PipelineWarningCode::AgentToolDenied,
                                layer: LAYER_NAME.to_string(),
                                message: format!("shell.exec denied for command '{}'", command_text),
                            }),
                            approval_requested,
                            denied: true,
                            timed_out: false,
                        };
                    }
                    ConfirmationDecision::TimedOut => {
                        return ToolExecutionResult {
                            summary: "Shell command timed out".to_string(),
                            output_excerpt: "Approval timed out. Command was not run.".to_string(),
                            warning: Some(PipelineWarning {
                                code: PipelineWarningCode::AgentToolTimedOut,
                                layer: LAYER_NAME.to_string(),
                                message: format!(
                                    "shell.exec approval timed out for command '{}'",
                                    command_text
                                ),
                            }),
                            approval_requested,
                            denied: true,
                            timed_out: true,
                        };
                    }
                    ConfirmationDecision::Approved => {}
                }
            }

            match execute_shell_command(&command_text).await {
                Ok(output) => ToolExecutionResult {
                    summary: tool_call
                        .summary
                        .clone()
                        .unwrap_or_else(|| "Shell command completed".to_string()),
                    output_excerpt: output,
                    warning: None,
                    approval_requested,
                    denied: false,
                    timed_out: false,
                },
                Err(err) => ToolExecutionResult {
                    summary: "Shell command failed".to_string(),
                    output_excerpt: clip_chars(&err, TOOL_OUTPUT_CHAR_CAP),
                    warning: Some(PipelineWarning {
                        code: PipelineWarningCode::AgentToolFailed,
                        layer: LAYER_NAME.to_string(),
                        message: format!("shell.exec failed: {}", err),
                    }),
                    approval_requested,
                    denied: false,
                    timed_out: false,
                },
            }
        }
        "fs.read" => {
            let path = read_required_string_arg(&tool_call.args, "path");
            let Some(path_text) = path else {
                return ToolExecutionResult {
                    summary: "File read skipped".to_string(),
                    output_excerpt: "Missing required argument: path".to_string(),
                    warning: Some(PipelineWarning {
                        code: PipelineWarningCode::AgentToolFailed,
                        layer: LAYER_NAME.to_string(),
                        message: "fs.read missing required path argument".to_string(),
                    }),
                    approval_requested: false,
                    denied: false,
                    timed_out: false,
                };
            };
            match tokio::fs::read_to_string(&path_text).await {
                Ok(content) => ToolExecutionResult {
                    summary: tool_call
                        .summary
                        .clone()
                        .unwrap_or_else(|| format!("Read file {}", path_text)),
                    output_excerpt: clip_chars(&content, TOOL_OUTPUT_CHAR_CAP),
                    warning: None,
                    approval_requested: false,
                    denied: false,
                    timed_out: false,
                },
                Err(err) => ToolExecutionResult {
                    summary: "File read failed".to_string(),
                    output_excerpt: clip_chars(&err.to_string(), TOOL_OUTPUT_CHAR_CAP),
                    warning: Some(PipelineWarning {
                        code: PipelineWarningCode::AgentToolFailed,
                        layer: LAYER_NAME.to_string(),
                        message: format!("fs.read failed for '{}': {}", path_text, err),
                    }),
                    approval_requested: false,
                    denied: false,
                    timed_out: false,
                },
            }
        }
        "fs.list" => {
            let path = read_optional_string_arg(&tool_call.args, "path").unwrap_or_else(|| ".".to_string());
            match list_directory(&path).await {
                Ok(content) => ToolExecutionResult {
                    summary: tool_call
                        .summary
                        .clone()
                        .unwrap_or_else(|| format!("Listed directory {}", path)),
                    output_excerpt: content,
                    warning: None,
                    approval_requested: false,
                    denied: false,
                    timed_out: false,
                },
                Err(err) => ToolExecutionResult {
                    summary: "Directory listing failed".to_string(),
                    output_excerpt: clip_chars(&err, TOOL_OUTPUT_CHAR_CAP),
                    warning: Some(PipelineWarning {
                        code: PipelineWarningCode::AgentToolFailed,
                        layer: LAYER_NAME.to_string(),
                        message: format!("fs.list failed for '{}': {}", path, err),
                    }),
                    approval_requested: false,
                    denied: false,
                    timed_out: false,
                },
            }
        }
        "fs.write" => {
            let path = read_required_string_arg(&tool_call.args, "path");
            let content = read_required_string_arg(&tool_call.args, "content");
            let append = read_optional_bool_arg(&tool_call.args, "append").unwrap_or(false);

            let (Some(path_text), Some(content_text)) = (path, content) else {
                return ToolExecutionResult {
                    summary: "File write skipped".to_string(),
                    output_excerpt: "Missing required args: path/content".to_string(),
                    warning: Some(PipelineWarning {
                        code: PipelineWarningCode::AgentToolFailed,
                        layer: LAYER_NAME.to_string(),
                        message: "fs.write missing required path/content argument".to_string(),
                    }),
                    approval_requested: false,
                    denied: false,
                    timed_out: false,
                };
            };

            let confirmation = request_confirmation(
                app,
                generation_state,
                cancellation_flag,
                request_id,
                "fs.write",
                &format!("Write file: {}", path_text),
                &clip_chars(&content_text, 300),
                AgentToolRiskLevel::Confirm,
            )
            .await;
            match confirmation {
                ConfirmationDecision::Denied => {
                    return ToolExecutionResult {
                        summary: "File write denied".to_string(),
                        output_excerpt: "User denied file write.".to_string(),
                        warning: Some(PipelineWarning {
                            code: PipelineWarningCode::AgentToolDenied,
                            layer: LAYER_NAME.to_string(),
                            message: format!("fs.write denied for '{}'", path_text),
                        }),
                        approval_requested: true,
                        denied: true,
                        timed_out: false,
                    };
                }
                ConfirmationDecision::TimedOut => {
                    return ToolExecutionResult {
                        summary: "File write timed out".to_string(),
                        output_excerpt: "Approval timed out. File was not written.".to_string(),
                        warning: Some(PipelineWarning {
                            code: PipelineWarningCode::AgentToolTimedOut,
                            layer: LAYER_NAME.to_string(),
                            message: format!("fs.write approval timed out for '{}'", path_text),
                        }),
                        approval_requested: true,
                        denied: true,
                        timed_out: true,
                    };
                }
                ConfirmationDecision::Approved => {}
            }

            let write_result = if append {
                append_to_file(&path_text, &content_text).await
            } else {
                tokio::fs::write(&path_text, content_text.as_bytes())
                    .await
                    .map_err(|err| err.to_string())
            };
            match write_result {
                Ok(()) => ToolExecutionResult {
                    summary: tool_call
                        .summary
                        .clone()
                        .unwrap_or_else(|| format!("Wrote file {}", path_text)),
                    output_excerpt: "Write successful.".to_string(),
                    warning: None,
                    approval_requested: true,
                    denied: false,
                    timed_out: false,
                },
                Err(err) => ToolExecutionResult {
                    summary: "File write failed".to_string(),
                    output_excerpt: clip_chars(&err, TOOL_OUTPUT_CHAR_CAP),
                    warning: Some(PipelineWarning {
                        code: PipelineWarningCode::AgentToolFailed,
                        layer: LAYER_NAME.to_string(),
                        message: format!("fs.write failed for '{}': {}", path_text, err),
                    }),
                    approval_requested: true,
                    denied: false,
                    timed_out: false,
                },
            }
        }
        "fs.delete" => {
            let path = read_required_string_arg(&tool_call.args, "path");
            let recursive = read_optional_bool_arg(&tool_call.args, "recursive").unwrap_or(false);

            let Some(path_text) = path else {
                return ToolExecutionResult {
                    summary: "File delete skipped".to_string(),
                    output_excerpt: "Missing required argument: path".to_string(),
                    warning: Some(PipelineWarning {
                        code: PipelineWarningCode::AgentToolFailed,
                        layer: LAYER_NAME.to_string(),
                        message: "fs.delete missing required path argument".to_string(),
                    }),
                    approval_requested: false,
                    denied: false,
                    timed_out: false,
                };
            };

            let confirmation = request_confirmation(
                app,
                generation_state,
                cancellation_flag,
                request_id,
                "fs.delete",
                &format!("Delete path: {}", path_text),
                &format!("recursive={}", recursive),
                AgentToolRiskLevel::High,
            )
            .await;
            match confirmation {
                ConfirmationDecision::Denied => {
                    return ToolExecutionResult {
                        summary: "Delete denied".to_string(),
                        output_excerpt: "User denied deletion.".to_string(),
                        warning: Some(PipelineWarning {
                            code: PipelineWarningCode::AgentToolDenied,
                            layer: LAYER_NAME.to_string(),
                            message: format!("fs.delete denied for '{}'", path_text),
                        }),
                        approval_requested: true,
                        denied: true,
                        timed_out: false,
                    };
                }
                ConfirmationDecision::TimedOut => {
                    return ToolExecutionResult {
                        summary: "Delete timed out".to_string(),
                        output_excerpt: "Approval timed out. Path was not deleted.".to_string(),
                        warning: Some(PipelineWarning {
                            code: PipelineWarningCode::AgentToolTimedOut,
                            layer: LAYER_NAME.to_string(),
                            message: format!("fs.delete approval timed out for '{}'", path_text),
                        }),
                        approval_requested: true,
                        denied: true,
                        timed_out: true,
                    };
                }
                ConfirmationDecision::Approved => {}
            }

            let delete_result = remove_path(&path_text, recursive).await;
            match delete_result {
                Ok(()) => ToolExecutionResult {
                    summary: tool_call
                        .summary
                        .clone()
                        .unwrap_or_else(|| format!("Deleted {}", path_text)),
                    output_excerpt: "Delete successful.".to_string(),
                    warning: None,
                    approval_requested: true,
                    denied: false,
                    timed_out: false,
                },
                Err(err) => ToolExecutionResult {
                    summary: "Delete failed".to_string(),
                    output_excerpt: clip_chars(&err, TOOL_OUTPUT_CHAR_CAP),
                    warning: Some(PipelineWarning {
                        code: PipelineWarningCode::AgentToolFailed,
                        layer: LAYER_NAME.to_string(),
                        message: format!("fs.delete failed for '{}': {}", path_text, err),
                    }),
                    approval_requested: true,
                    denied: false,
                    timed_out: false,
                },
            }
        }
        _ => ToolExecutionResult {
            summary: "Unknown tool".to_string(),
            output_excerpt: format!("Tool '{}' is not supported in this build.", tool),
            warning: Some(PipelineWarning {
                code: PipelineWarningCode::AgentToolFailed,
                layer: LAYER_NAME.to_string(),
                message: format!("Unsupported tool requested: {}", tool),
            }),
            approval_requested: false,
            denied: false,
            timed_out: false,
        },
    }
}

async fn execute_knowledge_search(
    pool: &SqlitePool,
    query: &str,
    selected_doc_ids: Option<&Vec<String>>,
    limit: usize,
) -> Result<String, String> {
    let normalized_limit = limit.clamp(1, 8);
    let hits = storage::search_knowledge_chunks_fts(pool, query, selected_doc_ids.map(|v| v.as_slice()), normalized_limit)
        .await
        .map_err(|err| err.to_string())?;
    if hits.is_empty() {
        return Ok("No matching knowledge chunks found.".to_string());
    }

    let mut lines = Vec::new();
    for (idx, hit) in hits.iter().enumerate() {
        lines.push(format!(
            "[{}] {}#{} | {}",
            idx + 1,
            hit.file_name,
            hit.chunk_index,
            clip_chars(&hit.content, 220)
        ));
    }
    Ok(clip_chars(&lines.join("\n"), TOOL_OUTPUT_CHAR_CAP))
}

async fn execute_shell_command(command: &str) -> Result<String, String> {
    let output = tokio::time::timeout(
        TOOL_COMMAND_TIMEOUT,
        Command::new("bash").arg("-lc").arg(command).output(),
    )
    .await
    .map_err(|_| "Command timed out".to_string())?
    .map_err(|err| err.to_string())?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let merged = if stderr.trim().is_empty() {
        stdout.to_string()
    } else if stdout.trim().is_empty() {
        format!("STDERR:\n{}", stderr)
    } else {
        format!("STDOUT:\n{}\n\nSTDERR:\n{}", stdout, stderr)
    };
    Ok(clip_chars(&merged, TOOL_OUTPUT_CHAR_CAP))
}

async fn list_directory(path: &str) -> Result<String, String> {
    let mut entries = tokio::fs::read_dir(path).await.map_err(|err| err.to_string())?;
    let mut lines: Vec<String> = Vec::new();
    while let Some(entry) = entries.next_entry().await.map_err(|err| err.to_string())? {
        let file_type = entry.file_type().await.map_err(|err| err.to_string())?;
        let kind = if file_type.is_dir() {
            "dir"
        } else if file_type.is_file() {
            "file"
        } else {
            "other"
        };
        let name = entry.file_name();
        lines.push(format!("{}  {}", kind, name.to_string_lossy()));
        if lines.len() >= 200 {
            lines.push("... truncated".to_string());
            break;
        }
    }
    if lines.is_empty() {
        return Ok("Directory is empty.".to_string());
    }
    Ok(clip_chars(&lines.join("\n"), TOOL_OUTPUT_CHAR_CAP))
}

async fn append_to_file(path: &str, content: &str) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;

    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .await
        .map_err(|err| err.to_string())?;
    file.write_all(content.as_bytes())
        .await
        .map_err(|err| err.to_string())?;
    Ok(())
}

async fn remove_path(path: &str, recursive: bool) -> Result<(), String> {
    let metadata = tokio::fs::metadata(path).await.map_err(|err| err.to_string())?;
    if metadata.is_dir() {
        if recursive {
            tokio::fs::remove_dir_all(path)
                .await
                .map_err(|err| err.to_string())
        } else {
            tokio::fs::remove_dir(path).await.map_err(|err| err.to_string())
        }
    } else {
        tokio::fs::remove_file(path).await.map_err(|err| err.to_string())
    }
}

#[derive(Debug, Clone, Copy)]
enum ConfirmationDecision {
    Approved,
    Denied,
    TimedOut,
}

async fn request_confirmation(
    app: &AppHandle,
    generation_state: &GenerationState,
    cancellation_flag: Arc<AtomicBool>,
    request_id: &str,
    tool: &str,
    summary: &str,
    args_preview: &str,
    risk_level: AgentToolRiskLevel,
) -> ConfirmationDecision {
    let action_id = Uuid::new_v4().to_string();
    let expires_at = (Utc::now() + chrono::Duration::seconds(TOOL_CONFIRMATION_TIMEOUT.as_secs() as i64))
        .to_rfc3339_opts(SecondsFormat::Secs, true);
    let event = AgentToolConfirmationRequiredEvent {
        request_id: request_id.to_string(),
        action_id: action_id.clone(),
        tool: tool.to_string(),
        summary: summary.to_string(),
        args_preview: clip_chars(args_preview, 600),
        risk_level,
        expires_at,
    };
    if let Err(err) = app.emit(AGENT_TOOL_CONFIRMATION_REQUIRED, event) {
        tracing::warn!(
            request_id = %request_id,
            tool = %tool,
            "Failed to emit agent tool confirmation event: {}",
            err
        );
        return ConfirmationDecision::Denied;
    }
    tracing::info!(
        target: "state_logger",
        module = "pipeline",
        event = "agent_tool_confirmation_requested",
        request_id = %request_id,
        action_id = %action_id,
        tool = %tool,
        timeout_seconds = TOOL_CONFIRMATION_TIMEOUT.as_secs(),
        "Agent tool confirmation requested"
    );

    let started = Instant::now();
    loop {
        if cancellation_flag.load(Ordering::SeqCst) {
            return ConfirmationDecision::Denied;
        }
        if let Some(approved) = generation_state.take_agent_decision(request_id, &action_id).await {
            if approved {
                tracing::info!(
                    target: "state_logger",
                    module = "pipeline",
                    event = "agent_tool_confirmation_approved",
                    request_id = %request_id,
                    action_id = %action_id,
                    tool = %tool,
                    "Agent tool confirmation approved"
                );
                return ConfirmationDecision::Approved;
            }
            tracing::info!(
                target: "state_logger",
                module = "pipeline",
                event = "agent_tool_confirmation_denied",
                request_id = %request_id,
                action_id = %action_id,
                tool = %tool,
                "Agent tool confirmation denied"
            );
            return ConfirmationDecision::Denied;
        }
        if started.elapsed() >= TOOL_CONFIRMATION_TIMEOUT {
            tracing::warn!(
                target: "state_logger",
                module = "pipeline",
                event = "agent_tool_confirmation_timed_out",
                request_id = %request_id,
                action_id = %action_id,
                tool = %tool,
                timeout_seconds = TOOL_CONFIRMATION_TIMEOUT.as_secs(),
                "Agent tool confirmation timed out"
            );
            return ConfirmationDecision::TimedOut;
        }
        sleep(Duration::from_millis(160)).await;
    }
}

async fn call_planner(config: &PlannerConfig, prompt: &str) -> Result<String, String> {
    let body = json!({
        "prompt": prompt,
        "stream": false,
        "n_predict": config.max_tokens,
        "temperature": config.temperature,
        "top_p": config.top_p,
        "top_k": config.top_k,
        "repeat_penalty": config.repeat_penalty,
    });

    let client = reqwest::Client::new();
    let mut request = client.post(&config.endpoint_url).json(&body);
    if let Some(auth_header) = &config.authorization_header {
        request = request.header(AUTHORIZATION, auth_header);
    }

    let response = request.send().await.map_err(|err| err.to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "Planner endpoint '{}' returned HTTP {} {}",
            config.endpoint_url,
            response.status().as_u16(),
            response.status()
        ));
    }

    let payload = response.json::<Value>().await.map_err(|err| err.to_string())?;
    Ok(extract_text_from_completion_response(&payload))
}

fn build_planner_prompt(
    user_prompt: &str,
    retrieved_chunks: &[KnowledgeSearchResult],
    observations: &[String],
) -> String {
    let mut sections = vec![
        "You are an execution planner for a local assistant agent.".to_string(),
        "Return ONLY JSON.".to_string(),
        "Valid JSON outputs:".to_string(),
        r#"{"action":"finish","final_answer":"<brief planning summary>"}"#.to_string(),
        r#"{"action":"tool","tool":"knowledge.search|shell.exec|fs.read|fs.write|fs.delete|fs.list","summary":"<why this step>","args":{...}}"#.to_string(),
        "If enough evidence exists, choose action=finish.".to_string(),
        format!("User request:\n{}", user_prompt.trim()),
    ];

    if !retrieved_chunks.is_empty() {
        let previews = retrieved_chunks
            .iter()
            .take(4)
            .enumerate()
            .map(|(idx, chunk)| {
                format!(
                    "[{}] {} | {}",
                    idx + 1,
                    chunk.file_name,
                    clip_chars(&chunk.content, 180)
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        sections.push(format!("Knowledge hints:\n{}", previews));
    }

    if !observations.is_empty() {
        let history = observations
            .iter()
            .enumerate()
            .map(|(idx, item)| format!("{}. {}", idx + 1, item))
            .collect::<Vec<_>>()
            .join("\n\n");
        sections.push(format!("Previous tool observations:\n{}", clip_chars(&history, 3_000)));
    }

    sections.push(
        "For shell.exec, always provide args.command. For fs.write provide args.path and args.content."
            .to_string(),
    );
    sections.join("\n\n")
}

fn parse_planner_decision(raw: &str) -> PlannerDecision {
    let candidate = extract_json_candidate(raw).unwrap_or_else(|| raw.trim().to_string());
    if let Ok(parsed) = serde_json::from_str::<RawPlannerDecision>(&candidate) {
        let action = parsed.action.trim().to_ascii_lowercase();
        if action == "finish" {
            let final_answer = parsed
                .final_answer
                .or(parsed.summary)
                .unwrap_or_else(|| "Agent collected enough information.".to_string());
            return PlannerDecision::Finish { final_answer };
        }
        if action == "tool" {
            if let Some(tool) = parsed.tool {
                return PlannerDecision::Tool(ToolCall {
                    tool,
                    args: parsed.args.unwrap_or_else(|| json!({})),
                    summary: parsed.summary,
                });
            }
        }
    }
    PlannerDecision::Invalid(raw.trim().to_string())
}

fn extract_json_candidate(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.starts_with('{') && trimmed.ends_with('}') {
        return Some(trimmed.to_string());
    }
    if let Some(start_idx) = trimmed.find("```") {
        let rest = &trimmed[start_idx + 3..];
        let fenced = if let Some(newline_idx) = rest.find('\n') {
            &rest[newline_idx + 1..]
        } else {
            rest
        };
        if let Some(end_idx) = fenced.find("```") {
            let candidate = fenced[..end_idx].trim();
            if candidate.starts_with('{') && candidate.ends_with('}') {
                return Some(candidate.to_string());
            }
        }
    }
    let start = trimmed.find('{')?;
    let end = trimmed.rfind('}')?;
    if start < end {
        return Some(trimmed[start..=end].trim().to_string());
    }
    None
}

fn extract_text_from_completion_response(payload: &Value) -> String {
    if let Some(content) = payload.get("content").and_then(Value::as_str) {
        return content.to_string();
    }
    if let Some(content) = payload
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("text"))
        .and_then(Value::as_str)
    {
        return content.to_string();
    }
    if let Some(content) = payload
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(Value::as_str)
    {
        return content.to_string();
    }
    if let Some(content) = payload.as_str() {
        return content.to_string();
    }
    payload.to_string()
}

fn build_agent_prompt_appendix(
    observations: &[String],
    planner_hint: Option<&str>,
    timed_out: bool,
) -> String {
    let mut sections = Vec::new();
    if !observations.is_empty() {
        let observations_text = observations.join("\n\n");
        sections.push(format!(
            "Agent Tool Findings:\n{}",
            clip_chars(&observations_text, PROMPT_APPEND_CHAR_CAP)
        ));
    }
    if let Some(hint) = planner_hint {
        let normalized = hint.trim();
        if !normalized.is_empty() {
            sections.push(format!(
                "Agent Planning Hint:\n{}",
                clip_chars(normalized, 1_600)
            ));
        }
    }
    if timed_out {
        sections.push(
            "Agent execution budget was reached before completing all intended tool steps."
                .to_string(),
        );
    }

    sections.join("\n\n")
}

fn read_required_string_arg(args: &Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn read_optional_string_arg(args: &Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn read_optional_u64_arg(args: &Value, key: &str) -> Option<u64> {
    args.get(key).and_then(Value::as_u64)
}

fn read_optional_bool_arg(args: &Value, key: &str) -> Option<bool> {
    args.get(key).and_then(Value::as_bool)
}

fn is_allowlisted_shell_command(command: &str) -> bool {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return false;
    }
    if trimmed.contains(';')
        || trimmed.contains("&&")
        || trimmed.contains("||")
        || trimmed.contains('|')
        || trimmed.contains('>')
        || trimmed.contains('<')
        || trimmed.contains('`')
        || trimmed.contains('$')
    {
        return false;
    }

    let tokens = trimmed.split_whitespace().collect::<Vec<_>>();
    if tokens.is_empty() {
        return false;
    }

    if matches!(tokens[0], "pwd" | "ls" | "find" | "rg" | "cat" | "head" | "tail" | "wc") {
        return true;
    }
    if tokens.len() == 2 && tokens[0] == "git" && tokens[1] == "status" {
        return true;
    }
    if tokens.len() == 3 && tokens[0] == "git" && tokens[1] == "diff" && tokens[2] == "--stat" {
        return true;
    }
    false
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

    (pipeline_override.unwrap_or(fallback_endpoint), false)
}

fn normalize_auth_header(raw: &str) -> String {
    if raw.to_ascii_lowercase().starts_with("bearer ") {
        raw.to_string()
    } else {
        format!("Bearer {}", raw)
    }
}

fn setting_bool(settings: &HashMap<String, String>, key: &str, fallback: bool) -> bool {
    settings.get(key).map_or(fallback, |raw| {
        matches!(
            raw.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        )
    })
}

async fn load_settings_map(pool: &SqlitePool) -> Result<HashMap<String, String>, String> {
    let entries = storage::load_all_settings(pool)
        .await
        .map_err(|err| err.to_string())?;
    Ok(entries
        .into_iter()
        .map(|entry| (entry.key, entry.value))
        .collect())
}

fn clip_chars(value: &str, max_chars: usize) -> String {
    if max_chars == 0 {
        return String::new();
    }
    let trimmed = value.trim();
    if trimmed.chars().count() <= max_chars {
        return trimmed.to_string();
    }
    let mut out = String::new();
    for ch in trimmed.chars().take(max_chars.saturating_sub(1)) {
        out.push(ch);
    }
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::is_allowlisted_shell_command;

    #[test]
    fn allowlists_safe_commands() {
        assert!(is_allowlisted_shell_command("pwd"));
        assert!(is_allowlisted_shell_command("ls -la"));
        assert!(is_allowlisted_shell_command("git status"));
        assert!(is_allowlisted_shell_command("git diff --stat"));
    }

    #[test]
    fn rejects_non_allowlisted_or_compound_commands() {
        assert!(!is_allowlisted_shell_command("npm install"));
        assert!(!is_allowlisted_shell_command("ls && rm -rf /"));
        assert!(!is_allowlisted_shell_command("cat file.txt | wc -l"));
    }
}
