use crate::error::AppError;
use crate::models::Project;
use crate::state_logger;
use crate::storage::{self, AppState};
use tauri::State;

#[tauri::command]
pub async fn create_project(state: State<'_, AppState>, name: String) -> Result<Project, AppError> {
    let normalized = name.trim();
    if normalized.is_empty() {
        return Err(AppError::Inference(
            "Project name cannot be empty.".to_string(),
        ));
    }

    let project_id = uuid::Uuid::new_v4().to_string();
    storage::create_project(&state.db, &project_id, normalized)
        .await
        .map_err(|err| {
            state_logger::module_error("commands.projects", "create_project", &err);
            err
        })
}

#[tauri::command]
pub async fn list_projects(state: State<'_, AppState>) -> Result<Vec<Project>, AppError> {
    storage::list_projects(&state.db).await.map_err(|err| {
        state_logger::module_error("commands.projects", "list_projects", &err);
        err
    })
}

#[tauri::command]
pub async fn delete_project(state: State<'_, AppState>, id: String) -> Result<(), AppError> {
    storage::delete_project(&state.db, &id)
        .await
        .map_err(|err| {
            state_logger::module_error("commands.projects", "delete_project", &err);
            err
        })
}
