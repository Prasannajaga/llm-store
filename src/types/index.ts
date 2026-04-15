export type Role = 'user' | 'assistant' | 'system';
export type FeedbackRating = 'good' | 'bad';
export type InteractionMode = 'chat' | 'agent';

export interface Chat {
    id: string;
    title: string;
    project?: string;
    created_at: string;
}

export interface Project {
    id: string;
    name: string;
    created_at: string;
}

export interface Message {
    id: string;
    chat_id: string;
    role: Role;
    content: string;
    reasoning_content?: string | null;
    context_payload?: string | null;
    created_at: string;
}

export interface MessageContextChunk {
    chunk_id: string;
    document_id: string;
    file_name: string;
    score?: number | null;
    preview: string;
}

export type AgentTraceState = 'pending' | 'running' | 'completed' | 'error' | 'interrupted';
export type PermissionMatchAction = 'allow' | 'deny' | 'ask';
export type AgentDecisionMode = 'approve_once' | 'approve_always' | 'deny';

export interface MessageAgentRunTrace {
    started_at?: string;
    ended_at?: string;
    wall_clock_budget_reached?: boolean;
    cancelled?: boolean;
    max_tool_steps?: number;
    max_wall_clock_seconds?: number;
    loop_steps_executed?: number;
}

export interface MessageAgentToolStateTransition {
    state?: AgentTraceState;
    at?: string;
}

export interface MessageAgentToolTrace {
    call_id?: string;
    step?: number;
    tool?: string;
    normalized_args?: Record<string, unknown>;
    state_transitions?: MessageAgentToolStateTransition[];
    output_raw?: string | null;
    error_raw?: string | null;
    output_excerpt?: string;
    summary?: string;
    approval_requested?: boolean;
    denied?: boolean;
    timed_out?: boolean;
    interrupted?: boolean;
}

export interface MessageAgentPermissionTrace {
    decision_id?: string;
    call_id?: string;
    tool?: string;
    request_summary?: string;
    args_preview?: string;
    match_target?: string | null;
    matched_pattern?: string | null;
    matched_action?: PermissionMatchAction | null;
    default_action?: PermissionMatchAction;
    match_result?: PermissionMatchAction;
    user_response?: AgentDecisionMode | null;
    timeout?: boolean;
    requested_at?: string;
    resolved_at?: string;
}

export interface MessageAgentTrace {
    run?: MessageAgentRunTrace;
    tool_calls?: MessageAgentToolTrace[];
    permission_decisions?: MessageAgentPermissionTrace[];
}

export interface MessageContextPayload {
    mode?: string;
    interaction_mode?: InteractionMode;
    retrieval_mode?: string;
    selected_document_ids?: string[];
    conversation?: {
        text?: string;
        source_chars?: number;
        emitted_chars?: number;
        summarized_turns?: number;
    };
    knowledge?: {
        retrieved_count?: number;
        deduped_count?: number;
        chunks?: MessageContextChunk[];
    };
    agent?: {
        tool_calls_total?: number;
        approvals_required?: number;
        approvals_denied?: number;
        timed_out?: boolean;
        trace?: MessageAgentTrace;
    };
}

export interface AppConfig {
    database_url: string;
    model_directory: string;
    gpu_layers: number;
    log_level: string;
}

export interface Feedback {
    id: string;
    message_id: string;
    rating: FeedbackRating;
    prompt: string;
    response: string;
    created_at: string;
}

export interface LlamaServerArgs {
    executable_path: string;
    port: number;
    context_size: number;
    gpu_layers: number;
    threads: number;
    batch_size: number;
}

/** Parameters sent with each /completion request to control generation behavior. */
export interface GenerationParams {
    max_tokens: number;
    temperature: number;
    top_p: number;
    top_k: number;
    repeat_penalty: number;
}

export interface KnowledgeDocument {
    id: string;
    file_name: string;
    file_path: string;
    chunk_count: number;
    created_at: string;
}

export interface KnowledgeIngestResult {
    document_id: string;
    file_name: string;
    chunks: number;
}

export interface KnowledgeSearchResult {
    chunk_id: string;
    document_id: string;
    file_name: string;
    content: string;
    score: number;
}
