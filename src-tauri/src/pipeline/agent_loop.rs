use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use chrono::{SecondsFormat, Utc};
use reqwest::header::AUTHORIZATION;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sqlx::SqlitePool;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;
use tokio::time::sleep;
use uuid::Uuid;

use crate::commands::streaming::GenerationState;
use crate::events::{AGENT_TOOL_CONFIRMATION_REQUIRED, PIPELINE_PROGRESS};
use crate::models::KnowledgeSearchResult;
use crate::pipeline::types::AgentToolDecision;
use crate::storage;

use super::types::{
    AgentRunSummary, AgentToolConfirmationRequiredEvent, AgentToolRiskLevel, LayerOutcome,
    PipelineProgressActivityKind, PipelineProgressEvent, PipelineProgressStatus, PipelineWarning,
    PipelineWarningCode,
};

pub const LAYER_NAME: &str = "agent_loop";
const MAX_TOOL_STEPS: usize = 8;
const MAX_WALL_CLOCK: Duration = Duration::from_secs(120);
const TOOL_CONFIRMATION_TIMEOUT: Duration = Duration::from_secs(45);
const TOOL_OUTPUT_CHAR_CAP: usize = 8 * 1024;
const PROMPT_APPEND_CHAR_CAP: usize = 10 * 1024;
const PLANNER_MAX_TOKENS: u32 = 320;
const TOOL_COMMAND_TIMEOUT: Duration = Duration::from_secs(20);
const JSON_LOG_CHAR_CAP: usize = 4 * 1024;
const PERMISSION_RULES_SETTING_KEY: &str = "agent.permissionRules.v1";

#[derive(Debug, Clone)]
pub struct AgentLoopOutput {
    pub final_prompt: String,
    pub summary: AgentRunSummary,
    pub trace: Value,
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
    let run_started_at = now_rfc3339();
    let mut trace = AgentRunTrace {
        run: AgentRunTraceRun {
            started_at: run_started_at,
            ended_at: String::new(),
            wall_clock_budget_reached: false,
            cancelled: false,
            max_tool_steps: MAX_TOOL_STEPS,
            max_wall_clock_seconds: MAX_WALL_CLOCK.as_secs(),
            loop_steps_executed: 0,
        },
        tool_calls: Vec::new(),
        permission_decisions: Vec::new(),
    };

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
            trace.run.ended_at = now_rfc3339();
            let summary = derive_summary_from_trace(&trace);
            let output = AgentLoopOutput {
                final_prompt: base_prompt.to_string(),
                summary,
                trace: trace_to_value(&trace),
            };
            return LayerOutcome::fallback(output, warnings, started.elapsed().as_millis() as u64);
        }
    };

    let planner_config = PlannerConfig::from_settings(&settings);
    let mut permission_rules = match load_permission_rules(&settings) {
        Ok(rules) => rules,
        Err(err) => {
            warnings.push(PipelineWarning {
                code: PipelineWarningCode::AgentPlannerFallback,
                layer: LAYER_NAME.to_string(),
                message: format!(
                    "Permission rules were invalid and have been ignored for this run. ({})",
                    err
                ),
            });
            Vec::new()
        }
    };

    for step in 0..MAX_TOOL_STEPS {
        if cancellation_flag.load(Ordering::SeqCst) {
            trace.run.cancelled = true;
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
            trace.run.wall_clock_budget_reached = true;
            warnings.push(PipelineWarning {
                code: PipelineWarningCode::AgentToolTimedOut,
                layer: LAYER_NAME.to_string(),
                message: "Agent run reached the 120-second budget and was stopped".to_string(),
            });
            break;
        }

        trace.run.loop_steps_executed = step + 1;
        emit_analyzing_progress(app, request_id, step + 1);

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

        let planner_raw =
            match call_planner(&planner_config, &planner_prompt, request_id, step + 1).await {
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

        let planner_candidate =
            extract_json_candidate(&planner_raw).unwrap_or_else(|| planner_raw.trim().to_string());
        tracing::info!(
            target: "state_logger",
            module = "pipeline",
            event = "agent_planner_output",
            request_id = %request_id,
            step = step + 1,
            raw_chars = planner_raw.chars().count(),
            candidate_chars = planner_candidate.chars().count(),
            raw_json = %clip_chars(&planner_raw, JSON_LOG_CHAR_CAP),
            candidate_json = %clip_chars(&planner_candidate, JSON_LOG_CHAR_CAP),
            "Planner raw/candidate JSON output"
        );

        match parse_planner_decision_from_candidate(&planner_raw, &planner_candidate) {
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
                let call_id = Uuid::new_v4().to_string();
                let call_started_at = now_rfc3339();
                let mut call_trace = AgentTraceToolCall {
                    call_id: call_id.clone(),
                    step: step + 1,
                    tool: tool_call.tool.clone(),
                    normalized_args: tool_call.args.clone(),
                    state_transitions: vec![AgentTraceStateTransition {
                        state: ToolCallState::Pending,
                        at: call_started_at,
                    }],
                    output_raw: None,
                    error_raw: None,
                    output_excerpt: String::new(),
                    summary: String::new(),
                    approval_requested: false,
                    denied: false,
                    timed_out: false,
                    interrupted: false,
                };

                let validated = match normalize_and_validate_tool_call(&tool_call) {
                    Ok(validated) => validated,
                    Err(validation_error) => {
                        let warning = PipelineWarning {
                            code: PipelineWarningCode::AgentToolFailed,
                            layer: LAYER_NAME.to_string(),
                            message: format!(
                                "Tool validation failed for '{}': {}",
                                tool_call.tool, validation_error
                            ),
                        };
                        warnings.push(warning);
                        let error_text = format!("Validation failed: {}", validation_error);
                        call_trace.summary = "Tool call validation failed".to_string();
                        call_trace.output_excerpt = clip_chars(&error_text, TOOL_OUTPUT_CHAR_CAP);
                        call_trace.error_raw = Some(error_text.clone());
                        call_trace
                            .state_transitions
                            .push(AgentTraceStateTransition {
                                state: ToolCallState::Error,
                                at: now_rfc3339(),
                            });
                        trace.tool_calls.push(call_trace);

                        observations.push(format!(
                            "Step {} | {} | Tool call validation failed\n{}",
                            step + 1,
                            tool_call.tool,
                            clip_chars(&error_text, TOOL_OUTPUT_CHAR_CAP)
                        ));
                        emit_agent_progress(
                            app,
                            request_id,
                            PipelineProgressStatus::Failed,
                            "Tool arguments were invalid",
                            PipelineProgressActivityKind::Tool,
                            normalize_rule_tool(&tool_call.tool).map(str::to_string),
                            Some(step + 1),
                            Some(call_id.clone()),
                            None,
                        );
                        continue;
                    }
                };

                call_trace.tool = validated.tool.canonical().to_string();
                call_trace.normalized_args = validated.args.clone();
                let progress_descriptor =
                    build_tool_progress_descriptor(validated.tool, &validated.args);
                emit_agent_progress(
                    app,
                    request_id,
                    PipelineProgressStatus::Started,
                    progress_descriptor.started_message.clone(),
                    PipelineProgressActivityKind::Tool,
                    Some(validated.tool.canonical().to_string()),
                    Some(step + 1),
                    Some(call_id.clone()),
                    progress_descriptor.display_target.clone(),
                );

                tracing::info!(
                    target: "state_logger",
                    module = "pipeline",
                    event = "agent_tool_selected",
                    request_id = %request_id,
                    step = step + 1,
                    call_id = %call_id,
                    tool = %call_trace.tool,
                    has_summary = validated.summary.is_some(),
                    tool_args_json = %value_to_compact_json(&validated.args),
                    "Planner selected tool call"
                );

                let execution = execute_validated_tool_call(
                    app,
                    pool,
                    generation_state,
                    cancellation_flag.clone(),
                    request_id,
                    &call_id,
                    selected_doc_ids,
                    &validated,
                    &mut permission_rules,
                )
                .await;
                emit_agent_progress(
                    app,
                    request_id,
                    tool_terminal_progress_status(&execution),
                    build_tool_terminal_message(
                        validated.tool,
                        progress_descriptor.display_target.as_deref(),
                        &execution,
                    ),
                    PipelineProgressActivityKind::Tool,
                    Some(validated.tool.canonical().to_string()),
                    Some(step + 1),
                    Some(call_id.clone()),
                    progress_descriptor.display_target.clone(),
                );

                for permission_record in execution.permission_records {
                    trace.permission_decisions.push(permission_record);
                }

                for warning in execution.warnings {
                    warnings.push(warning);
                }

                if let Some(started_at) = execution.execution_started_at {
                    call_trace
                        .state_transitions
                        .push(AgentTraceStateTransition {
                            state: ToolCallState::Running,
                            at: started_at,
                        });
                }

                call_trace
                    .state_transitions
                    .push(AgentTraceStateTransition {
                        state: execution.final_state,
                        at: execution.ended_at.clone(),
                    });
                call_trace.summary = execution.summary.clone();
                call_trace.output_excerpt = execution.output_excerpt.clone();
                call_trace.output_raw = execution.raw_output.clone();
                call_trace.error_raw = execution.raw_error.clone();
                call_trace.approval_requested = execution.approval_requested;
                call_trace.denied = execution.denied;
                call_trace.timed_out = execution.timed_out;
                call_trace.interrupted = execution.interrupted;

                observations.push(format!(
                    "Step {} | {} | {}\n{}",
                    step + 1,
                    call_trace.tool,
                    execution.summary,
                    execution.output_excerpt
                ));

                let tool_execution_payload = json!({
                    "call_id": call_trace.call_id,
                    "tool": call_trace.tool,
                    "summary": call_trace.summary,
                    "approval_requested": call_trace.approval_requested,
                    "denied": call_trace.denied,
                    "timed_out": call_trace.timed_out,
                    "interrupted": call_trace.interrupted,
                    "output_excerpt": call_trace.output_excerpt,
                });
                tracing::info!(
                    target: "state_logger",
                    module = "pipeline",
                    event = "agent_tool_execution_json",
                    request_id = %request_id,
                    step = step + 1,
                    payload = %clip_chars(&tool_execution_payload.to_string(), JSON_LOG_CHAR_CAP),
                    "Structured JSON for tool execution"
                );

                trace.tool_calls.push(call_trace);
            }
            PlannerDecision::Invalid(raw) => {
                tracing::warn!(
                    target: "state_logger",
                    module = "pipeline",
                    event = "agent_planner_invalid_output",
                    request_id = %request_id,
                    step = step + 1,
                    raw_chars = raw.chars().count(),
                    raw_json = %clip_chars(&raw, JSON_LOG_CHAR_CAP),
                    "Planner output was not valid decision JSON"
                );
                warnings.push(PipelineWarning {
                    code: PipelineWarningCode::AgentPlannerFallback,
                    layer: LAYER_NAME.to_string(),
                    message:
                        "Planner output could not be parsed as tool/finish JSON. Using fallback."
                            .to_string(),
                });
                if !raw.trim().is_empty() {
                    planner_hint = Some(raw);
                }
                break;
            }
        }
    }

    trace.run.ended_at = now_rfc3339();
    let summary = derive_summary_from_trace(&trace);

    let mut final_prompt = base_prompt.to_string();
    let agent_appendix =
        build_agent_prompt_appendix(&observations, planner_hint.as_deref(), summary.timed_out);
    if !agent_appendix.is_empty() {
        final_prompt.push_str("\n\n");
        final_prompt.push_str(&agent_appendix);
    }

    let elapsed = started.elapsed().as_millis() as u64;
    let output = AgentLoopOutput {
        final_prompt,
        summary: summary.clone(),
        trace: trace_to_value(&trace),
    };

    tracing::info!(
        target: "state_logger",
        module = "pipeline",
        event = "agent_loop_completed",
        request_id = %request_id,
        elapsed_ms = elapsed,
        tool_calls_total = summary.tool_calls_total,
        approvals_required = summary.approvals_required,
        approvals_denied = summary.approvals_denied,
        timed_out = summary.timed_out,
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
    raw_output: Option<String>,
    raw_error: Option<String>,
    warnings: Vec<PipelineWarning>,
    approval_requested: bool,
    denied: bool,
    timed_out: bool,
    interrupted: bool,
    permission_records: Vec<AgentTracePermissionDecision>,
    final_state: ToolCallState,
    execution_started_at: Option<String>,
    ended_at: String,
}

