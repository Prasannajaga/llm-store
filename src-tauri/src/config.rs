use crate::error::AppError;
use crate::models::SettingsEntry;
use crate::storage;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::env;
use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct AppConfig {
    pub app_dir: PathBuf,
    pub database_url: String,
    pub model_directory: PathBuf,
    pub gpu_layers: u32,
    pub log_level: String,
}

pub const LLAMA_RUNTIME_CONFIG_FILE: &str = "llama-runtime.json";
pub const REASONING_OPEN_MARKERS: &[&str] =
    &["<think>", "<analysis>", "<reasoning>", "<|thinking|>"];
pub const REASONING_CLOSE_MARKERS: &[&str] =
    &["</think>", "</analysis>", "</reasoning>", "<|/thinking|>"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LlamaRuntimeConfig {
    pub executable_path: String,
    pub port: u16,
    pub context_size: u32,
    pub gpu_layers: i32,
    pub threads: u32,
    pub batch_size: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReasoningTokenConfig {
    pub open_markers: Vec<String>,
    pub close_markers: Vec<String>,
}

impl LlamaRuntimeConfig {
    pub fn cpu_optimized_default() -> Self {
        let available_threads = std::thread::available_parallelism()
            .map(|count| count.get() as u32)
            .unwrap_or(4);

        let tuned_threads = available_threads.saturating_sub(1).max(2);
        let tuned_batch = if tuned_threads >= 10 { 512 } else { 256 };

        Self {
            executable_path: detect_preferred_llama_server_path(),
            port: 8080,
            context_size: 2048,
            gpu_layers: 0,
            threads: tuned_threads,
            batch_size: tuned_batch,
        }
    }

    pub fn sanitize(mut self) -> Self {
        if self.executable_path.trim().is_empty() {
            self.executable_path = detect_preferred_llama_server_path();
        }
        if self.port == 0 {
            self.port = 8080;
        }
        if self.context_size == 0 {
            self.context_size = 2048;
        }
        if self.threads == 0 {
            self.threads = std::thread::available_parallelism()
                .map(|count| count.get() as u32)
                .unwrap_or(4)
                .saturating_sub(1)
                .max(2);
        }
        if self.batch_size == 0 {
            self.batch_size = if self.threads >= 10 { 512 } else { 256 };
        }
        self
    }

    pub fn to_settings_entries(&self) -> Vec<SettingsEntry> {
        vec![
            SettingsEntry {
                key: "llamaServer.executablePath".to_string(),
                value: self.executable_path.clone(),
            },
            SettingsEntry {
                key: "llamaServer.port".to_string(),
                value: self.port.to_string(),
            },
            SettingsEntry {
                key: "llamaServer.contextSize".to_string(),
                value: self.context_size.to_string(),
            },
            SettingsEntry {
                key: "llamaServer.gpuLayers".to_string(),
                value: self.gpu_layers.to_string(),
            },
            SettingsEntry {
                key: "llamaServer.threads".to_string(),
                value: self.threads.to_string(),
            },
            SettingsEntry {
                key: "llamaServer.batchSize".to_string(),
                value: self.batch_size.to_string(),
            },
        ]
    }
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
            app_dir,
            database_url,
            model_directory,
            gpu_layers: 0,
            log_level: env::var("RUST_LOG").unwrap_or_else(|_| "info".into()),
        })
    }

    pub fn llama_runtime_config_path(&self) -> PathBuf {
        self.app_dir.join(LLAMA_RUNTIME_CONFIG_FILE)
    }
}

fn detect_preferred_llama_server_path() -> String {
    let home_candidate = dirs::home_dir()
        .map(|home| home.join("coding/llama.cpp/build/bin/llama-server"))
        .filter(|path| path.exists());

    if let Some(path) = home_candidate {
        return path.to_string_lossy().to_string();
    }

    "llama-server".to_string()
}

pub fn ensure_llama_runtime_config(config: &AppConfig) -> Result<LlamaRuntimeConfig, AppError> {
    let config_path = config.llama_runtime_config_path();
    if !config_path.exists() {
        let defaults = LlamaRuntimeConfig::cpu_optimized_default();
        let payload = serde_json::to_string_pretty(&defaults).map_err(|err| {
            AppError::Config(format!(
                "Failed to serialize llama runtime defaults: {}",
                err
            ))
        })?;
        std::fs::write(&config_path, payload).map_err(|err| {
            AppError::Config(format!(
                "Failed to create {}: {}",
                config_path.display(),
                err
            ))
        })?;
        return Ok(defaults);
    }

    let raw = std::fs::read_to_string(&config_path).map_err(|err| {
        AppError::Config(format!("Failed to read {}: {}", config_path.display(), err))
    })?;

    let parsed: LlamaRuntimeConfig = serde_json::from_str(&raw).map_err(|err| {
        AppError::Config(format!(
            "Invalid JSON in {}: {}",
            config_path.display(),
            err
        ))
    })?;

    let sanitized = parsed.clone().sanitize();
    if sanitized != parsed {
        let payload = serde_json::to_string_pretty(&sanitized).map_err(|err| {
            AppError::Config(format!(
                "Failed to serialize sanitized llama runtime config: {}",
                err
            ))
        })?;
        std::fs::write(&config_path, payload).map_err(|err| {
            AppError::Config(format!(
                "Failed to update {}: {}",
                config_path.display(),
                err
            ))
        })?;
    }

    Ok(sanitized)
}

pub async fn sync_llama_runtime_settings(
    pool: &SqlitePool,
    config: &AppConfig,
) -> Result<LlamaRuntimeConfig, AppError> {
    let runtime = ensure_llama_runtime_config(config)?;
    let entries = runtime.to_settings_entries();
    storage::save_settings_batch(pool, &entries).await?;
    Ok(runtime)
}

pub fn reasoning_token_config() -> ReasoningTokenConfig {
    ReasoningTokenConfig {
        open_markers: REASONING_OPEN_MARKERS
            .iter()
            .map(|marker| marker.to_string())
            .collect(),
        close_markers: REASONING_CLOSE_MARKERS
            .iter()
            .map(|marker| marker.to_string())
            .collect(),
    }
}
