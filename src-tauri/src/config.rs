use crate::error::AppError;
use std::env;
use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct AppConfig {
    pub database_url: String,
    pub model_directory: PathBuf,
    pub gpu_layers: u32,
    pub log_level: String,
}

impl AppConfig {
    pub fn load() -> Result<Self, AppError> {
        let home_dir = dirs::home_dir()
            .ok_or_else(|| AppError::Config("Could not find home directory".into()))?;
        let app_dir = home_dir.join(".llm-store");
        let db_path = app_dir.join("store.db");

        // Ensure app directory exists
        if !app_dir.exists() {
            std::fs::create_dir_all(&app_dir).map_err(|e| AppError::Config(e.to_string()))?;
        }

        let database_url = format!("sqlite://{}", db_path.display());
        let model_directory = app_dir.join("models");

        if !model_directory.exists() {
            std::fs::create_dir_all(&model_directory)
                .map_err(|e| AppError::Config(e.to_string()))?;
        }

        Ok(Self {
            database_url,
            model_directory,
            gpu_layers: 0,
            log_level: env::var("RUST_LOG").unwrap_or_else(|_| "info".into()),
        })
    }
}