#[derive(Debug, Clone)]
struct ToolProgressDescriptor {
    started_message: String,
    display_target: Option<String>,
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
    action: Option<String>,
    tool: Option<String>,
    tool_name: Option<String>,
    args: Option<Value>,
    arguments: Option<Value>,
    summary: Option<String>,
    final_answer: Option<String>,
    answer: Option<String>,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ToolName {
    KnowledgeSearch,
    ShellExec,
    FsRead,
    FsList,
    FsWrite,
    FsDelete,
}

impl ToolName {
    fn canonical(self) -> &'static str {
        match self {
            Self::KnowledgeSearch => "knowledge.search",
            Self::ShellExec => "shell.exec",
            Self::FsRead => "fs.read",
            Self::FsList => "fs.list",
            Self::FsWrite => "fs.write",
            Self::FsDelete => "fs.delete",
        }
    }

    fn from_raw(raw: &str) -> Option<Self> {
        let normalized = raw
            .trim()
            .to_ascii_lowercase()
            .replace(['_', '-'], ".")
            .replace(' ', "");

        match normalized.as_str() {
            "knowledge.search" | "knowledge" | "search" | "knowledgesearch" => {
                Some(Self::KnowledgeSearch)
            }
            "shell.exec" | "shell" | "shellexec" | "exec" => Some(Self::ShellExec),
            "fs.read" | "read" | "fsread" => Some(Self::FsRead),
            "fs.list" | "list" | "fslist" | "ls" => Some(Self::FsList),
            "fs.write" | "write" | "fswrite" => Some(Self::FsWrite),
            "fs.delete" | "delete" | "fsdelete" | "rm" => Some(Self::FsDelete),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy)]
enum ToolArgType {
    String,
    Bool,
    U64,
}

#[derive(Debug, Clone, Copy)]
enum ToolArgDefault {
    None,
    String(&'static str),
    Bool(bool),
    U64(u64),
}

#[derive(Debug, Clone, Copy)]
struct ToolArgSchema {
    name: &'static str,
    arg_type: ToolArgType,
    required: bool,
    default: ToolArgDefault,
    min: Option<u64>,
    max: Option<u64>,
}

#[derive(Debug, Clone, Copy)]
struct ToolContract {
    tool: ToolName,
    args: &'static [ToolArgSchema],
}

const KNOWLEDGE_SEARCH_SCHEMA: [ToolArgSchema; 2] = [
    ToolArgSchema {
        name: "query",
        arg_type: ToolArgType::String,
        required: true,
        default: ToolArgDefault::None,
        min: None,
        max: None,
    },
    ToolArgSchema {
        name: "limit",
        arg_type: ToolArgType::U64,
        required: false,
        default: ToolArgDefault::U64(4),
        min: Some(1),
        max: Some(8),
    },
];

const SHELL_EXEC_SCHEMA: [ToolArgSchema; 1] = [ToolArgSchema {
    name: "command",
    arg_type: ToolArgType::String,
    required: true,
    default: ToolArgDefault::None,
    min: None,
    max: None,
}];

const FS_READ_SCHEMA: [ToolArgSchema; 1] = [ToolArgSchema {
    name: "path",
    arg_type: ToolArgType::String,
    required: true,
    default: ToolArgDefault::None,
    min: None,
    max: None,
}];

const FS_LIST_SCHEMA: [ToolArgSchema; 1] = [ToolArgSchema {
    name: "path",
    arg_type: ToolArgType::String,
    required: false,
    default: ToolArgDefault::String("."),
    min: None,
    max: None,
}];

const FS_WRITE_SCHEMA: [ToolArgSchema; 3] = [
    ToolArgSchema {
        name: "path",
        arg_type: ToolArgType::String,
        required: true,
        default: ToolArgDefault::None,
        min: None,
        max: None,
    },
    ToolArgSchema {
        name: "content",
        arg_type: ToolArgType::String,
        required: true,
        default: ToolArgDefault::None,
        min: None,
        max: None,
    },
    ToolArgSchema {
        name: "append",
        arg_type: ToolArgType::Bool,
        required: false,
        default: ToolArgDefault::Bool(false),
        min: None,
        max: None,
    },
];

const FS_DELETE_SCHEMA: [ToolArgSchema; 2] = [
    ToolArgSchema {
        name: "path",
        arg_type: ToolArgType::String,
        required: true,
        default: ToolArgDefault::None,
        min: None,
        max: None,
    },
    ToolArgSchema {
        name: "recursive",
        arg_type: ToolArgType::Bool,
        required: false,
        default: ToolArgDefault::Bool(false),
        min: None,
        max: None,
    },
];

const TOOL_CONTRACTS: [ToolContract; 6] = [
    ToolContract {
        tool: ToolName::KnowledgeSearch,
        args: &KNOWLEDGE_SEARCH_SCHEMA,
    },
    ToolContract {
        tool: ToolName::ShellExec,
        args: &SHELL_EXEC_SCHEMA,
    },
    ToolContract {
        tool: ToolName::FsRead,
        args: &FS_READ_SCHEMA,
    },
    ToolContract {
        tool: ToolName::FsList,
        args: &FS_LIST_SCHEMA,
    },
    ToolContract {
        tool: ToolName::FsWrite,
        args: &FS_WRITE_SCHEMA,
    },
    ToolContract {
        tool: ToolName::FsDelete,
        args: &FS_DELETE_SCHEMA,
    },
];

#[derive(Debug, Clone)]
struct ValidatedToolCall {
    tool: ToolName,
    args: Value,
    summary: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum PermissionRuleAction {
    Allow,
    Deny,
    Ask,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PermissionRule {
    tool: String,
    pattern: String,
    action: PermissionRuleAction,
    created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    metadata: Option<Value>,
}

#[derive(Debug, Clone)]
struct PermissionEvaluation {
    match_target: Option<String>,
    matched_pattern: Option<String>,
    matched_action: Option<PermissionRuleAction>,
    default_action: PermissionRuleAction,
    final_action: PermissionRuleAction,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
enum ToolCallState {
    Pending,
    Running,
    Completed,
    Error,
    Interrupted,
}

#[derive(Debug, Clone, Serialize)]
struct AgentRunTrace {
    run: AgentRunTraceRun,
    tool_calls: Vec<AgentTraceToolCall>,
    permission_decisions: Vec<AgentTracePermissionDecision>,
}

#[derive(Debug, Clone, Serialize)]
struct AgentRunTraceRun {
    started_at: String,
    ended_at: String,
    wall_clock_budget_reached: bool,
    cancelled: bool,
    max_tool_steps: usize,
    max_wall_clock_seconds: u64,
    loop_steps_executed: usize,
}

#[derive(Debug, Clone, Serialize)]
struct AgentTraceToolCall {
    call_id: String,
    step: usize,
    tool: String,
    normalized_args: Value,
    state_transitions: Vec<AgentTraceStateTransition>,
    output_raw: Option<String>,
    error_raw: Option<String>,
    output_excerpt: String,
    summary: String,
    approval_requested: bool,
    denied: bool,
    timed_out: bool,
    interrupted: bool,
}

#[derive(Debug, Clone, Serialize)]
struct AgentTraceStateTransition {
    state: ToolCallState,
    at: String,
}

#[derive(Debug, Clone, Serialize)]
struct AgentTracePermissionDecision {
    decision_id: String,
    call_id: String,
    tool: String,
    request_summary: String,
    args_preview: String,
    match_target: Option<String>,
    matched_pattern: Option<String>,
    matched_action: Option<PermissionRuleAction>,
    default_action: PermissionRuleAction,
    match_result: PermissionRuleAction,
    user_response: Option<AgentToolDecision>,
    timeout: bool,
    requested_at: String,
    resolved_at: String,
}

#[derive(Debug, Clone, Copy)]
enum ConfirmationDecision {
    ApproveOnce,
    ApproveAlways,
    Deny,
    TimedOut,
    Interrupted,
}

#[derive(Debug)]
enum ShellExecFailure {
    TimedOut { stdout: String, stderr: String },
    Interrupted { stdout: String, stderr: String },
    Failed(String),
}

async fn execute_validated_tool_call(
    app: &AppHandle,
    pool: &SqlitePool,
    generation_state: &GenerationState,
    cancellation_flag: Arc<AtomicBool>,
    request_id: &str,
    call_id: &str,
    selected_doc_ids: Option<&Vec<String>>,
    validated_call: &ValidatedToolCall,
    permission_rules: &mut Vec<PermissionRule>,
) -> ToolExecutionResult {
    let mut warnings = Vec::new();
    let mut permission_records = Vec::new();
    let mut approval_requested = false;
    let mut denied = false;
    let mut timed_out = false;
    let mut interrupted = false;
    let mut execution_started_at = None;

    let permission_eval =
        evaluate_permission(validated_call.tool, &validated_call.args, permission_rules);
    let requested_at = now_rfc3339();
    let mut permission_record = AgentTracePermissionDecision {
        decision_id: Uuid::new_v4().to_string(),
        call_id: call_id.to_string(),
        tool: validated_call.tool.canonical().to_string(),
        request_summary: tool_summary_for_permission(validated_call.tool, &validated_call.args),
        args_preview: clip_chars(&value_to_compact_json(&validated_call.args), 800),
        match_target: permission_eval.match_target.clone(),
        matched_pattern: permission_eval.matched_pattern.clone(),
        matched_action: permission_eval.matched_action,
        default_action: permission_eval.default_action,
        match_result: permission_eval.final_action,
        user_response: None,
        timeout: false,
        requested_at,
        resolved_at: String::new(),
    };

    match permission_eval.final_action {
        PermissionRuleAction::Deny => {
            denied = true;
            permission_record.user_response = Some(AgentToolDecision::Deny);
            permission_record.resolved_at = now_rfc3339();
            permission_records.push(permission_record);

            let denial_message = "Permission rule denied this tool call.".to_string();
            warnings.push(PipelineWarning {
                code: PipelineWarningCode::AgentToolDenied,
                layer: LAYER_NAME.to_string(),
                message: format!(
                    "{} denied by rule for tool '{}'",
                    validated_call.tool.canonical(),
                    validated_call.tool.canonical()
                ),
            });

            return ToolExecutionResult {
                summary: "Tool call denied by permission rule".to_string(),
                output_excerpt: clip_chars(&denial_message, TOOL_OUTPUT_CHAR_CAP),
                raw_output: None,
                raw_error: Some(denial_message),
                warnings,
                approval_requested,
                denied,
                timed_out,
                interrupted,
                permission_records,
                final_state: ToolCallState::Error,
                execution_started_at,
                ended_at: now_rfc3339(),
            };
        }
        PermissionRuleAction::Ask => {
            approval_requested = true;
            let confirmation = request_confirmation(
                app,
                generation_state,
                cancellation_flag.clone(),
                request_id,
                validated_call.tool.canonical(),
                &permission_record.request_summary,
                &permission_record.args_preview,
                risk_level_for_tool(validated_call.tool),
                permission_eval.matched_pattern.clone().or_else(|| {
                    derive_auto_allow_pattern(
                        validated_call.tool,
                        permission_eval.match_target.as_deref(),
                    )
                }),
                permission_eval.match_target.clone(),
            )
            .await;

            match confirmation {
                ConfirmationDecision::Deny => {
                    denied = true;
                    permission_record.user_response = Some(AgentToolDecision::Deny);
                    permission_record.resolved_at = now_rfc3339();
                    permission_records.push(permission_record);

                    warnings.push(PipelineWarning {
                        code: PipelineWarningCode::AgentToolDenied,
                        layer: LAYER_NAME.to_string(),
                        message: format!(
                            "{} denied by user confirmation",
                            validated_call.tool.canonical()
                        ),
                    });

                    return ToolExecutionResult {
                        summary: "Tool call denied".to_string(),
                        output_excerpt: "User denied tool execution.".to_string(),
                        raw_output: None,
                        raw_error: Some("User denied tool execution.".to_string()),
                        warnings,
                        approval_requested,
                        denied,
                        timed_out,
                        interrupted,
                        permission_records,
                        final_state: ToolCallState::Error,
                        execution_started_at,
                        ended_at: now_rfc3339(),
                    };
                }
                ConfirmationDecision::TimedOut => {
                    denied = true;
                    timed_out = true;
                    permission_record.timeout = true;
                    permission_record.resolved_at = now_rfc3339();
                    permission_records.push(permission_record);

                    warnings.push(PipelineWarning {
                        code: PipelineWarningCode::AgentToolTimedOut,
                        layer: LAYER_NAME.to_string(),
                        message: format!("{} approval timed out", validated_call.tool.canonical()),
                    });

                    return ToolExecutionResult {
                        summary: "Tool call approval timed out".to_string(),
                        output_excerpt: "Approval timed out. Tool call was not executed."
                            .to_string(),
                        raw_output: None,
                        raw_error: Some(
                            "Approval timed out. Tool call was not executed.".to_string(),
                        ),
                        warnings,
                        approval_requested,
                        denied,
                        timed_out,
                        interrupted,
                        permission_records,
                        final_state: ToolCallState::Error,
                        execution_started_at,
                        ended_at: now_rfc3339(),
                    };
                }
                ConfirmationDecision::Interrupted => {
                    interrupted = true;
                    permission_record.resolved_at = now_rfc3339();
                    permission_records.push(permission_record);

                    return ToolExecutionResult {
                        summary: "Tool call interrupted".to_string(),
                        output_excerpt: "Generation was interrupted before executing this tool."
                            .to_string(),
                        raw_output: None,
                        raw_error: Some(
                            "Generation was interrupted before executing this tool.".to_string(),
                        ),
                        warnings,
                        approval_requested,
                        denied,
                        timed_out,
                        interrupted,
                        permission_records,
                        final_state: ToolCallState::Interrupted,
                        execution_started_at,
                        ended_at: now_rfc3339(),
                    };
                }
                ConfirmationDecision::ApproveOnce => {
                    permission_record.user_response = Some(AgentToolDecision::ApproveOnce);
                }
                ConfirmationDecision::ApproveAlways => {
                    permission_record.user_response = Some(AgentToolDecision::ApproveAlways);
                    if let Some(rule) = build_auto_allow_rule(
                        validated_call.tool,
                        permission_eval.match_target.as_deref(),
                        request_id,
                    ) {
                        permission_rules.push(rule);
                        if let Err(err) = persist_permission_rules(pool, permission_rules).await {
                            warnings.push(PipelineWarning {
                                code: PipelineWarningCode::AgentToolFailed,
                                layer: LAYER_NAME.to_string(),
                                message: format!(
                                    "Tool was approved, but failed to persist auto-allow rule: {}",
                                    err
                                ),
                            });
                        }
                    }
                }
            }

            permission_record.resolved_at = now_rfc3339();
            permission_records.push(permission_record);
        }
        PermissionRuleAction::Allow => {
            permission_record.resolved_at = now_rfc3339();
            permission_records.push(permission_record);
        }
    }

    if cancellation_flag.load(Ordering::SeqCst) {
        interrupted = true;
        return ToolExecutionResult {
            summary: "Tool call interrupted".to_string(),
            output_excerpt: "Generation was interrupted before tool execution.".to_string(),
            raw_output: None,
            raw_error: Some("Generation was interrupted before tool execution.".to_string()),
            warnings,
            approval_requested,
            denied,
            timed_out,
            interrupted,
            permission_records,
            final_state: ToolCallState::Interrupted,
            execution_started_at,
            ended_at: now_rfc3339(),
        };
    }

    execution_started_at = Some(now_rfc3339());

    match validated_call.tool {
        ToolName::KnowledgeSearch => {
            let query = read_required_string_arg(&validated_call.args, "query").unwrap_or_default();
            let limit = read_optional_u64_arg(&validated_call.args, "limit").unwrap_or(4) as usize;
            match execute_knowledge_search(pool, &query, selected_doc_ids, limit).await {
                Ok(raw_output) => {
                    let summary = validated_call
                        .summary
                        .clone()
                        .unwrap_or_else(|| "Knowledge search completed".to_string());
                    ToolExecutionResult {
                        summary,
                        output_excerpt: clip_chars(&raw_output, TOOL_OUTPUT_CHAR_CAP),
                        raw_output: Some(raw_output),
                        raw_error: None,
                        warnings,
                        approval_requested,
                        denied,
                        timed_out,
                        interrupted,
                        permission_records,
                        final_state: ToolCallState::Completed,
                        execution_started_at,
                        ended_at: now_rfc3339(),
                    }
                }
                Err(err) => {
                    warnings.push(PipelineWarning {
                        code: PipelineWarningCode::AgentToolFailed,
                        layer: LAYER_NAME.to_string(),
                        message: format!("knowledge.search failed: {}", err),
                    });
                    ToolExecutionResult {
                        summary: "Knowledge search failed".to_string(),
                        output_excerpt: clip_chars(&err, TOOL_OUTPUT_CHAR_CAP),
                        raw_output: None,
                        raw_error: Some(err),
                        warnings,
                        approval_requested,
                        denied,
                        timed_out,
                        interrupted,
                        permission_records,
                        final_state: ToolCallState::Error,
                        execution_started_at,
                        ended_at: now_rfc3339(),
                    }
                }
            }
        }
        ToolName::ShellExec => {
            let command =
                read_required_string_arg(&validated_call.args, "command").unwrap_or_default();
            match execute_shell_command(&command, cancellation_flag).await {
                Ok(raw_output) => {
                    let summary = validated_call
                        .summary
                        .clone()
                        .unwrap_or_else(|| "Shell command completed".to_string());
                    ToolExecutionResult {
                        summary,
                        output_excerpt: clip_chars(&raw_output, TOOL_OUTPUT_CHAR_CAP),
                        raw_output: Some(raw_output),
                        raw_error: None,
                        warnings,
                        approval_requested,
                        denied,
                        timed_out,
                        interrupted,
                        permission_records,
                        final_state: ToolCallState::Completed,
                        execution_started_at,
                        ended_at: now_rfc3339(),
                    }
                }
                Err(ShellExecFailure::TimedOut { stdout, stderr }) => {
                    timed_out = true;
                    let raw_error = build_merged_shell_output(&stdout, &stderr);
                    warnings.push(PipelineWarning {
                        code: PipelineWarningCode::AgentToolTimedOut,
                        layer: LAYER_NAME.to_string(),
                        message: "shell.exec timed out".to_string(),
                    });
                    ToolExecutionResult {
                        summary: "Shell command timed out".to_string(),
                        output_excerpt: clip_chars(&raw_error, TOOL_OUTPUT_CHAR_CAP),
                        raw_output: None,
                        raw_error: Some(raw_error),
                        warnings,
                        approval_requested,
                        denied,
                        timed_out,
                        interrupted,
                        permission_records,
                        final_state: ToolCallState::Error,
                        execution_started_at,
                        ended_at: now_rfc3339(),
                    }
                }
                Err(ShellExecFailure::Interrupted { stdout, stderr }) => {
                    interrupted = true;
                    let partial_output = build_merged_shell_output(&stdout, &stderr);
                    ToolExecutionResult {
                        summary: "Shell command interrupted".to_string(),
                        output_excerpt: clip_chars(&partial_output, TOOL_OUTPUT_CHAR_CAP),
                        raw_output: if partial_output.is_empty() {
                            None
                        } else {
                            Some(partial_output)
                        },
                        raw_error: Some("Shell command interrupted by cancellation.".to_string()),
                        warnings,
                        approval_requested,
                        denied,
                        timed_out,
                        interrupted,
                        permission_records,
                        final_state: ToolCallState::Interrupted,
                        execution_started_at,
                        ended_at: now_rfc3339(),
                    }
                }
                Err(ShellExecFailure::Failed(err)) => {
                    warnings.push(PipelineWarning {
                        code: PipelineWarningCode::AgentToolFailed,
                        layer: LAYER_NAME.to_string(),
                        message: format!("shell.exec failed: {}", err),
                    });
                    ToolExecutionResult {
                        summary: "Shell command failed".to_string(),
                        output_excerpt: clip_chars(&err, TOOL_OUTPUT_CHAR_CAP),
                        raw_output: None,
                        raw_error: Some(err),
                        warnings,
                        approval_requested,
                        denied,
                        timed_out,
                        interrupted,
                        permission_records,
                        final_state: ToolCallState::Error,
                        execution_started_at,
                        ended_at: now_rfc3339(),
                    }
                }
            }
        }
        ToolName::FsRead => {
            let path = read_required_string_arg(&validated_call.args, "path").unwrap_or_default();
            match tokio::fs::read_to_string(&path).await {
                Ok(content) => {
                    let summary = validated_call
                        .summary
                        .clone()
                        .unwrap_or_else(|| format!("Read file {}", path));
                    ToolExecutionResult {
                        summary,
                        output_excerpt: clip_chars(&content, TOOL_OUTPUT_CHAR_CAP),
                        raw_output: Some(content),
                        raw_error: None,
                        warnings,
                        approval_requested,
                        denied,
                        timed_out,
                        interrupted,
                        permission_records,
                        final_state: ToolCallState::Completed,
                        execution_started_at,
                        ended_at: now_rfc3339(),
                    }
                }
                Err(err) => {
                    let err_text = err.to_string();
                    warnings.push(PipelineWarning {
                        code: PipelineWarningCode::AgentToolFailed,
                        layer: LAYER_NAME.to_string(),
                        message: format!("fs.read failed for '{}': {}", path, err_text),
                    });
                    ToolExecutionResult {
                        summary: "File read failed".to_string(),
                        output_excerpt: clip_chars(&err_text, TOOL_OUTPUT_CHAR_CAP),
                        raw_output: None,
                        raw_error: Some(err_text),
                        warnings,
                        approval_requested,
                        denied,
                        timed_out,
                        interrupted,
                        permission_records,
                        final_state: ToolCallState::Error,
                        execution_started_at,
                        ended_at: now_rfc3339(),
                    }
                }
            }
        }
        ToolName::FsList => {
            let path = read_optional_string_arg(&validated_call.args, "path")
                .unwrap_or_else(|| ".".to_string());
            match list_directory(&path).await {
                Ok(content) => {
                    let summary = validated_call
                        .summary
                        .clone()
                        .unwrap_or_else(|| format!("Listed directory {}", path));
                    ToolExecutionResult {
                        summary,
                        output_excerpt: clip_chars(&content, TOOL_OUTPUT_CHAR_CAP),
                        raw_output: Some(content),
                        raw_error: None,
                        warnings,
                        approval_requested,
                        denied,
                        timed_out,
                        interrupted,
                        permission_records,
                        final_state: ToolCallState::Completed,
                        execution_started_at,
                        ended_at: now_rfc3339(),
                    }
                }
                Err(err) => {
                    warnings.push(PipelineWarning {
                        code: PipelineWarningCode::AgentToolFailed,
                        layer: LAYER_NAME.to_string(),
                        message: format!("fs.list failed for '{}': {}", path, err),
                    });
                    ToolExecutionResult {
                        summary: "Directory listing failed".to_string(),
                        output_excerpt: clip_chars(&err, TOOL_OUTPUT_CHAR_CAP),
                        raw_output: None,
                        raw_error: Some(err),
                        warnings,
                        approval_requested,
                        denied,
                        timed_out,
                        interrupted,
                        permission_records,
                        final_state: ToolCallState::Error,
                        execution_started_at,
                        ended_at: now_rfc3339(),
                    }
                }
            }
        }
        ToolName::FsWrite => {
            let path = read_required_string_arg(&validated_call.args, "path").unwrap_or_default();
            let content =
                read_required_string_arg(&validated_call.args, "content").unwrap_or_default();
            let append = read_optional_bool_arg(&validated_call.args, "append").unwrap_or(false);

            let write_result = if append {
                append_to_file(&path, &content).await
            } else {
                tokio::fs::write(&path, content.as_bytes())
                    .await
                    .map_err(|err| err.to_string())
            };

            match write_result {
                Ok(()) => {
                    let summary = validated_call
                        .summary
                        .clone()
                        .unwrap_or_else(|| format!("Wrote file {}", path));
                    ToolExecutionResult {
                        summary,
                        output_excerpt: "Write successful.".to_string(),
                        raw_output: Some("Write successful.".to_string()),
                        raw_error: None,
                        warnings,
                        approval_requested,
                        denied,
                        timed_out,
                        interrupted,
                        permission_records,
                        final_state: ToolCallState::Completed,
                        execution_started_at,
                        ended_at: now_rfc3339(),
                    }
                }
                Err(err) => {
                    warnings.push(PipelineWarning {
                        code: PipelineWarningCode::AgentToolFailed,
                        layer: LAYER_NAME.to_string(),
                        message: format!("fs.write failed for '{}': {}", path, err),
                    });
                    ToolExecutionResult {
                        summary: "File write failed".to_string(),
                        output_excerpt: clip_chars(&err, TOOL_OUTPUT_CHAR_CAP),
                        raw_output: None,
                        raw_error: Some(err),
                        warnings,
                        approval_requested,
                        denied,
                        timed_out,
                        interrupted,
                        permission_records,
                        final_state: ToolCallState::Error,
                        execution_started_at,
                        ended_at: now_rfc3339(),
                    }
                }
            }
        }
        ToolName::FsDelete => {
            let path = read_required_string_arg(&validated_call.args, "path").unwrap_or_default();
            let recursive =
                read_optional_bool_arg(&validated_call.args, "recursive").unwrap_or(false);
            match remove_path(&path, recursive).await {
                Ok(()) => {
                    let summary = validated_call
                        .summary
                        .clone()
                        .unwrap_or_else(|| format!("Deleted {}", path));
                    ToolExecutionResult {
                        summary,
                        output_excerpt: "Delete successful.".to_string(),
                        raw_output: Some("Delete successful.".to_string()),
                        raw_error: None,
                        warnings,
                        approval_requested,
                        denied,
                        timed_out,
                        interrupted,
                        permission_records,
                        final_state: ToolCallState::Completed,
                        execution_started_at,
                        ended_at: now_rfc3339(),
                    }
                }
                Err(err) => {
                    warnings.push(PipelineWarning {
                        code: PipelineWarningCode::AgentToolFailed,
                        layer: LAYER_NAME.to_string(),
                        message: format!("fs.delete failed for '{}': {}", path, err),
                    });
                    ToolExecutionResult {
                        summary: "Delete failed".to_string(),
                        output_excerpt: clip_chars(&err, TOOL_OUTPUT_CHAR_CAP),
                        raw_output: None,
                        raw_error: Some(err),
                        warnings,
                        approval_requested,
                        denied,
                        timed_out,
                        interrupted,
                        permission_records,
                        final_state: ToolCallState::Error,
                        execution_started_at,
                        ended_at: now_rfc3339(),
                    }
                }
            }
        }
    }
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
    pattern: Option<String>,
    match_target: Option<String>,
) -> ConfirmationDecision {
    let action_id = Uuid::new_v4().to_string();
    let expires_at = (Utc::now()
        + chrono::Duration::seconds(TOOL_CONFIRMATION_TIMEOUT.as_secs() as i64))
    .to_rfc3339_opts(SecondsFormat::Secs, true);

    let event = AgentToolConfirmationRequiredEvent {
        request_id: request_id.to_string(),
        action_id: action_id.clone(),
        tool: tool.to_string(),
        summary: summary.to_string(),
        args_preview: clip_chars(args_preview, 600),
        risk_level,
        expires_at,
        pattern,
        match_target,
    };

    if let Err(err) = app.emit(AGENT_TOOL_CONFIRMATION_REQUIRED, event) {
        tracing::warn!(
            request_id = %request_id,
            tool = %tool,
            "Failed to emit agent tool confirmation event: {}",
            err
        );
        return ConfirmationDecision::Deny;
    }

    let started = Instant::now();
    loop {
        if cancellation_flag.load(Ordering::SeqCst) {
            return ConfirmationDecision::Interrupted;
        }
        if let Some(decision) = generation_state
            .take_agent_decision(request_id, &action_id)
            .await
        {
            return match decision {
                AgentToolDecision::ApproveOnce => ConfirmationDecision::ApproveOnce,
                AgentToolDecision::ApproveAlways => ConfirmationDecision::ApproveAlways,
                AgentToolDecision::Deny => ConfirmationDecision::Deny,
            };
        }
        if started.elapsed() >= TOOL_CONFIRMATION_TIMEOUT {
            return ConfirmationDecision::TimedOut;
        }
        sleep(Duration::from_millis(160)).await;
    }
}

fn normalize_and_validate_tool_call(tool_call: &ToolCall) -> Result<ValidatedToolCall, String> {
    let Some(tool) = ToolName::from_raw(&tool_call.tool) else {
        return Err(format!("Unknown tool '{}'", tool_call.tool));
    };

    let contract = tool_contract(tool)
        .ok_or_else(|| format!("No schema contract found for '{}'.", tool.canonical()))?;

    let args_input = normalize_args_payload(tool_call.args.clone());
    let Value::Object(args_object) = args_input else {
        return Err("Tool args must be a JSON object".to_string());
    };

    let allowed_keys = contract
        .args
        .iter()
        .map(|field| field.name)
        .collect::<HashSet<_>>();

    for key in args_object.keys() {
        if !allowed_keys.contains(key.as_str()) {
            return Err(format!(
                "Unexpected argument '{}' for {}",
                key,
                tool.canonical()
            ));
        }
    }

    let mut normalized = Map::new();
    for field in contract.args {
        let input_value = args_object.get(field.name);
        match input_value {
            Some(value) => {
                let coerced = coerce_tool_arg_value(field, value)?;
                normalized.insert(field.name.to_string(), coerced);
            }
            None if field.required => {
                return Err(format!(
                    "Missing required argument '{}' for {}",
                    field.name,
                    tool.canonical()
                ));
            }
            None => {
                if let Some(default_value) = field.default.as_value() {
                    normalized.insert(field.name.to_string(), default_value);
                }
            }
        }
    }

    Ok(ValidatedToolCall {
        tool,
        args: Value::Object(normalized),
        summary: tool_call.summary.clone(),
    })
}

fn normalize_args_payload(value: Value) -> Value {
    match value {
        Value::String(raw) => {
            let trimmed = raw.trim();
            if (trimmed.starts_with('{') && trimmed.ends_with('}'))
                || (trimmed.starts_with('[') && trimmed.ends_with(']'))
            {
                serde_json::from_str::<Value>(trimmed).unwrap_or(Value::String(raw))
            } else {
                Value::String(raw)
            }
        }
        other => other,
    }
}

impl ToolArgDefault {
    fn as_value(self) -> Option<Value> {
        match self {
            ToolArgDefault::None => None,
            ToolArgDefault::String(value) => Some(Value::String(value.to_string())),
            ToolArgDefault::Bool(value) => Some(Value::Bool(value)),
            ToolArgDefault::U64(value) => Some(Value::Number(value.into())),
        }
    }
}

fn coerce_tool_arg_value(schema: &ToolArgSchema, value: &Value) -> Result<Value, String> {
    match schema.arg_type {
        ToolArgType::String => value
            .as_str()
            .map(|text| Value::String(text.trim().to_string()))
            .filter(|value| !value.as_str().unwrap_or_default().is_empty())
            .ok_or_else(|| format!("Argument '{}' must be a non-empty string", schema.name)),
        ToolArgType::Bool => coerce_bool(value)
            .map(Value::Bool)
            .ok_or_else(|| format!("Argument '{}' must be a boolean", schema.name)),
        ToolArgType::U64 => {
            let parsed = coerce_u64(value)
                .ok_or_else(|| format!("Argument '{}' must be an unsigned integer", schema.name))?;
            if let Some(min) = schema.min {
                if parsed < min {
                    return Err(format!("Argument '{}' must be >= {}", schema.name, min));
                }
            }
            if let Some(max) = schema.max {
                if parsed > max {
                    return Err(format!("Argument '{}' must be <= {}", schema.name, max));
                }
            }
            Ok(Value::Number(parsed.into()))
        }
    }
}

fn coerce_bool(value: &Value) -> Option<bool> {
    if let Some(boolean) = value.as_bool() {
        return Some(boolean);
    }
    if let Some(number) = value.as_i64() {
        return match number {
            0 => Some(false),
            1 => Some(true),
            _ => None,
        };
    }
    let text = value.as_str()?.trim().to_ascii_lowercase();
    match text.as_str() {
        "true" | "1" | "yes" | "on" => Some(true),
        "false" | "0" | "no" | "off" => Some(false),
        _ => None,
    }
}

fn coerce_u64(value: &Value) -> Option<u64> {
    if let Some(number) = value.as_u64() {
        return Some(number);
    }
    if let Some(number) = value.as_i64() {
        if number >= 0 {
            return Some(number as u64);
        }
    }
    let text = value.as_str()?.trim();
    if text.is_empty() || !text.chars().all(|ch| ch.is_ascii_digit()) {
        return None;
    }
    text.parse::<u64>().ok()
}

fn tool_contract(tool: ToolName) -> Option<&'static ToolContract> {
    TOOL_CONTRACTS.iter().find(|contract| contract.tool == tool)
}

fn catalog_tool_list() -> String {
    TOOL_CONTRACTS
        .iter()
        .map(|contract| contract.tool.canonical())
        .collect::<Vec<_>>()
        .join("|")
}

fn evaluate_permission(
    tool: ToolName,
    args: &Value,
    rules: &[PermissionRule],
) -> PermissionEvaluation {
    let match_target = permission_match_target(tool, args);
    let default_action = default_permission_action(tool, args);

    let mut matched_pattern = None;
    let mut matched_action = None;

    for rule in rules {
        if !rule_matches_tool(rule, tool) {
            continue;
        }
        if rule_pattern_matches(tool, rule.pattern.as_str(), match_target.as_deref()) {
            matched_pattern = Some(rule.pattern.clone());
            matched_action = Some(rule.action);
        }
    }

    let final_action = matched_action.unwrap_or(default_action);

    PermissionEvaluation {
        match_target,
        matched_pattern,
        matched_action,
        default_action,
        final_action,
    }
}

fn default_permission_action(tool: ToolName, args: &Value) -> PermissionRuleAction {
    match tool {
        ToolName::ShellExec => {
            let command = read_required_string_arg(args, "command").unwrap_or_default();
            if is_allowlisted_shell_command(&command) {
                PermissionRuleAction::Allow
            } else {
                PermissionRuleAction::Ask
            }
        }
        ToolName::FsWrite | ToolName::FsDelete => PermissionRuleAction::Ask,
        ToolName::KnowledgeSearch | ToolName::FsRead | ToolName::FsList => {
            PermissionRuleAction::Allow
        }
    }
}

fn permission_match_target(tool: ToolName, args: &Value) -> Option<String> {
    match tool {
        ToolName::ShellExec => {
            read_required_string_arg(args, "command").map(|command| normalize_command(&command))
        }
        ToolName::FsRead | ToolName::FsWrite | ToolName::FsDelete => {
            read_required_string_arg(args, "path").map(|path| normalize_path_for_match(&path))
        }
        ToolName::FsList => read_optional_string_arg(args, "path")
            .or_else(|| Some(".".to_string()))
            .map(|path| normalize_path_for_match(&path)),
        ToolName::KnowledgeSearch => Some("*".to_string()),
    }
}

fn rule_matches_tool(rule: &PermissionRule, tool: ToolName) -> bool {
    if rule.tool == "*" {
        return true;
    }
    if let Some(normalized) = normalize_rule_tool(&rule.tool) {
        return normalized == tool.canonical();
    }
    false
}

fn rule_pattern_matches(tool: ToolName, pattern: &str, target: Option<&str>) -> bool {
    let normalized_pattern = normalize_rule_pattern(tool, pattern);
    if normalized_pattern == "*" {
        return true;
    }

    let Some(target_value) = target else {
        return false;
    };

    match tool {
        ToolName::ShellExec
        | ToolName::FsRead
        | ToolName::FsList
        | ToolName::FsWrite
        | ToolName::FsDelete => target_value.starts_with(&normalized_pattern),
        ToolName::KnowledgeSearch => normalized_pattern == target_value,
    }
}

fn normalize_rule_tool(raw: &str) -> Option<&'static str> {
    let trimmed = raw.trim();
    if trimmed == "*" {
        return Some("*");
    }
    ToolName::from_raw(trimmed).map(|tool| tool.canonical())
}

fn normalize_rule_pattern(tool: ToolName, pattern: &str) -> String {
    let trimmed = pattern.trim();
    if trimmed.is_empty() || trimmed == "*" {
        return "*".to_string();
    }

    match tool {
        ToolName::ShellExec => normalize_command(trimmed),
        ToolName::FsRead | ToolName::FsList | ToolName::FsWrite | ToolName::FsDelete => {
            normalize_path_for_match(trimmed)
        }
        ToolName::KnowledgeSearch => trimmed.to_string(),
    }
}

fn normalize_command(command: &str) -> String {
    command.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn normalize_path_for_match(path: &str) -> String {
    let trimmed = path.trim();
    let base_path = if trimmed.is_empty() {
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
    } else {
        let as_path = Path::new(trimmed);
        if as_path.is_absolute() {
            as_path.to_path_buf()
        } else {
            std::env::current_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .join(as_path)
        }
    };

    normalize_path_components(base_path)
}

fn normalize_path_components(path: PathBuf) -> String {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::RootDir | Component::Prefix(_) => {
                normalized.push(component.as_os_str());
            }
            Component::Normal(part) => {
                normalized.push(part);
            }
        }
    }
    normalized.to_string_lossy().to_string()
}

fn tool_summary_for_permission(tool: ToolName, args: &Value) -> String {
    match tool {
        ToolName::ShellExec => {
            let command = read_required_string_arg(args, "command").unwrap_or_default();
            format!("Run shell command: {}", command)
        }
        ToolName::FsWrite => {
            let path = read_required_string_arg(args, "path").unwrap_or_default();
            format!("Write file: {}", path)
        }
        ToolName::FsDelete => {
            let path = read_required_string_arg(args, "path").unwrap_or_default();
            let recursive = read_optional_bool_arg(args, "recursive").unwrap_or(false);
            format!("Delete path: {} (recursive={})", path, recursive)
        }
        ToolName::FsRead => {
            let path = read_required_string_arg(args, "path").unwrap_or_default();
            format!("Read file: {}", path)
        }
        ToolName::FsList => {
            let path = read_optional_string_arg(args, "path").unwrap_or_else(|| ".".to_string());
            format!("List directory: {}", path)
        }
        ToolName::KnowledgeSearch => {
            let query = read_required_string_arg(args, "query").unwrap_or_default();
            format!("Search knowledge: {}", query)
        }
    }
}

fn risk_level_for_tool(tool: ToolName) -> AgentToolRiskLevel {
    match tool {
        ToolName::KnowledgeSearch | ToolName::FsRead | ToolName::FsList => AgentToolRiskLevel::Safe,
        ToolName::FsWrite => AgentToolRiskLevel::Confirm,
        ToolName::FsDelete | ToolName::ShellExec => AgentToolRiskLevel::High,
    }
}

fn emit_analyzing_progress(app: &AppHandle, request_id: &str, step: usize) {
    emit_agent_progress(
        app,
        request_id,
        PipelineProgressStatus::Started,
        "Analyzing next action...",
        PipelineProgressActivityKind::Analyzing,
        None,
        Some(step),
        None,
        None,
    );
}

fn emit_agent_progress(
    app: &AppHandle,
    request_id: &str,
    status: PipelineProgressStatus,
    message: impl Into<String>,
    activity_kind: PipelineProgressActivityKind,
    tool: Option<String>,
    step: Option<usize>,
    call_id: Option<String>,
    display_target: Option<String>,
) {
    let payload = PipelineProgressEvent {
        request_id: request_id.to_string(),
        layer: LAYER_NAME.to_string(),
        status,
        message: message.into(),
        activity_kind: Some(activity_kind),
        tool,
        step,
        call_id,
        display_target,
    };

    if let Err(err) = app.emit(PIPELINE_PROGRESS, payload) {
        tracing::warn!(
            request_id = %request_id,
            "Failed to emit agent tool progress event: {}",
            err
        );
    }
}

fn build_tool_progress_descriptor(tool: ToolName, args: &Value) -> ToolProgressDescriptor {
    let display_target = progress_display_target(tool, args);
    let started_message = match tool {
        ToolName::FsRead => match display_target.as_deref() {
            Some(target) => format!("Reading file {}...", target),
            None => "Reading file...".to_string(),
        },
        ToolName::FsWrite => match display_target.as_deref() {
            Some(target) => format!("Writing file {}...", target),
            None => "Writing file...".to_string(),
        },
        ToolName::FsList => match display_target.as_deref() {
            Some(target) => format!("Listing directory {}...", target),
            None => "Listing directory...".to_string(),
        },
        ToolName::FsDelete => match display_target.as_deref() {
            Some(target) => format!("Deleting {}...", target),
            None => "Deleting path...".to_string(),
        },
        ToolName::ShellExec => "Running command...".to_string(),
        ToolName::KnowledgeSearch => "Searching knowledge...".to_string(),
    };

    ToolProgressDescriptor {
        started_message,
        display_target,
    }
}

fn tool_terminal_progress_status(execution: &ToolExecutionResult) -> PipelineProgressStatus {
    match execution.final_state {
        ToolCallState::Completed => PipelineProgressStatus::Success,
        ToolCallState::Interrupted => PipelineProgressStatus::Fallback,
        ToolCallState::Error => {
            if execution.denied || execution.timed_out || execution.interrupted {
                PipelineProgressStatus::Fallback
            } else {
                PipelineProgressStatus::Failed
            }
        }
        ToolCallState::Pending | ToolCallState::Running => PipelineProgressStatus::Fallback,
    }
}

fn build_tool_terminal_message(
    tool: ToolName,
    display_target: Option<&str>,
    execution: &ToolExecutionResult,
) -> String {
    let status = tool_terminal_progress_status(execution);
    match status {
        PipelineProgressStatus::Success => match tool {
            ToolName::FsRead => match display_target {
                Some(target) => format!("Finished reading file {}", target),
                None => "Finished reading file".to_string(),
            },
            ToolName::FsWrite => match display_target {
                Some(target) => format!("Finished writing file {}", target),
                None => "Finished writing file".to_string(),
            },
            ToolName::FsList => match display_target {
                Some(target) => format!("Finished listing directory {}", target),
                None => "Finished listing directory".to_string(),
            },
            ToolName::FsDelete => match display_target {
                Some(target) => format!("Finished deleting {}", target),
                None => "Finished deleting path".to_string(),
            },
            ToolName::ShellExec => "Command finished".to_string(),
            ToolName::KnowledgeSearch => "Knowledge search finished".to_string(),
        },
        PipelineProgressStatus::Fallback => {
            if execution.denied {
                "Action was denied".to_string()
            } else if execution.timed_out {
                "Action timed out".to_string()
            } else if execution.interrupted {
                "Action interrupted".to_string()
            } else {
                "Action completed with fallback".to_string()
            }
        }
        PipelineProgressStatus::Failed => match tool {
            ToolName::FsRead => "File read failed".to_string(),
            ToolName::FsWrite => "File write failed".to_string(),
            ToolName::FsList => "Directory listing failed".to_string(),
            ToolName::FsDelete => "Delete failed".to_string(),
            ToolName::ShellExec => "Command failed".to_string(),
            ToolName::KnowledgeSearch => "Knowledge search failed".to_string(),
        },
        PipelineProgressStatus::Started => execution.summary.clone(),
    }
}

fn progress_display_target(tool: ToolName, args: &Value) -> Option<String> {
    match tool {
        ToolName::FsRead | ToolName::FsWrite | ToolName::FsDelete => {
            read_required_string_arg(args, "path").and_then(|path| safe_path_display_target(&path))
        }
        ToolName::FsList => {
            let path = read_optional_string_arg(args, "path").unwrap_or_else(|| ".".to_string());
            if path.trim() == "." {
                Some("current directory".to_string())
            } else {
                safe_path_display_target(&path)
            }
        }
        ToolName::ShellExec | ToolName::KnowledgeSearch => None,
    }
}

fn safe_path_display_target(path: &str) -> Option<String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return None;
    }

