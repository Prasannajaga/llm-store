use crate::error::AppError;
use crate::models::SettingsEntry;
use crate::state_logger;
use crate::storage::{self, AppState};
use crate::{config, config::ReasoningTokenConfig};
use chrono::Utc;
use serde::Serialize;
use sqlx::Row;
use tauri::State;

#[tauri::command]
pub async fn save_settings(
    state: State<'_, AppState>,
    entries: Vec<SettingsEntry>,
) -> Result<(), AppError> {
    storage::save_settings_batch(&state.db, &entries)
        .await
        .map_err(|err| {
            state_logger::module_error("commands.settings", "save_settings", &err);
            err
        })
}

#[tauri::command]
pub async fn load_settings(state: State<'_, AppState>) -> Result<Vec<SettingsEntry>, AppError> {
    storage::load_all_settings(&state.db).await.map_err(|err| {
        state_logger::module_error("commands.settings", "load_settings", &err);
        err
    })
}

#[tauri::command]
pub fn get_reasoning_token_config() -> ReasoningTokenConfig {
    config::reasoning_token_config()
}

#[derive(Debug, Serialize)]
struct WorkspaceRegisteredModel {
    id: String,
    path: String,
    display_name: String,
    registered_at: String,
}

#[derive(Debug, Serialize)]
struct WorkspaceKnowledgeDocumentExport {
    id: String,
    file_name: String,
    file_path: String,
    content: String,
    embedding: String,
    created_at: String,
}

#[derive(Debug, Serialize)]
struct WorkspaceKnowledgeChunkExport {
    id: String,
    document_id: String,
    chunk_index: i64,
    content: String,
    embedding: String,
    created_at: String,
}

#[derive(Debug, Serialize)]
struct WorkspaceBackup {
    schema_version: u32,
    exported_at: String,
    app: &'static str,
    chats: Vec<crate::models::Chat>,
    messages: Vec<crate::models::Message>,
    feedback: Vec<crate::models::Feedback>,
    settings: Vec<crate::models::SettingsEntry>,
    registered_models: Vec<WorkspaceRegisteredModel>,
    knowledge_documents: Vec<WorkspaceKnowledgeDocumentExport>,
    knowledge_chunks: Vec<WorkspaceKnowledgeChunkExport>,
}

#[tauri::command]
pub async fn export_workspace_backup(state: State<'_, AppState>) -> Result<String, AppError> {
    let chats = storage::list_chats(&state.db).await?;
    let mut messages = Vec::new();
    for chat in &chats {
        let mut chat_messages = storage::get_messages(&state.db, &chat.id).await?;
        messages.append(&mut chat_messages);
    }

    let feedback = storage::list_all_feedback(&state.db, None).await?;
    let settings = storage::load_all_settings(&state.db).await?;

    let registered_models_rows = sqlx::query(
        "SELECT id, path, display_name, registered_at FROM registered_models ORDER BY registered_at DESC",
    )
    .fetch_all(&state.db)
    .await?;
    let registered_models = registered_models_rows
        .into_iter()
        .map(|row| WorkspaceRegisteredModel {
            id: row.get("id"),
            path: row.get("path"),
            display_name: row.get("display_name"),
            registered_at: row.get("registered_at"),
        })
        .collect::<Vec<_>>();

    let knowledge_docs_rows = sqlx::query(
        "SELECT id, file_name, file_path, content, embedding, created_at FROM knowledge_documents ORDER BY created_at DESC",
    )
    .fetch_all(&state.db)
    .await?;
    let knowledge_documents = knowledge_docs_rows
        .into_iter()
        .map(|row| WorkspaceKnowledgeDocumentExport {
            id: row.get("id"),
            file_name: row.get("file_name"),
            file_path: row.get("file_path"),
            content: row.get("content"),
            embedding: row.get("embedding"),
            created_at: row.get("created_at"),
        })
        .collect::<Vec<_>>();

    let knowledge_chunks_rows = sqlx::query(
        "SELECT id, document_id, chunk_index, content, embedding, created_at FROM knowledge_chunks ORDER BY document_id ASC, chunk_index ASC",
    )
    .fetch_all(&state.db)
    .await?;
    let knowledge_chunks = knowledge_chunks_rows
        .into_iter()
        .map(|row| WorkspaceKnowledgeChunkExport {
            id: row.get("id"),
            document_id: row.get("document_id"),
            chunk_index: row.get("chunk_index"),
            content: row.get("content"),
            embedding: row.get("embedding"),
            created_at: row.get("created_at"),
        })
        .collect::<Vec<_>>();

    let payload = WorkspaceBackup {
        schema_version: 1,
        exported_at: Utc::now().to_rfc3339(),
        app: "llm-store",
        chats,
        messages,
        feedback,
        settings,
        registered_models,
        knowledge_documents,
        knowledge_chunks,
    };

    serde_json::to_string_pretty(&payload)
        .map_err(|err| AppError::Config(format!("Failed to serialize workspace backup: {}", err)))
}
