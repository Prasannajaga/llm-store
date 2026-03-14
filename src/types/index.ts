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
    port: number;
    context_size: number;
    gpu_layers: number;
    threads: number;
    batch_size: number;
}