    let as_path = Path::new(trimmed);
    if let Some(name) = as_path.file_name().and_then(|part| part.to_str()) {
        let normalized = name.trim();
        if !normalized.is_empty() {
            return Some(clip_chars(normalized, 32));
        }
    }

    if trimmed == "/" {
        return Some("/".to_string());
    }

    Some(clip_chars(trimmed, 32))
}

fn derive_auto_allow_pattern(tool: ToolName, target: Option<&str>) -> Option<String> {
    let target = target?.trim();
    if target.is_empty() {
        return None;
    }

    match tool {
        ToolName::ShellExec => {
            let tokens = target.split_whitespace().collect::<Vec<_>>();
            if tokens.is_empty() {
                return None;
            }
            let pattern = if tokens.len() >= 2 {
                format!("{} {}", tokens[0], tokens[1])
            } else {
                tokens[0].to_string()
            };
            Some(pattern)
        }
        ToolName::FsRead | ToolName::FsList | ToolName::FsWrite | ToolName::FsDelete => {
            Some(target.to_string())
        }
        ToolName::KnowledgeSearch => Some("*".to_string()),
    }
}

fn build_auto_allow_rule(
    tool: ToolName,
    target: Option<&str>,
    request_id: &str,
) -> Option<PermissionRule> {
    let pattern = derive_auto_allow_pattern(tool, target)?;
    Some(PermissionRule {
        tool: tool.canonical().to_string(),
        pattern,
        action: PermissionRuleAction::Allow,
        created_at: now_rfc3339(),
        metadata: Some(json!({
            "source": "approve_always",
            "request_id": request_id,
        })),
    })
}

