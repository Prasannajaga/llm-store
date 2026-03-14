use crate::error::AppError;
use crate::storage::{self, AppState};
use std::sync::Mutex;
use std::process::Child;
use tauri::State;

pub struct ModelState {
    pub process: Mutex<Option<Child>>,
    pub models_dir: std::path::PathBuf,
}

impl ModelState {
    pub fn new(models_dir: std::path::PathBuf) -> Self {
        Self {
            process: Mutex::new(None),
            models_dir,
        }
    }
}

/// Scans the configured models directory for .gguf files
fn scan_local_models(models_dir: &std::path::Path) -> Vec<String> {
    let mut found = Vec::new();
    if let Ok(entries) = std::fs::read_dir(models_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                if let Some(ext) = path.extension() {
                    if ext.eq_ignore_ascii_case("gguf") {
                        if let Some(name) = path.file_name() {
                            found.push(name.to_string_lossy().to_string());
                        }
                    }
                }
            }
        }
    }
    found.sort();
    found
}

#[tauri::command]
pub async fn list_models(
    model_state: State<'_, ModelState>,
    app_state: State<'_, AppState>,
) -> Result<Vec<String>, AppError> {
    // 1. Scan local models/ directory
    let local = scan_local_models(&model_state.models_dir);

    // 2. Query registered (browsed) models from DB
    let registered = storage::list_registered_models(&app_state.db).await?;

    // 3. Merge + deduplicate (local first, then registered)
    let mut all = local;
    for path in registered {
        if !all.contains(&path) {
            all.push(path);
        }
    }

    Ok(all)
}

#[tauri::command]
pub async fn register_model(
    path: String,
    app_state: State<'_, AppState>,
) -> Result<(), AppError> {
    let display_name = std::path::Path::new(&path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.clone());

    let id = uuid::Uuid::new_v4().to_string();
    storage::register_model(&app_state.db, &id, &path, &display_name).await?;
    tracing::info!("Registered model: {} ({})", display_name, path);
    Ok(())
}

#[tauri::command]
pub async fn remove_model(
    path: String,
    app_state: State<'_, AppState>,
) -> Result<(), AppError> {
    storage::remove_registered_model(&app_state.db, &path).await?;
    tracing::info!("Removed registered model: {}", path);
    Ok(())
}

#[tauri::command]
pub async fn load_model(
    model_name: String,
    state: State<'_, ModelState>,
) -> Result<(), AppError> {
    tracing::info!("Loading model: {}", model_name);

    {
        let mut process_guard = state.process.lock().unwrap();

        // Kill existing proc if any
        if let Some(mut child) = process_guard.take() {
            tracing::info!("Killing existing model process before loading a new one");
            let _ = child.kill();
            let _ = child.wait();
        }
        
        // Spawn new proc
        #[cfg(target_os = "linux")]
        {
            let path = std::path::Path::new(&model_name);
            
            // Support both direct absolute paths from the file picker, or fallback to models/
            let model_path = if path.is_absolute() {
                model_name.clone()
            } else {
                format!("models/{}", model_name)
            };

            let child = std::process::Command::new("llama-server")
                .arg("-m")
                .arg(&model_path)
                .arg("--port")
                .arg("8080")
                .spawn()
                .map_err(|e| AppError::Inference(format!("Failed to spawn llama-server: {}", e)))?;

            *process_guard = Some(child);
        }
    }

    // Wait for the model server to become healthy
    let client = reqwest::Client::new();
    let mut retries = 0;
    
    loop {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        retries += 1;
        
        // Wait up to 60 seconds (120 retries)
        if retries > 120 {
            return Err(AppError::Inference("Model server took too long to start.".to_string()));
        }

        match client.get("http://127.0.0.1:8080/health").send().await {
            Ok(resp) if resp.status().is_success() => {
                tracing::info!("Server is healthy and ready.");
                break;
            }
            _ => {
                // If it's failing to connect, check if the process died
                let mut is_dead = false;
                if let Ok(mut lock) = state.process.lock() {
                    if let Some(child) = lock.as_mut() {
                        if let Ok(Some(status)) = child.try_wait() {
                            tracing::error!("Server process exited unexpectedly: {}", status);
                            is_dead = true;
                        }
                    }
                }
                if is_dead {
                    return Err(AppError::Inference("Model server process exited unexpectedly".to_string()));
                }
            }
        }
    }
    
    Ok(())
}

#[tauri::command]
pub async fn unload_model(state: State<'_, ModelState>) -> Result<(), AppError> {
    tracing::info!("Unloading model");
    
    let mut process_guard = state.process.lock().unwrap();
    if let Some(mut child) = process_guard.take() {
        tracing::info!("Killing running model process");
        let _ = child.kill();
        let _ = child.wait();
    }

    Ok(())
}
