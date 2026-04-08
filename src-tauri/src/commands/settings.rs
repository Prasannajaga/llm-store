use crate::error::AppError;
use crate::models::SettingsEntry;
use crate::state_logger;
use crate::storage::{self, AppState};
use crate::{config, config::ReasoningTokenConfig};
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
