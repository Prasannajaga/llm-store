use crate::error::AppError;
use crate::models::Message;
use crate::storage::{self, AppState};
use tauri::State;

#[tauri::command]
pub async fn get_messages(
    state: State<'_, AppState>,
    chat_id: String,
) -> Result<Vec<Message>, AppError> {
    storage::get_messages(&state.db, &chat_id).await
}

#[tauri::command]
pub async fn save_message(state: State<'_, AppState>, message: Message) -> Result<(), AppError> {
    storage::save_message(&state.db, &message).await
}

#[tauri::command]
pub async fn delete_message(state: State<'_, AppState>, id: String) -> Result<(), AppError> {
    storage::delete_message(&state.db, &id).await
}

#[tauri::command]
pub async fn edit_message(
    state: State<'_, AppState>,
    id: String,
    content: String,
) -> Result<(), AppError> {
    storage::update_message(&state.db, &id, &content).await
}
