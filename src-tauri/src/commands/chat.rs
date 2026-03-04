use crate::error::AppError;
use crate::models::Chat;
use crate::storage::{self, AppState};
use tauri::State;

#[tauri::command]
pub async fn create_chat(state: State<'_, AppState>, chat: Chat) -> Result<(), AppError> {
    storage::create_chat(&state.db, &chat).await
}

#[tauri::command]
pub async fn list_chats(state: State<'_, AppState>) -> Result<Vec<Chat>, AppError> {
    storage::list_chats(&state.db).await
}

#[tauri::command]
pub async fn delete_chat(state: State<'_, AppState>, id: String) -> Result<(), AppError> {
    storage::delete_chat(&state.db, &id).await
}

#[tauri::command]
pub async fn rename_chat(state: State<'_, AppState>, id: String, title: String) -> Result<(), AppError> {
    storage::update_chat_title(&state.db, &id, &title).await
}

#[tauri::command]
pub async fn set_chat_project(state: State<'_, AppState>, id: String, project: Option<String>) -> Result<(), AppError> {
    storage::update_chat_project(&state.db, &id, project).await
}