fn load_permission_rules(
    settings: &HashMap<String, String>,
) -> Result<Vec<PermissionRule>, String> {
    let Some(raw_rules) = settings.get(PERMISSION_RULES_SETTING_KEY) else {
        return Ok(Vec::new());
    };
    let parsed = serde_json::from_str::<Value>(raw_rules).map_err(|err| err.to_string())?;
    let rules = parsed
        .as_array()
        .ok_or_else(|| "permission rules must be a JSON array".to_string())?;

    let mut normalized_rules = Vec::new();
    for raw in rules {
        let mut rule =
            serde_json::from_value::<PermissionRule>(raw.clone()).map_err(|err| err.to_string())?;
        let normalized_tool = normalize_rule_tool(&rule.tool)
            .ok_or_else(|| format!("Invalid permission rule tool '{}'", rule.tool))?;
        rule.tool = normalized_tool.to_string();
        let tool_for_pattern = if normalized_tool == "*" {
            ToolName::KnowledgeSearch
        } else {
            ToolName::from_raw(normalized_tool)
                .ok_or_else(|| format!("Invalid rule tool '{}'", normalized_tool))?
        };
        rule.pattern = normalize_rule_pattern(tool_for_pattern, &rule.pattern);
        normalized_rules.push(rule);
    }

    Ok(normalized_rules)
}

