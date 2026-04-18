use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use serde_json::json;
use sqlx::SqlitePool;
use tauri::{AppHandle, Emitter};

use crate::commands::streaming::GenerationState;
use crate::events::{GENERATION_COMPLETE, GENERATION_ERROR, PIPELINE_PROGRESS};
use crate::state_logger;
use crate::storage;

use super::agent_loop;
use super::dedupe_context;
use super::input_normalize;
use super::llm_invoke_stream;
use super::persist_messages;
use super::prompt_build;
use super::rag_query;
use super::retrieval_plan;
use super::types::{
    GenerationCompleteEvent, GenerationErrorEvent, InteractionMode, LayerOutcome, LayerStatus,
    PipelineContext, PipelineError, PipelineErrorCode, PipelineProgressActivityKind,
    PipelineProgressEvent, PipelineProgressStatus, PipelineRequest,
};

pub async fn run_and_emit(
    app: &AppHandle,
    pool: &SqlitePool,
    cancellation_flag: Arc<AtomicBool>,
    generation_state: GenerationState,
    request: PipelineRequest,
) -> Result<(), PipelineError> {
    let result = run_inner(app, pool, cancellation_flag, generation_state, request).await;

    if let Err(err) = &result {
        state_logger::pipeline_failed(err);
        emit_progress(
            app,
            &err.request_id,
            &err.layer,
            PipelineProgressStatus::Failed,
            "Pipeline step failed",
        );

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
    generation_state: GenerationState,
    request: PipelineRequest,
) -> Result<(), PipelineError> {
    let mut ctx = PipelineContext::new(request);
    state_logger::pipeline_started(
        &ctx.request.request_id,
        &ctx.request.chat_id,
        ctx.request.prompt.chars().count(),
    );
    let shared_settings = load_shared_settings(pool).await;

    // 1) input_normalize: fail-fast
    emit_layer_started(app, &ctx.request.request_id, input_normalize::LAYER_NAME);
    let input_outcome = input_normalize::run(&ctx.request)?;
    record_layer(&mut ctx, input_normalize::LAYER_NAME, &input_outcome);
    emit_layer_outcome(
        app,
        &ctx.request.request_id,
        input_normalize::LAYER_NAME,
        &input_outcome.status,
    );
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
    emit_layer_started(app, &ctx.request.request_id, retrieval_plan::LAYER_NAME);
    let plan_outcome = match shared_settings.as_ref() {
        Some(settings) => {
            retrieval_plan::run_with_settings(&normalized_input, &ctx.request.request_id, settings)
        }
        None => retrieval_plan::run(pool, &normalized_input, &ctx.request.request_id).await,
    };
    record_layer(&mut ctx, retrieval_plan::LAYER_NAME, &plan_outcome);
    emit_layer_outcome(
        app,
        &ctx.request.request_id,
        retrieval_plan::LAYER_NAME,
        &plan_outcome.status,
    );
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
    emit_layer_started(app, &ctx.request.request_id, rag_query::LAYER_NAME);
    let rag_outcome = rag_query::run(pool, &normalized_input.prompt, &retrieval_plan).await;
    record_layer(&mut ctx, rag_query::LAYER_NAME, &rag_outcome);
    emit_layer_outcome(
        app,
        &ctx.request.request_id,
        rag_query::LAYER_NAME,
        &rag_outcome.status,
    );
    ctx.add_warnings(rag_outcome.warnings);
    let retrieved_chunks = rag_outcome.data.unwrap_or_default();
    ctx.retrieved_chunks = retrieved_chunks.clone();

    // 4) dedupe_context: failure -> passthrough raw chunks
    emit_layer_started(app, &ctx.request.request_id, dedupe_context::LAYER_NAME);
    let dedupe_outcome = dedupe_context::run(retrieved_chunks.clone(), retrieval_plan.limit);
    record_layer(&mut ctx, dedupe_context::LAYER_NAME, &dedupe_outcome);
    emit_layer_outcome(
        app,
        &ctx.request.request_id,
        dedupe_context::LAYER_NAME,
        &dedupe_outcome.status,
    );
    ctx.add_warnings(dedupe_outcome.warnings);
    let deduped_chunks = dedupe_outcome.data.unwrap_or(retrieved_chunks);
    ctx.deduped_chunks = deduped_chunks.clone();

    // 5) prompt_build: failure -> minimal safe prompt
    emit_layer_started(app, &ctx.request.request_id, prompt_build::LAYER_NAME);
    let prompt_outcome = match shared_settings.as_ref() {
        Some(settings) => {
            prompt_build::run_with_settings(
                pool,
                &ctx.request.request_id,
                &ctx.request.chat_id,
                &normalized_input.prompt,
                &deduped_chunks,
                settings,
            )
            .await
        }
        None => {
            prompt_build::run(
                pool,
                &ctx.request.request_id,
                &ctx.request.chat_id,
                &normalized_input.prompt,
                &deduped_chunks,
            )
            .await
        }
    };
    record_layer(&mut ctx, prompt_build::LAYER_NAME, &prompt_outcome);
    emit_layer_outcome(
        app,
        &ctx.request.request_id,
        prompt_build::LAYER_NAME,
        &prompt_outcome.status,
    );
    ctx.add_warnings(prompt_outcome.warnings);
    let mut generation_prompt = prompt_outcome.data.unwrap_or_else(|| {
        [
            "You are a helpful assistant.",
            "",
            &format!("User Question: {}", normalized_input.prompt),
        ]
        .join("\n")
    });
    ctx.final_prompt = Some(generation_prompt.clone());

    if normalized_input.interaction_mode == InteractionMode::Agent {
        tracing::info!(
            target: "state_logger",
            module = "pipeline",
            event = "agent_mode_enabled",
            request_id = %ctx.request.request_id,
            chat_id = %ctx.request.chat_id,
            "Agent mode branch selected"
        );
        emit_layer_started(app, &ctx.request.request_id, agent_loop::LAYER_NAME);
        let agent_outcome = agent_loop::run(
            app,
            pool,
            cancellation_flag.clone(),
            &generation_state,
            &ctx.request.request_id,
            &normalized_input.prompt,
            &generation_prompt,
            &ctx.deduped_chunks,
            normalized_input.selected_doc_ids.as_ref(),
        )
        .await;
        record_layer(&mut ctx, agent_loop::LAYER_NAME, &agent_outcome);
        emit_layer_outcome(
            app,
            &ctx.request.request_id,
            agent_loop::LAYER_NAME,
            &agent_outcome.status,
        );
        ctx.add_warnings(agent_outcome.warnings);
        if let Some(agent_output) = agent_outcome.data {
            generation_prompt = agent_output.final_prompt;
            ctx.agent_summary = Some(agent_output.summary);
            ctx.agent_trace = Some(agent_output.trace);
            ctx.final_prompt = Some(generation_prompt.clone());
            if let Some(summary) = &ctx.agent_summary {
                tracing::info!(
                    target: "state_logger",
                    module = "pipeline",
                    event = "agent_mode_summary",
                    request_id = %ctx.request.request_id,
                    tool_calls_total = summary.tool_calls_total,
                    approvals_required = summary.approvals_required,
                    approvals_denied = summary.approvals_denied,
                    timed_out = summary.timed_out,
                    "Agent mode execution summary"
                );
            }
        }
    }

    ctx.assistant_context_payload = build_assistant_context_payload(&ctx);

    // 6) llm_invoke_stream: terminal failure if invoke cannot proceed
    emit_layer_started(app, &ctx.request.request_id, llm_invoke_stream::LAYER_NAME);
    let llm_outcome = match shared_settings.as_ref() {
        Some(settings) => {
            llm_invoke_stream::run_with_settings(
                app,
                cancellation_flag,
                &ctx.request.request_id,
                &generation_prompt,
                settings,
            )
            .await?
        }
        None => {
            llm_invoke_stream::run(
                app,
                pool,
                cancellation_flag,
                &ctx.request.request_id,
                &generation_prompt,
            )
            .await?
        }
    };
    record_layer(&mut ctx, llm_invoke_stream::LAYER_NAME, &llm_outcome);
    emit_layer_outcome(
        app,
        &ctx.request.request_id,
        llm_invoke_stream::LAYER_NAME,
        &llm_outcome.status,
    );
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
    ctx.generated_text = llm_result.answer_text;
    ctx.generated_reasoning = llm_result.reasoning_text;
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
        context_payload: ctx.assistant_context_payload.clone(),
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
    emit_layer_started(app, &ctx.request.request_id, persist_messages::LAYER_NAME);
    let persist_outcome = persist_messages::run(
        pool,
        &ctx.request.chat_id,
        &normalized_input.prompt,
        &ctx.generated_text,
        ctx.generated_reasoning.as_deref(),
        ctx.assistant_context_payload.as_deref(),
        ctx.request.optimistic_user_message_id.as_deref(),
        ctx.request.optimistic_assistant_message_id.as_deref(),
    )
    .await;
    record_layer(&mut ctx, persist_messages::LAYER_NAME, &persist_outcome);
    emit_layer_outcome(
        app,
        &ctx.request.request_id,
        persist_messages::LAYER_NAME,
        &persist_outcome.status,
    );
    ctx.add_warnings(persist_outcome.warnings.clone());
    if persist_outcome.status == LayerStatus::Failed {
        state_logger::module_error(
            "pipeline",
            persist_messages::LAYER_NAME,
            &format!(
                "Persistence layer failed after delivery (warning_count={})",
                persist_outcome.warnings.len()
            ),
        );
    } else if persist_outcome.data.is_some() {
        state_logger::persisted_messages(
            &ctx.request.request_id,
            &normalized_input.prompt,
            &ctx.generated_text,
        );
    }

    state_logger::pipeline_completed(
        &ctx.request.request_id,
        &ctx.finish_reason
            .clone()
            .unwrap_or_else(|| "completed".to_string()),
        ctx.retrieved_chunks.len(),
        ctx.deduped_chunks.len(),
        ctx.warnings.len(),
    );

    Ok(())
}

const MAX_CONTEXT_CHUNK_PREVIEW_CHARS: usize = 320;
const MAX_CONTEXT_CHUNKS: usize = 8;

fn build_assistant_context_payload(ctx: &PipelineContext) -> Option<String> {
    let plan = ctx.retrieval_plan.as_ref()?;
    let selected_doc_ids = plan.document_ids.clone().unwrap_or_default();
    let interaction_mode = ctx
        .normalized_input
        .as_ref()
        .map(|input| input.interaction_mode)
        .unwrap_or(InteractionMode::Chat);

    let chunk_payload = ctx
        .deduped_chunks
        .iter()
        .take(MAX_CONTEXT_CHUNKS)
        .map(|chunk| {
            json!({
                "chunk_id": chunk.chunk_id,
                "document_id": chunk.document_id,
                "file_name": chunk.file_name,
                "score": chunk.score,
                "preview": clip_chars(&chunk.content, MAX_CONTEXT_CHUNK_PREVIEW_CHARS),
            })
        })
        .collect::<Vec<_>>();

    let has_agent_metadata = ctx.agent_summary.is_some();
    if selected_doc_ids.is_empty()
        && chunk_payload.is_empty()
        && !has_agent_metadata
        && interaction_mode == InteractionMode::Chat
    {
        return None;
    }

    let mut payload = json!({
        "mode": "rust_v1",
        "interaction_mode": interaction_mode_key(interaction_mode),
        "retrieval_mode": retrieval_mode_key(&plan.mode),
        "selected_document_ids": selected_doc_ids,
        "knowledge": {
            "retrieved_count": ctx.retrieved_chunks.len(),
            "deduped_count": ctx.deduped_chunks.len(),
            "chunks": chunk_payload,
        },
    });

    if let Some(summary) = &ctx.agent_summary {
        payload["agent"] = json!({
            "tool_calls_total": summary.tool_calls_total,
            "approvals_required": summary.approvals_required,
            "approvals_denied": summary.approvals_denied,
            "timed_out": summary.timed_out,
            "trace": ctx.agent_trace.clone().unwrap_or_else(|| json!({})),
        });
    }

    serde_json::to_string(&payload).ok()
}

fn interaction_mode_key(mode: InteractionMode) -> &'static str {
    match mode {
        InteractionMode::Chat => "chat",
        InteractionMode::Agent => "agent",
    }
}

