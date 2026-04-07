use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use sqlx::SqlitePool;
use tauri::{AppHandle, Emitter};

use crate::events::{GENERATION_COMPLETE, GENERATION_ERROR};

use super::dedupe_context;
use super::input_normalize;
use super::llm_invoke_stream;
use super::persist_messages;
use super::prompt_build;
use super::rag_query;
use super::retrieval_plan;
use super::types::{
    GenerationCompleteEvent, GenerationErrorEvent, LayerOutcome, LayerStatus, PipelineContext,
    PipelineError, PipelineErrorCode, PipelineRequest,
};

pub async fn run_and_emit(
    app: &AppHandle,
    pool: &SqlitePool,
    cancellation_flag: Arc<AtomicBool>,
    request: PipelineRequest,
) -> Result<(), PipelineError> {
    let result = run_inner(app, pool, cancellation_flag, request).await;

    if let Err(err) = &result {
        let payload = GenerationErrorEvent {
            request_id: err.request_id.clone(),
            code: err.code.clone(),
            layer: err.layer.clone(),
            user_safe_message: err.user_safe_message.clone(),
        };
        let _ = app.emit(GENERATION_ERROR, payload);
    }

    result
}

async fn run_inner(
    app: &AppHandle,
    pool: &SqlitePool,
    cancellation_flag: Arc<AtomicBool>,
    request: PipelineRequest,
) -> Result<(), PipelineError> {
    let mut ctx = PipelineContext::new(request);

    // 1) input_normalize: fail-fast
    let input_outcome = input_normalize::run(&ctx.request)?;
    record_layer(&mut ctx, input_normalize::LAYER_NAME, &input_outcome);
    let normalized_input = input_outcome.data.clone().ok_or_else(|| {
        PipelineError::new(
            PipelineErrorCode::InvalidInput,
            input_normalize::LAYER_NAME,
            "Unable to process input. Please retry.",
            "Input layer succeeded without output payload",
            ctx.request.request_id.clone(),
        )
    })?;
    ctx.add_warnings(input_outcome.warnings);
    ctx.normalized_input = Some(normalized_input.clone());

    // 2) retrieval_plan: fallback to vector
    let plan_outcome = retrieval_plan::run(pool, &normalized_input, &ctx.request.request_id).await;
    record_layer(&mut ctx, retrieval_plan::LAYER_NAME, &plan_outcome);
    let retrieval_plan = plan_outcome.data.clone().ok_or_else(|| {
        PipelineError::new(
            PipelineErrorCode::RetrievalPlan,
            retrieval_plan::LAYER_NAME,
            "Unable to plan retrieval. Please try again.",
            "Retrieval plan layer returned no data",
            ctx.request.request_id.clone(),
        )
    })?;
    ctx.add_warnings(plan_outcome.warnings);
    ctx.retrieval_plan = Some(retrieval_plan.clone());

    // 3) rag_query: failure -> continue with empty context
    let rag_outcome = rag_query::run(pool, &normalized_input.prompt, &retrieval_plan).await;
    record_layer(&mut ctx, rag_query::LAYER_NAME, &rag_outcome);
    ctx.add_warnings(rag_outcome.warnings);
    let retrieved_chunks = rag_outcome.data.unwrap_or_default();
    ctx.retrieved_chunks = retrieved_chunks.clone();

    // 4) dedupe_context: failure -> passthrough raw chunks
    let dedupe_outcome = dedupe_context::run(retrieved_chunks.clone(), retrieval_plan.limit);
    record_layer(&mut ctx, dedupe_context::LAYER_NAME, &dedupe_outcome);
    ctx.add_warnings(dedupe_outcome.warnings);
    let deduped_chunks = dedupe_outcome.data.unwrap_or(retrieved_chunks);
    ctx.deduped_chunks = deduped_chunks.clone();

    // 5) prompt_build: failure -> minimal safe prompt
    let prompt_outcome = prompt_build::run(&normalized_input.prompt, &deduped_chunks);
    record_layer(&mut ctx, prompt_build::LAYER_NAME, &prompt_outcome);
    ctx.add_warnings(prompt_outcome.warnings);
    let final_prompt = prompt_outcome.data.unwrap_or_else(|| {
        [
            "You are a helpful assistant.",
            "",
            &format!("User Question: {}", normalized_input.prompt),
        ]
        .join("\n")
    });
    ctx.final_prompt = Some(final_prompt.clone());

    // 6) llm_invoke_stream: terminal failure if invoke cannot proceed
    let llm_outcome = llm_invoke_stream::run(
        app,
        pool,
        cancellation_flag,
        &ctx.request.request_id,
        &final_prompt,
    )
    .await?;
    record_layer(&mut ctx, llm_invoke_stream::LAYER_NAME, &llm_outcome);
    ctx.add_warnings(llm_outcome.warnings);
    let llm_result = llm_outcome.data.ok_or_else(|| {
        PipelineError::new(
            PipelineErrorCode::LlmInvoke,
            llm_invoke_stream::LAYER_NAME,
            "Generation failed before a response was produced.",
            "LLM layer completed without result payload",
            ctx.request.request_id.clone(),
        )
    })?;
    ctx.generated_text = llm_result.full_text;
    ctx.finish_reason = Some(llm_result.finish_reason);

    // Emit completion event before persistence so UI is not blocked by storage errors.
    let completion_payload = GenerationCompleteEvent {
        request_id: ctx.request.request_id.clone(),
        finish_reason: ctx
            .finish_reason
            .clone()
            .unwrap_or_else(|| "completed".to_string()),
        retrieved_count: ctx.retrieved_chunks.len(),
        deduped_count: ctx.deduped_chunks.len(),
    };
    app.emit(GENERATION_COMPLETE, completion_payload)
        .map_err(|err| {
            PipelineError::new(
                PipelineErrorCode::Unknown,
                "emit_completion",
                "Unable to finalize response in the UI. Please retry.",
                format!("Failed to emit generation_complete event: {}", err),
                ctx.request.request_id.clone(),
            )
        })?;

    // 7) persist_messages: log failure only, do not break delivered response
    let persist_outcome = persist_messages::run(
        pool,
        &ctx.request.chat_id,
        &normalized_input.prompt,
        &ctx.generated_text,
    )
    .await;
    record_layer(&mut ctx, persist_messages::LAYER_NAME, &persist_outcome);
    ctx.add_warnings(persist_outcome.warnings.clone());
    if persist_outcome.status == LayerStatus::Failed {
        tracing::warn!(
            request_id = %ctx.request.request_id,
            layer = persist_messages::LAYER_NAME,
            warning_count = persist_outcome.warnings.len(),
            "Persistence layer failed, but streamed response already delivered"
        );
    } else if let Some(ids) = persist_outcome.data.as_ref() {
        tracing::info!(
            request_id = %ctx.request.request_id,
            layer = persist_messages::LAYER_NAME,
            user_message_id = %ids.user_message_id,
            assistant_message_id = %ids.assistant_message_id,
            "Persisted chat messages"
        );
    }

    tracing::info!(
        request_id = %ctx.request.request_id,
        finish_reason = %ctx.finish_reason.clone().unwrap_or_else(|| "completed".to_string()),
        retrieved_count = ctx.retrieved_chunks.len(),
        deduped_count = ctx.deduped_chunks.len(),
        warning_count = ctx.warnings.len(),
        "Pipeline completed"
    );

    Ok(())
}

fn record_layer<T>(ctx: &mut PipelineContext, layer: &'static str, outcome: &LayerOutcome<T>) {
    let fallback_used = outcome.status == LayerStatus::Fallback;
    tracing::info!(
        request_id = %ctx.request.request_id,
        layer,
        duration_ms = outcome.timing_ms,
        status = ?outcome.status,
        fallback_used,
        warning_count = outcome.warnings.len(),
        "Pipeline layer completed"
    );

    ctx.push_timing(layer, outcome.status.clone(), outcome.timing_ms);
}
