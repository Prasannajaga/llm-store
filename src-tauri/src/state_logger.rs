use std::fmt::Display;
use std::future::Future;
use std::panic::PanicHookInfo;
use std::sync::Once;
use std::time::Instant;

use crate::error::AppError;
use crate::pipeline::types::{LayerStatus, PipelineError};

const TARGET: &str = "state_logger";
static PANIC_HOOK_INIT: Once = Once::new();

#[derive(Debug, Clone, Copy)]
enum DbAccess {
    Read,
    Write,
}

impl DbAccess {
    fn as_str(self) -> &'static str {
        match self {
            DbAccess::Read => "read",
            DbAccess::Write => "write",
        }
    }
}

pub fn install_panic_hook() {
    PANIC_HOOK_INIT.call_once(|| {
        let default_hook = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |panic_info| {
            let location = panic_info
                .location()
                .map(|loc| format!("{}:{}", loc.file(), loc.line()))
                .unwrap_or_else(|| "unknown".to_string());

            tracing::error!(
                target: TARGET,
                module = "runtime",
                event = "panic",
                location = %location,
                payload = %panic_payload(panic_info),
                "Unhandled panic captured"
            );

            default_hook(panic_info);
        }));
    });
}

fn panic_payload(panic_info: &PanicHookInfo<'_>) -> String {
    if let Some(payload) = panic_info.payload().downcast_ref::<&str>() {
        (*payload).to_string()
    } else if let Some(payload) = panic_info.payload().downcast_ref::<String>() {
        payload.clone()
    } else {
        "non-string panic payload".to_string()
    }
}

pub fn pipeline_started(request_id: &str, chat_id: &str, prompt_chars: usize) {
    tracing::info!(
        target: TARGET,
        module = "pipeline",
        event = "started",
        request_id = %request_id,
        chat_id = %chat_id,
        prompt_chars,
        "Pipeline started"
    );
}

pub fn pipeline_completed(
    request_id: &str,
    finish_reason: &str,
    retrieved_count: usize,
    deduped_count: usize,
    warning_count: usize,
) {
    tracing::info!(
        target: TARGET,
        module = "pipeline",
        event = "completed",
        request_id = %request_id,
        finish_reason = %finish_reason,
        retrieved_count,
        deduped_count,
        warning_count,
        "Pipeline completed"
    );
}

pub fn persisted_messages(request_id: &str, user_text: &str, assistant_text: &str) {
    tracing::info!(
        target: TARGET,
        module = "pipeline",
        event = "persisted_messages",
        request_id = %request_id,
        user_text_chars = user_text.chars().count(),
        assistant_text_chars = assistant_text.chars().count(),
        user_text = %user_text,
        assistant_text = %assistant_text,
        "Persisted chat messages with raw text"
    );
}

pub fn pipeline_failed(err: &PipelineError) {
    tracing::error!(
        target: TARGET,
        module = "pipeline",
        event = "failed",
        request_id = %err.request_id,
        layer = %err.layer,
        code = ?err.code,
        user_safe_message = %err.user_safe_message,
        internal_detail = %err.internal_detail,
        "Pipeline failed"
    );
}

pub fn layer_started(request_id: &str, layer: &str) {
    tracing::info!(
        target: TARGET,
        module = "pipeline",
        event = "layer_started",
        request_id = %request_id,
        layer = %layer,
        "Pipeline layer started"
    );
}

pub fn layer_completed(
    request_id: &str,
    layer: &str,
    status: &LayerStatus,
    duration_ms: u64,
    warning_count: usize,
) {
    tracing::info!(
        target: TARGET,
        module = "pipeline",
        event = "layer_completed",
        request_id = %request_id,
        layer = %layer,
        status = ?status,
        duration_ms,
        warning_count,
        "Pipeline layer completed"
    );
}

pub fn module_error(module: &str, operation: &str, error: &impl Display) {
    tracing::error!(
        target: TARGET,
        module = %module,
        operation = %operation,
        event = "error",
        error = %error,
        "Operation failed"
    );
}

pub async fn db_read<T, F>(operation: &'static str, future: F) -> Result<T, AppError>
where
    F: Future<Output = Result<T, AppError>>,
{
    db_operation(DbAccess::Read, operation, future).await
}

pub async fn db_write<T, F>(operation: &'static str, future: F) -> Result<T, AppError>
where
    F: Future<Output = Result<T, AppError>>,
{
    db_operation(DbAccess::Write, operation, future).await
}

async fn db_operation<T, F>(
    access: DbAccess,
    operation: &'static str,
    future: F,
) -> Result<T, AppError>
where
    F: Future<Output = Result<T, AppError>>,
{
    tracing::debug!(
        target: TARGET,
        module = "storage",
        event = "db_started",
        access = access.as_str(),
        operation = operation,
        "DB operation started"
    );

    let started = Instant::now();
    let result = future.await;
    let duration_ms = started.elapsed().as_millis() as u64;

    match &result {
        Ok(_) => {
            tracing::info!(
                target: TARGET,
                module = "storage",
                event = "db_completed",
                access = access.as_str(),
                operation = operation,
                duration_ms,
                "DB operation completed"
            );
        }
        Err(err) => {
            tracing::error!(
                target: TARGET,
                module = "storage",
                event = "db_failed",
                access = access.as_str(),
                operation = operation,
                duration_ms,
                error = %err,
                "DB operation failed"
            );
        }
    }

    result
}