fn retrieval_mode_key(mode: &super::types::RetrievalMode) -> &'static str {
    match mode {
        super::types::RetrievalMode::Vector => "vector",
        super::types::RetrievalMode::Graph => "graph",
    }
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

fn record_layer<T>(ctx: &mut PipelineContext, layer: &'static str, outcome: &LayerOutcome<T>) {
    state_logger::layer_completed(
        &ctx.request.request_id,
        layer,
        &outcome.status,
        outcome.timing_ms,
        outcome.warnings.len(),
    );

    ctx.push_timing(layer, outcome.status.clone(), outcome.timing_ms);
}

fn emit_layer_started(app: &AppHandle, request_id: &str, layer: &str) {
    state_logger::layer_started(request_id, layer);
    emit_progress(
        app,
        request_id,
        layer,
        PipelineProgressStatus::Started,
        layer_started_message(layer),
    );
}

fn emit_layer_outcome(app: &AppHandle, request_id: &str, layer: &str, status: &LayerStatus) {
    let progress_status = match status {
        LayerStatus::Success => PipelineProgressStatus::Success,
        LayerStatus::Fallback => PipelineProgressStatus::Fallback,
        LayerStatus::Failed => PipelineProgressStatus::Failed,
    };
    emit_progress(
        app,
        request_id,
        layer,
        progress_status,
        layer_outcome_message(layer, status),
    );
}