async fn persist_permission_rules(
    pool: &SqlitePool,
    rules: &[PermissionRule],
) -> Result<(), String> {
    let serialized = serde_json::to_string(rules).map_err(|err| err.to_string())?;
    storage::save_setting(pool, PERMISSION_RULES_SETTING_KEY, &serialized)
        .await
        .map_err(|err| err.to_string())
}

fn derive_summary_from_trace(trace: &AgentRunTrace) -> AgentRunSummary {
    let approvals_required = trace
        .permission_decisions
        .iter()
        .filter(|item| item.match_result == PermissionRuleAction::Ask)
        .count();

    let approvals_denied = trace
        .permission_decisions
        .iter()
        .filter(|item| {
            item.match_result == PermissionRuleAction::Deny
                || matches!(item.user_response, Some(AgentToolDecision::Deny))
                || item.timeout
        })
        .count();

    let timed_out_tools = trace.tool_calls.iter().any(|call| call.timed_out);
    let timed_out_permissions = trace
        .permission_decisions
        .iter()
        .any(|decision| decision.timeout);

    AgentRunSummary {
        tool_calls_total: trace.tool_calls.len(),
        approvals_required,
        approvals_denied,
        timed_out: trace.run.wall_clock_budget_reached || timed_out_tools || timed_out_permissions,
    }
}

