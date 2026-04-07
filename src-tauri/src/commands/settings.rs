use crate::error::AppError;
use crate::models::SettingsEntry;
use crate::storage::{self, AppState};
use tauri::State;

#[tauri::command]
pub async fn save_settings(
    state: State<'_, AppState>,
    entries: Vec<SettingsEntry>,
) -> Result<(), AppError> {
    storage::save_settings_batch(&state.db, &entries).await
}

#[tauri::command]
pub async fn load_settings(state: State<'_, AppState>) -> Result<Vec<SettingsEntry>, AppError> {
    storage::load_all_settings(&state.db).await
}
