use crate::error::AppError;

#[tauri::command]
pub async fn list_models() -> Result<Vec<String>, AppError> {
    Ok(vec![
        "Llama-3-8B-Instruct.Q4_K_M.gguf".to_string(),
        "Mistral-7B-Instruct-v0.2.Q5_K_M.gguf".to_string(),
    ])
}

#[tauri::command]
pub async fn load_model(model_name: String) -> Result<(), AppError> {
    tracing::info!("Loading model: {}", model_name);
    Ok(())
}

#[tauri::command]
pub async fn unload_model() -> Result<(), AppError> {
    tracing::info!("Unloading model");
    Ok(())
}