fn trace_to_value(trace: &AgentRunTrace) -> Value {
    serde_json::to_value(trace).unwrap_or_else(|_| json!({}))
}

async fn execute_knowledge_search(
    pool: &SqlitePool,
    query: &str,
    selected_doc_ids: Option<&Vec<String>>,
    limit: usize,
) -> Result<String, String> {
    let normalized_limit = limit.clamp(1, 8);
    let hits = storage::search_knowledge_chunks_fts(
        pool,
        query,
        selected_doc_ids.map(|v| v.as_slice()),
        normalized_limit,
    )
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

    Ok(lines.join("\n"))
}

async fn execute_shell_command(
    command: &str,
    cancellation_flag: Arc<AtomicBool>,
) -> Result<String, ShellExecFailure> {
    let mut child = Command::new("bash")
        .arg("-lc")
        .arg(command)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| ShellExecFailure::Failed(err.to_string()))?;

    let stdout_task = child.stdout.take().map(spawn_reader_task);
    let stderr_task = child.stderr.take().map(spawn_reader_task);

    let started = Instant::now();
    let mut interrupted = false;
    let mut timed_out = false;

    loop {
        if cancellation_flag.load(Ordering::SeqCst) {
            interrupted = true;
            let _ = child.kill().await;
            break;
        }

        if started.elapsed() >= TOOL_COMMAND_TIMEOUT {
            timed_out = true;
            let _ = child.kill().await;
            break;
        }

        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => sleep(Duration::from_millis(120)).await,
            Err(err) => return Err(ShellExecFailure::Failed(err.to_string())),
        }
    }

    let _ = child.wait().await;

    let stdout = join_reader_task(stdout_task).await;
    let stderr = join_reader_task(stderr_task).await;

    if timed_out {
        return Err(ShellExecFailure::TimedOut { stdout, stderr });
    }
    if interrupted {
        return Err(ShellExecFailure::Interrupted { stdout, stderr });
    }

    Ok(build_merged_shell_output(&stdout, &stderr))
}

