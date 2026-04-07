use crate::error::AppError;
use crate::models::Feedback;
use crate::storage::{self, AppState};
use tauri::State;
use uuid::Uuid;

#[tauri::command]
pub async fn save_feedback(
    state: State<'_, AppState>,
    message_id: String,
    rating: String,
    prompt: String,
    response: String,
) -> Result<(), AppError> {
    let id = Uuid::new_v4().to_string();
    storage::save_feedback(&state.db, &id, &message_id, &rating, &prompt, &response).await
}

#[tauri::command]
pub async fn get_feedback(
    state: State<'_, AppState>,
    message_id: String,
) -> Result<Option<Feedback>, AppError> {
    storage::get_feedback_by_message(&state.db, &message_id).await
}

/// Batch lookup: returns all feedback for a list of message IDs in one query.
/// This avoids the N+1 problem where the frontend would call get_feedback
/// sequentially for every assistant message.
#[tauri::command]
pub async fn get_feedback_batch(
    state: State<'_, AppState>,
    message_ids: Vec<String>,
) -> Result<Vec<Feedback>, AppError> {
    if message_ids.is_empty() {
        return Ok(vec![]);
    }
    storage::get_feedback_batch(&state.db, &message_ids).await
}

#[tauri::command]
pub async fn list_all_feedback(
    state: State<'_, AppState>,
    rating_filter: Option<String>,
) -> Result<Vec<Feedback>, AppError> {
    storage::list_all_feedback(&state.db, rating_filter.as_deref()).await
}