fn emit_progress(
    app: &AppHandle,
    request_id: &str,
    layer: &str,
    status: PipelineProgressStatus,
    message: &str,
) {
    let payload = PipelineProgressEvent {
        request_id: request_id.to_string(),
        layer: layer.to_string(),
        status,
        message: message.to_string(),
        activity_kind: Some(PipelineProgressActivityKind::Layer),
        tool: None,
        step: None,
        call_id: None,
        display_target: None,
    };

    if let Err(err) = app.emit(PIPELINE_PROGRESS, payload) {
        tracing::warn!(
            request_id = %request_id,
            layer,
            "Failed to emit pipeline progress event: {}",
            err
        );
    }
}

fn layer_started_message(layer: &str) -> &'static str {
    match layer {
        "input_normalize" => "Validating input",
        "retrieval_plan" => "Planning retrieval",
        "rag_query" => "Fetching docs",
        "dedupe_context" => "Analyzing context",
        "prompt_build" => "Constructing prompt",
        "agent_loop" => "Running agent tools",
        "llm_invoke_stream" => "Generating response",
        "persist_messages" => "Saving response",
        _ => "Processing layer",
    }
}

fn layer_outcome_message(layer: &str, status: &LayerStatus) -> &'static str {
    match (layer, status) {
        ("input_normalize", LayerStatus::Success) => "Input validated",
        ("retrieval_plan", LayerStatus::Success) => "Retrieval plan ready",
        ("rag_query", LayerStatus::Success) => "Documents fetched",
        ("dedupe_context", LayerStatus::Success) => "Context analyzed",
        ("prompt_build", LayerStatus::Success) => "Prompt ready",
        ("agent_loop", LayerStatus::Success) => "Agent tools finished",
        ("llm_invoke_stream", LayerStatus::Success) => "Generation finished",
        ("persist_messages", LayerStatus::Success) => "Response saved",

        ("retrieval_plan", LayerStatus::Fallback) => "Plan fallback applied",
        ("rag_query", LayerStatus::Fallback) => "Continuing without context",
        ("dedupe_context", LayerStatus::Fallback) => "Using raw context",
        ("prompt_build", LayerStatus::Fallback) => "Using minimal prompt",
        ("agent_loop", LayerStatus::Fallback) => "Agent completed with fallbacks",
        ("persist_messages", LayerStatus::Fallback) => "Persistence fallback applied",

        (_, LayerStatus::Failed) => "Layer failed",
        _ => "Layer completed",
    }
}

async fn load_shared_settings(pool: &SqlitePool) -> Option<HashMap<String, String>> {
    match storage::load_all_settings(pool).await {
        Ok(entries) => Some(
            entries
                .into_iter()
                .map(|entry| (entry.key, entry.value))
                .collect(),
        ),
        Err(err) => {
            tracing::warn!(
                "Failed to preload shared settings map for pipeline run: {}",
                err
            );
            None
        }
    }
}