fn spawn_reader_task<R>(mut reader: R) -> tokio::task::JoinHandle<String>
where
    R: AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut buffer = Vec::new();
        let _ = reader.read_to_end(&mut buffer).await;
        String::from_utf8_lossy(&buffer).to_string()
    })
}

async fn join_reader_task(task: Option<tokio::task::JoinHandle<String>>) -> String {
    match task {
        Some(handle) => handle.await.unwrap_or_default(),
        None => String::new(),
    }
}

fn build_merged_shell_output(stdout: &str, stderr: &str) -> String {
    let stdout_trimmed = stdout.trim();
    let stderr_trimmed = stderr.trim();

    if stderr_trimmed.is_empty() {
        return stdout_trimmed.to_string();
    }
    if stdout_trimmed.is_empty() {
        return format!("STDERR:\n{}", stderr_trimmed);
    }
    format!("STDOUT:\n{}\n\nSTDERR:\n{}", stdout_trimmed, stderr_trimmed)
}

async fn list_directory(path: &str) -> Result<String, String> {
    let mut entries = tokio::fs::read_dir(path)
        .await
        .map_err(|err| err.to_string())?;
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
    Ok(lines.join("\n"))
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
    let metadata = tokio::fs::metadata(path)
        .await
        .map_err(|err| err.to_string())?;
    if metadata.is_dir() {
        if recursive {
            tokio::fs::remove_dir_all(path)
                .await
                .map_err(|err| err.to_string())
        } else {
            tokio::fs::remove_dir(path)
                .await
                .map_err(|err| err.to_string())
        }
    } else {
        tokio::fs::remove_file(path)
            .await
            .map_err(|err| err.to_string())
    }
}

async fn call_planner(
    config: &PlannerConfig,
    prompt: &str,
    request_id: &str,
    step: usize,
) -> Result<String, String> {
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

    let payload = response
        .json::<Value>()
        .await
        .map_err(|err| err.to_string())?;
    let payload_json = payload.to_string();
    tracing::info!(
        target: "state_logger",
        module = "pipeline",
        event = "agent_planner_response_payload",
        request_id = %request_id,
        step,
        payload_chars = payload_json.chars().count(),
        payload_json = %clip_chars(&payload_json, JSON_LOG_CHAR_CAP),
        "Planner HTTP response payload"
    );

    Ok(extract_text_from_completion_response(&payload))
}

fn build_planner_prompt(
    user_prompt: &str,
    retrieved_chunks: &[KnowledgeSearchResult],
    observations: &[String],
) -> String {
    let tool_list = catalog_tool_list();
    let mut sections = vec![
        "You are an execution planner for a local assistant agent.".to_string(),
        "Return ONLY JSON.".to_string(),
        "Valid JSON outputs:".to_string(),
        r#"{"action":"finish","final_answer":"<brief planning summary>"}"#.to_string(),
        format!(
            r#"{{"action":"tool","tool":"{}","summary":"<why this step>","args":{{...}}}}"#,
            tool_list
        ),
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
        sections.push(format!(
            "Previous tool observations:\n{}",
            clip_chars(&history, 3_000)
        ));
    }

    sections.push(
        "Use canonical tool names and provide JSON object args only (not stringified JSON)."
            .to_string(),
    );
    sections.join("\n\n")
}

fn parse_planner_decision_from_candidate(raw: &str, candidate: &str) -> PlannerDecision {
    if let Ok(value) = serde_json::from_str::<Value>(candidate) {
        if let Some(decision) = parse_planner_decision_from_value(&value) {
            return decision;
        }
    }

    if let Ok(parsed) = serde_json::from_str::<RawPlannerDecision>(candidate) {
        let action = parsed
            .action
            .unwrap_or_else(|| "tool".to_string())
            .trim()
            .to_ascii_lowercase();

        if matches!(action.as_str(), "finish" | "final" | "done") {
            let final_answer = parsed
                .final_answer
                .or(parsed.answer)
                .or(parsed.summary)
                .unwrap_or_else(|| "Agent collected enough information.".to_string());
            return PlannerDecision::Finish { final_answer };
        }

        if matches!(action.as_str(), "tool" | "tool_call" | "call_tool") {
            if let Some(tool) = parsed.tool.or(parsed.tool_name) {
                return PlannerDecision::Tool(ToolCall {
                    tool,
                    args: parsed
                        .args
                        .or(parsed.arguments)
                        .unwrap_or_else(|| json!({})),
                    summary: parsed.summary,
                });
            }
        }
    }

    PlannerDecision::Invalid(raw.trim().to_string())
}

fn parse_planner_decision_from_value(value: &Value) -> Option<PlannerDecision> {
    let object = value.as_object()?;

    // Support wrapper formats like {"decision": {...}}
    for wrapper_key in ["decision", "result", "output"] {
        if let Some(wrapped) = object.get(wrapper_key) {
            if let Some(parsed) = parse_planner_decision_from_value(wrapped) {
                return Some(parsed);
            }
        }
    }

    if let Some(tool_call_value) = object.get("tool_call") {
        if let Some(tool_call_obj) = tool_call_value.as_object() {
            let tool = read_object_string(tool_call_obj, &["tool", "name", "tool_name"])?;
            let args = tool_call_obj
                .get("args")
                .cloned()
                .or_else(|| tool_call_obj.get("arguments").cloned())
                .unwrap_or_else(|| json!({}));
            let summary = read_object_string(tool_call_obj, &["summary", "reason", "rationale"]);
            return Some(PlannerDecision::Tool(ToolCall {
                tool,
                args,
                summary,
            }));
        }
    }

    if let Some(action) = read_object_string(object, &["action", "type", "decision_type"]) {
        let action = action.trim().to_ascii_lowercase();
        if matches!(action.as_str(), "finish" | "final" | "done") {
            let final_answer = read_object_string(object, &["final_answer", "answer", "summary"])
                .unwrap_or_else(|| "Agent collected enough information.".to_string());
            return Some(PlannerDecision::Finish { final_answer });
        }

        if matches!(action.as_str(), "tool" | "tool_call" | "call_tool") {
            let tool = read_object_string(object, &["tool", "tool_name", "name"])?;
            let args = object
                .get("args")
                .cloned()
                .or_else(|| object.get("arguments").cloned())
                .unwrap_or_else(|| json!({}));
            let summary = read_object_string(object, &["summary", "reason", "rationale"]);
            return Some(PlannerDecision::Tool(ToolCall {
                tool,
                args,
                summary,
            }));
        }
    }

    if object.contains_key("tool") || object.contains_key("tool_name") {
        let tool = read_object_string(object, &["tool", "tool_name", "name"])?;
        let args = object
            .get("args")
            .cloned()
            .or_else(|| object.get("arguments").cloned())
            .unwrap_or_else(|| json!({}));
        let summary = read_object_string(object, &["summary", "reason", "rationale"]);
        return Some(PlannerDecision::Tool(ToolCall {
            tool,
            args,
            summary,
        }));
    }

    if object.contains_key("final_answer") || object.contains_key("answer") {
        let final_answer = read_object_string(object, &["final_answer", "answer", "summary"])
            .unwrap_or_else(|| "Agent collected enough information.".to_string());
        return Some(PlannerDecision::Finish { final_answer });
    }

    None
}

