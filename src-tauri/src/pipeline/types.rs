use crate::models::KnowledgeSearchResult;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const DEFAULT_CONTEXT_LIMIT: usize = 8;
pub const DEFAULT_PIPELINE_MODE: &str = "rust_v1";
pub const PIPELINE_MODE_KEY: &str = "pipeline.mode";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LayerStatus {
    Success,
    Fallback,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PipelineProgressStatus {
    Started,
    Success,
    Fallback,
    Failed,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PipelineProgressActivityKind {
    Layer,
    Analyzing,
    Tool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RetrievalMode {
    Vector,
    Graph,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InteractionMode {
    Chat,
    Agent,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PipelineErrorCode {
    InvalidInput,
    RetrievalPlan,
    RagQuery,
    DedupeContext,
    PromptBuild,
    LlmInvoke,
    Persistence,
    Cancelled,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PipelineWarningCode {
    RetrievalPlanFallback,
    RagFallbackEmptyContext,
    DedupePassthrough,
    PromptFallbackTemplate,
    PromptContextTrimmed,
    PromptTokenBudgetApplied,
    PersistenceSkipped,
    ParsingSkipped,
    AgentPlannerFallback,
    AgentToolFailed,
    AgentToolDenied,
    AgentToolTimedOut,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PipelineWarning {
    pub code: PipelineWarningCode,
    pub layer: String,
    pub message: String,
}

#[derive(Debug, Clone)]
pub struct LayerOutcome<T> {
    pub status: LayerStatus,
    pub data: Option<T>,
    pub warnings: Vec<PipelineWarning>,
    pub timing_ms: u64,
}

impl<T> LayerOutcome<T> {
    pub fn success(data: T, timing_ms: u64) -> Self {
        Self {
            status: LayerStatus::Success,
            data: Some(data),
            warnings: Vec::new(),
            timing_ms,
        }
    }

    pub fn fallback(data: T, warnings: Vec<PipelineWarning>, timing_ms: u64) -> Self {
        Self {
            status: LayerStatus::Fallback,
            data: Some(data),
            warnings,
            timing_ms,
        }
    }

    pub fn failed(warnings: Vec<PipelineWarning>, timing_ms: u64) -> Self {
        Self {
            status: LayerStatus::Failed,
            data: None,
            warnings,
            timing_ms,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PipelineRequest {
    pub chat_id: String,
    pub prompt: String,
    pub selected_doc_ids: Option<Vec<String>>,
    pub request_id: String,
    pub interaction_mode: Option<InteractionMode>,
}

#[derive(Debug, Clone)]
pub struct NormalizedInput {
    pub prompt: String,
    pub selected_doc_ids: Option<Vec<String>>,
    pub interaction_mode: InteractionMode,
}

#[derive(Debug, Clone)]
pub struct RetrievalPlan {
    pub mode: RetrievalMode,
    pub limit: usize,
    pub document_ids: Option<Vec<String>>,
}

#[derive(Debug, Clone)]
pub struct PipelineLayerTiming {
    pub layer: &'static str,
    pub status: LayerStatus,
    pub duration_ms: u64,
}

#[derive(Debug, Clone)]
pub struct PipelineContext {
    pub request: PipelineRequest,
    pub normalized_input: Option<NormalizedInput>,
    pub retrieval_plan: Option<RetrievalPlan>,
    pub retrieved_chunks: Vec<KnowledgeSearchResult>,
    pub deduped_chunks: Vec<KnowledgeSearchResult>,
    pub assistant_context_payload: Option<String>,
    pub final_prompt: Option<String>,
    pub generated_text: String,
    pub generated_reasoning: Option<String>,
    pub finish_reason: Option<String>,
    pub agent_summary: Option<AgentRunSummary>,
    pub agent_trace: Option<Value>,
    pub warnings: Vec<PipelineWarning>,
    pub layer_timings: Vec<PipelineLayerTiming>,
}

impl PipelineContext {
    pub fn new(request: PipelineRequest) -> Self {
        Self {
            request,
            normalized_input: None,
            retrieval_plan: None,
            retrieved_chunks: Vec::new(),
            deduped_chunks: Vec::new(),
            assistant_context_payload: None,
            final_prompt: None,
            generated_text: String::new(),
            generated_reasoning: None,
            finish_reason: None,
            agent_summary: None,
            agent_trace: None,
            warnings: Vec::new(),
            layer_timings: Vec::new(),
        }
    }

    pub fn push_timing(&mut self, layer: &'static str, status: LayerStatus, duration_ms: u64) {
        self.layer_timings.push(PipelineLayerTiming {
            layer,
            status,
            duration_ms,
        });
    }

    pub fn add_warnings(&mut self, warnings: Vec<PipelineWarning>) {
        if warnings.is_empty() {
            return;
        }
        self.warnings.extend(warnings);
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PipelineError {
    pub code: PipelineErrorCode,
    pub layer: String,
    pub user_safe_message: String,
    pub internal_detail: String,
    pub request_id: String,
}

impl PipelineError {
    pub fn new(
        code: PipelineErrorCode,
        layer: impl Into<String>,
        user_safe_message: impl Into<String>,
        internal_detail: impl Into<String>,
        request_id: impl Into<String>,
    ) -> Self {
        Self {
            code,
            layer: layer.into(),
            user_safe_message: user_safe_message.into(),
            internal_detail: internal_detail.into(),
            request_id: request_id.into(),
        }
    }
}

impl std::fmt::Display for PipelineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{} (layer={}, request_id={})",
            self.user_safe_message, self.layer, self.request_id
        )
    }
}

impl std::error::Error for PipelineError {}

#[derive(Debug, Clone)]
pub struct LlmInvokeResult {
    pub answer_text: String,
    pub reasoning_text: Option<String>,
    pub finish_reason: String,
}

#[derive(Debug, Clone)]
pub struct AgentRunSummary {
    pub tool_calls_total: usize,
    pub approvals_required: usize,
    pub approvals_denied: usize,
    pub timed_out: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentToolDecision {
    ApproveOnce,
    ApproveAlways,
    Deny,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenStreamEvent {
    pub request_id: String,
    pub token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GenerationCompleteEvent {
    pub request_id: String,
    pub finish_reason: String,
    pub retrieved_count: usize,
    pub deduped_count: usize,
    pub context_payload: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GenerationErrorEvent {
    pub request_id: String,
    pub code: PipelineErrorCode,
    pub layer: String,
    pub user_safe_message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PipelineProgressEvent {
    pub request_id: String,
    pub layer: String,
    pub status: PipelineProgressStatus,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub activity_kind: Option<PipelineProgressActivityKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_target: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentToolRiskLevel {
    Safe,
    Confirm,
    High,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentToolConfirmationRequiredEvent {
    pub request_id: String,
    pub action_id: String,
    pub tool: String,
    pub summary: String,
    pub args_preview: String,
    pub risk_level: AgentToolRiskLevel,
    pub expires_at: String,
    pub pattern: Option<String>,
    pub match_target: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root_candidate: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outside_trusted_roots: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PipelineCommandAck {
    pub request_id: String,
    pub mode: String,
}
