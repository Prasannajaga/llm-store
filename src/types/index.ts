export type Role = 'user' | 'assistant' | 'system';

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