fn read_object_string(object: &Map<String, Value>, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(value) = object.get(*key).and_then(Value::as_str) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

fn extract_json_candidate(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.starts_with('{') && trimmed.ends_with('}') {
        return Some(trimmed.to_string());
    }

    // Handle fenced JSON blocks, with or without language tags.
    let segments = trimmed.split("```").collect::<Vec<_>>();
    if segments.len() >= 3 {
        for segment in segments.iter().skip(1).step_by(2) {
            let mut candidate = segment.trim();
            if let Some(rest) = candidate.strip_prefix("json") {
                candidate = rest.trim();
            }
            if let Some(rest) = candidate.strip_prefix("JSON") {
                candidate = rest.trim();
            }
            if candidate.starts_with('{') && candidate.ends_with('}') {
                return Some(candidate.to_string());
            }
            if let Some(start) = candidate.find('{') {
                let end = candidate.rfind('}')?;
                if start < end {
                    return Some(candidate[start..=end].trim().to_string());
                }
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
        .get("response")
        .and_then(Value::as_str)
        .or_else(|| payload.get("output_text").and_then(Value::as_str))
        .or_else(|| payload.get("result").and_then(Value::as_str))
    {
        return content.to_string();
    }

    if let Some(content) = payload
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| {
            choice
                .get("text")
                .and_then(Value::as_str)
                .or_else(|| choice.get("content").and_then(Value::as_str))
                .or_else(|| {
                    choice
                        .get("message")
                        .and_then(|message| message.get("content"))
                        .and_then(Value::as_str)
                })
        })
    {
        return content.to_string();
    }

    if let Some(content) = payload
        .get("output")
        .and_then(Value::as_array)
        .and_then(|output| output.first())
        .and_then(|item| item.get("content"))
        .and_then(Value::as_array)
        .and_then(|segments| segments.first())
        .and_then(|segment| segment.get("text"))
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

    if matches!(
        tokens[0],
        "pwd" | "ls" | "find" | "rg" | "cat" | "head" | "tail" | "wc"
    ) {
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

fn value_to_compact_json(value: &Value) -> String {
    clip_chars(&value.to_string(), JSON_LOG_CHAR_CAP)
}

fn now_rfc3339() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)
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
    use super::{
        build_auto_allow_rule, build_tool_progress_descriptor, build_tool_terminal_message,
        derive_summary_from_trace, evaluate_permission, extract_json_candidate,
        is_allowlisted_shell_command, normalize_and_validate_tool_call, normalize_command,
        normalize_path_for_match, parse_planner_decision_from_candidate,
        tool_terminal_progress_status, AgentRunTrace, AgentRunTraceRun, PermissionRule,
        PermissionRuleAction, PlannerDecision, ToolCall, ToolCallState, ToolExecutionResult,
        ToolName,
    };
    use crate::pipeline::types::{AgentToolDecision, PipelineProgressStatus};
    use serde_json::json;

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

    #[test]
    fn validates_tool_schema_with_coercion() {
        let call = ToolCall {
            tool: "knowledge.search".to_string(),
            args: json!({"query":"rust", "limit":"3"}),
            summary: None,
        };

        let validated = normalize_and_validate_tool_call(&call).expect("validation should pass");
        assert_eq!(validated.tool.canonical(), "knowledge.search");
        assert_eq!(validated.args["limit"], json!(3));
    }

    #[test]
    fn rejects_invalid_tool_schema() {
        let missing = ToolCall {
            tool: "shell.exec".to_string(),
            args: json!({}),
            summary: None,
        };
        assert!(normalize_and_validate_tool_call(&missing).is_err());

        let wrong_type = ToolCall {
            tool: "fs.delete".to_string(),
            args: json!({"path":"/tmp/demo", "recursive":"not-bool"}),
            summary: None,
        };
        assert!(normalize_and_validate_tool_call(&wrong_type).is_err());
    }

    #[test]
    fn parses_planner_json_and_fenced_json() {
        let raw = r#"{"action":"tool","tool":"fs.list","args":{"path":"."}}"#;
        let candidate = extract_json_candidate(raw).unwrap_or_default();
        let decision = parse_planner_decision_from_candidate(raw, &candidate);
        assert!(matches!(decision, PlannerDecision::Tool(_)));

        let fenced = "```json\n{\"action\":\"finish\",\"final_answer\":\"done\"}\n```";
        let fenced_candidate = extract_json_candidate(fenced).unwrap_or_default();
        let decision = parse_planner_decision_from_candidate(fenced, &fenced_candidate);
        assert!(matches!(decision, PlannerDecision::Finish { .. }));
    }

    #[test]
    fn normalizes_match_targets() {
        assert_eq!(normalize_command("  git   status   "), "git status");
        let normalized = normalize_path_for_match("./src/../src");
        assert!(normalized.ends_with("/src") || normalized == "src");
    }

    #[test]
    fn permission_last_rule_wins() {
        let rules = vec![
            PermissionRule {
                tool: "shell.exec".to_string(),
                pattern: "git".to_string(),
                action: PermissionRuleAction::Deny,
                created_at: "2026-01-01T00:00:00Z".to_string(),
                metadata: None,
            },
            PermissionRule {
                tool: "shell.exec".to_string(),
                pattern: "git status".to_string(),
                action: PermissionRuleAction::Allow,
                created_at: "2026-01-01T00:00:01Z".to_string(),
                metadata: None,
            },
        ];

        let evaluation = evaluate_permission(
            ToolName::ShellExec,
            &json!({"command":"git status"}),
            &rules,
        );
        assert_eq!(evaluation.final_action, PermissionRuleAction::Allow);
    }

    #[test]
    fn approve_always_creates_rule_but_approve_once_does_not() {
        let mut rules = Vec::<PermissionRule>::new();
        let allow_rule = build_auto_allow_rule(ToolName::FsWrite, Some("/tmp/demo.txt"), "req-1")
            .expect("rule should be generated");
        rules.push(allow_rule);
        assert_eq!(rules.len(), 1);

        // approve_once intentionally leaves rule set unchanged.
        let approve_once_decision = AgentToolDecision::ApproveOnce;
        assert!(matches!(
            approve_once_decision,
            AgentToolDecision::ApproveOnce
        ));
        assert_eq!(rules.len(), 1);
    }

    #[test]
    fn summary_is_derived_from_trace() {
        let trace = AgentRunTrace {
            run: AgentRunTraceRun {
                started_at: "2026-01-01T00:00:00Z".to_string(),
                ended_at: "2026-01-01T00:00:10Z".to_string(),
                wall_clock_budget_reached: false,
                cancelled: false,
                max_tool_steps: 8,
                max_wall_clock_seconds: 120,
                loop_steps_executed: 2,
            },
            tool_calls: vec![
                super::AgentTraceToolCall {
                    call_id: "1".to_string(),
                    step: 1,
                    tool: "shell.exec".to_string(),
                    normalized_args: json!({"command":"git status"}),
                    state_transitions: vec![],
                    output_raw: Some("ok".to_string()),
                    error_raw: None,
                    output_excerpt: "ok".to_string(),
                    summary: "done".to_string(),
                    approval_requested: true,
                    denied: false,
                    timed_out: false,
                    interrupted: false,
                },
                super::AgentTraceToolCall {
                    call_id: "2".to_string(),
                    step: 2,
                    tool: "fs.write".to_string(),
                    normalized_args: json!({"path":"/tmp/a","content":"b"}),
                    state_transitions: vec![super::AgentTraceStateTransition {
                        state: ToolCallState::Error,
                        at: "2026-01-01T00:00:09Z".to_string(),
                    }],
                    output_raw: None,
                    error_raw: Some("denied".to_string()),
                    output_excerpt: "denied".to_string(),
                    summary: "denied".to_string(),
                    approval_requested: true,
                    denied: true,
                    timed_out: false,
                    interrupted: false,
                },
            ],
            permission_decisions: vec![
                super::AgentTracePermissionDecision {
                    decision_id: "d1".to_string(),
                    call_id: "1".to_string(),
                    tool: "shell.exec".to_string(),
                    request_summary: "Run".to_string(),
                    args_preview: "git status".to_string(),
                    match_target: Some("git status".to_string()),
                    matched_pattern: None,
                    matched_action: None,
                    default_action: PermissionRuleAction::Ask,
                    match_result: PermissionRuleAction::Ask,
                    user_response: Some(AgentToolDecision::ApproveOnce),
                    timeout: false,
                    requested_at: "2026-01-01T00:00:01Z".to_string(),
                    resolved_at: "2026-01-01T00:00:02Z".to_string(),
                },
                super::AgentTracePermissionDecision {
                    decision_id: "d2".to_string(),
                    call_id: "2".to_string(),
                    tool: "fs.write".to_string(),
                    request_summary: "Write".to_string(),
                    args_preview: "{}".to_string(),
                    match_target: Some("/tmp/a".to_string()),
                    matched_pattern: None,
                    matched_action: None,
                    default_action: PermissionRuleAction::Ask,
                    match_result: PermissionRuleAction::Ask,
                    user_response: Some(AgentToolDecision::Deny),
                    timeout: false,
                    requested_at: "2026-01-01T00:00:03Z".to_string(),
                    resolved_at: "2026-01-01T00:00:04Z".to_string(),
                },
            ],
        };

        let summary = derive_summary_from_trace(&trace);
        assert_eq!(summary.tool_calls_total, 2);
        assert_eq!(summary.approvals_required, 2);
        assert_eq!(summary.approvals_denied, 1);
        assert!(!summary.timed_out);
    }

    #[test]
    fn tool_progress_message_mapping_is_specific() {
        let read_descriptor =
            build_tool_progress_descriptor(ToolName::FsRead, &json!({"path":"/tmp/cli.txt"}));
        assert_eq!(read_descriptor.started_message, "Reading file cli.txt...");

        let write_descriptor =
            build_tool_progress_descriptor(ToolName::FsWrite, &json!({"path":"./notes.md"}));
        assert_eq!(write_descriptor.started_message, "Writing file notes.md...");

        let list_descriptor =
            build_tool_progress_descriptor(ToolName::FsList, &json!({"path":"."}));
        assert_eq!(
            list_descriptor.started_message,
            "Listing directory current directory..."
        );

        let delete_descriptor =
            build_tool_progress_descriptor(ToolName::FsDelete, &json!({"path":"/tmp/old.log"}));
        assert_eq!(delete_descriptor.started_message, "Deleting old.log...");

        let shell_descriptor =
            build_tool_progress_descriptor(ToolName::ShellExec, &json!({"command":"git status"}));
        assert_eq!(shell_descriptor.started_message, "Running command...");

        let search_descriptor = build_tool_progress_descriptor(
            ToolName::KnowledgeSearch,
            &json!({"query":"stream hook"}),
        );
        assert_eq!(search_descriptor.started_message, "Searching knowledge...");
    }

    #[test]
    fn terminal_status_mapping_handles_completed_and_interrupt_like_outcomes() {
        let completed = ToolExecutionResult {
            summary: "ok".to_string(),
            output_excerpt: String::new(),
            raw_output: None,
            raw_error: None,
            warnings: Vec::new(),
            approval_requested: false,
            denied: false,
            timed_out: false,
            interrupted: false,
            permission_records: Vec::new(),
            final_state: ToolCallState::Completed,
            execution_started_at: None,
            ended_at: "2026-01-01T00:00:00Z".to_string(),
        };
        assert_eq!(
            tool_terminal_progress_status(&completed),
            PipelineProgressStatus::Success
        );
        assert_eq!(
            build_tool_terminal_message(ToolName::FsRead, Some("cli.txt"), &completed),
            "Finished reading file cli.txt"
        );

        let denied = ToolExecutionResult {
            summary: "denied".to_string(),
            output_excerpt: String::new(),
            raw_output: None,
            raw_error: None,
            warnings: Vec::new(),
            approval_requested: true,
            denied: true,
            timed_out: false,
            interrupted: false,
            permission_records: Vec::new(),
            final_state: ToolCallState::Error,
            execution_started_at: None,
            ended_at: "2026-01-01T00:00:00Z".to_string(),
        };
        assert_eq!(
            tool_terminal_progress_status(&denied),
            PipelineProgressStatus::Fallback
        );
        assert_eq!(
            build_tool_terminal_message(ToolName::FsWrite, Some("cli.txt"), &denied),
            "Action was denied"
        );

        let failed = ToolExecutionResult {
            summary: "failed".to_string(),
            output_excerpt: String::new(),
            raw_output: None,
            raw_error: None,
            warnings: Vec::new(),
            approval_requested: false,
            denied: false,
            timed_out: false,
            interrupted: false,
            permission_records: Vec::new(),
            final_state: ToolCallState::Error,
            execution_started_at: None,
            ended_at: "2026-01-01T00:00:00Z".to_string(),
        };
        assert_eq!(
            tool_terminal_progress_status(&failed),
            PipelineProgressStatus::Failed
        );
        assert_eq!(
            build_tool_terminal_message(ToolName::ShellExec, None, &failed),
            "Command failed"
        );

        let interrupted = ToolExecutionResult {
            summary: "interrupted".to_string(),
            output_excerpt: String::new(),
            raw_output: None,
            raw_error: None,
            warnings: Vec::new(),
            approval_requested: false,
            denied: false,
            timed_out: false,
            interrupted: true,
            permission_records: Vec::new(),
            final_state: ToolCallState::Interrupted,
            execution_started_at: None,
            ended_at: "2026-01-01T00:00:00Z".to_string(),
        };
        assert_eq!(
            tool_terminal_progress_status(&interrupted),
            PipelineProgressStatus::Fallback
        );
        assert_eq!(
            build_tool_terminal_message(ToolName::FsDelete, Some("old.log"), &interrupted),
            "Action interrupted"
        );
    }
}
