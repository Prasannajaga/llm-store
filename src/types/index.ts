export type Role = 'user' | 'assistant' | 'system';
export type FeedbackRating = 'good' | 'bad';

export interface Chat {
    id: string;
    title: string;
    project?: string;
    created_at: string;
}

export interface Message {
    id: string;
    chat_id: string;
    role: Role;
    content: string;
    reasoning_content?: string | null;
    created_at: string;
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
