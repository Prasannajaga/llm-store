use std::sync::atomic::Ordering;

use serde_json::Value;
use tauri::{AppHandle, State};

use crate::commands::streaming::GenerationState;
use crate::error::AppError;
use crate::pipeline::orchestrator;
use crate::pipeline::types::{
    AgentToolDecision, InteractionMode, PipelineCommandAck, PipelineRequest,
};
use crate::state_logger;
use crate::storage::AppState;

#[tauri::command]
pub fn log_prompt_preview(
    prompt: String,
    request_id: Option<String>,
    mode: Option<String>,
) -> Result<(), AppError> {
    let normalized_request_id = request_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("rust_v1");
    let normalized_mode = mode
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("rust_v1");

    tracing::info!(
        target: "state_logger",
        module = "pipeline",
        event = "raw_prompt_plain",
        request_id = %normalized_request_id,
        mode = %normalized_mode,
        prompt_chars = prompt.chars().count(),
        prompt = %prompt,
        "Raw prompt captured before generation"
    );

    Ok(())
}

#[tauri::command]
pub fn log_llama_request_payload(
    endpoint_url: String,
    payload: Value,
    request_id: Option<String>,
    mode: Option<String>,
) -> Result<(), AppError> {
    let normalized_request_id = request_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("rust_v1");
    let normalized_mode = mode
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("rust_v1");

    tracing::info!(
        target: "state_logger",
        module = "pipeline",
        event = "llama_completion_request_payload",
        request_id = %normalized_request_id,
        mode = %normalized_mode,
        endpoint_url = %endpoint_url,
        payload = %payload,
        "Exact JSON payload sent to llama-server /completion"
    );

    Ok(())
}

#[tauri::command]
pub async fn run_chat_pipeline(
    app: AppHandle,
    state: State<'_, AppState>,
    generation_state: State<'_, GenerationState>,
    request: PipelineRequest,
) -> Result<PipelineCommandAck, AppError> {
    if request.request_id.trim().is_empty() {
        return Err(AppError::Config(
            "run_chat_pipeline requires a non-empty request_id".to_string(),
        ));
    }
    if request.chat_id.trim().is_empty() {
        return Err(AppError::Config(
            "run_chat_pipeline requires a non-empty chat_id".to_string(),
        ));
    }

    generation_state.is_cancelled.store(false, Ordering::SeqCst);
    let interaction_mode = request.interaction_mode.unwrap_or(InteractionMode::Chat);
    tracing::info!(
        target: "state_logger",
        module = "pipeline",
        event = "command_received",
        request_id = %request.request_id,
        chat_id = %request.chat_id,
        interaction_mode = %match interaction_mode {
            InteractionMode::Chat => "chat",
            InteractionMode::Agent => "agent",
        },
        "run_chat_pipeline command received"
    );

    let app_handle = app.clone();
    let pool = state.db.clone();
    let cancel_flag = generation_state.is_cancelled.clone();
    let decision_state = generation_state.inner().clone();
    let request_id = request.request_id.clone();

    tauri::async_runtime::spawn(async move {
        if let Err(err) =
            orchestrator::run_and_emit(&app_handle, &pool, cancel_flag, decision_state, request)
                .await
        {
            state_logger::pipeline_failed(&err);
        }
    });

    Ok(PipelineCommandAck {
        request_id,
        mode: "rust_v1".to_string(),
    })
}

#[tauri::command]
pub async fn submit_agent_tool_decision(
    generation_state: State<'_, GenerationState>,
    request_id: String,
    action_id: String,
    decision: Option<AgentToolDecision>,
    approved: Option<bool>,
) -> Result<(), AppError> {
    if request_id.trim().is_empty() {
        return Err(AppError::Config(
            "submit_agent_tool_decision requires a non-empty request_id".to_string(),
        ));
    }
    if action_id.trim().is_empty() {
        return Err(AppError::Config(
            "submit_agent_tool_decision requires a non-empty action_id".to_string(),
        ));
    }
    let normalized_decision = decision.or_else(|| {
        approved.map(|is_approved| {
            if is_approved {
                AgentToolDecision::ApproveOnce
            } else {
                AgentToolDecision::Deny
            }
        })
    });
    let Some(resolved_decision) = normalized_decision else {
        return Err(AppError::Config(
            "submit_agent_tool_decision requires either decision or approved".to_string(),
        ));
    };

    generation_state
        .submit_agent_decision(&request_id, &action_id, resolved_decision)
        .await;
    Ok(())
}
