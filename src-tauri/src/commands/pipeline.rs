use std::sync::atomic::Ordering;

use tauri::{AppHandle, State};

use crate::commands::streaming::GenerationState;
use crate::error::AppError;
use crate::pipeline::orchestrator;
use crate::pipeline::types::{PipelineCommandAck, PipelineRequest};
use crate::storage::AppState;

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

    let app_handle = app.clone();
    let pool = state.db.clone();
    let cancel_flag = generation_state.is_cancelled.clone();
    let request_id = request.request_id.clone();

    tauri::async_runtime::spawn(async move {
        if let Err(err) = orchestrator::run_and_emit(&app_handle, &pool, cancel_flag, request).await
        {
            tracing::error!(
                request_id = %err.request_id,
                layer = %err.layer,
                code = ?err.code,
                internal_detail = %err.internal_detail,
                "Rust chat pipeline failed"
            );
        }
    });

    Ok(PipelineCommandAck {
        request_id,
        mode: "rust_v1".to_string(),
    })
}
