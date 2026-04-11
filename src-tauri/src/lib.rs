pub mod commands;
pub mod config;
pub mod error;
pub mod events;
pub mod inference;
pub mod models;
pub mod pipeline;
pub mod state_logger;
pub mod storage;

use commands::{
    chat, feedback, knowledge, message, model, pipeline as pipeline_commands, settings, streaming,
};
use tauri::Manager;
use tracing_subscriber::EnvFilter;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut env_filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("warn"));
    for directive in ["state_logger=info", "app_lib=info", "app=info"] {
        if let Ok(parsed) = directive.parse() {
            env_filter = env_filter.add_directive(parsed);
        }
    }

    tracing_subscriber::fmt()
        .with_env_filter(env_filter)
        .init();
    state_logger::install_panic_hook();

    tracing::info!("Starting llm-store desktop application");

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let config = config::AppConfig::load().expect("Failed to load app configuration");

            // Initialize database
            tauri::async_runtime::block_on(async move {
                let db_pool = storage::init_db(&config.database_url)
                    .await
                    .expect("Failed to initialize database");

                match config::sync_llama_runtime_settings(&db_pool, &config).await {
                    Ok(runtime) => {
                        tracing::info!(
                            executable_path = %runtime.executable_path,
                            port = runtime.port,
                            context_size = runtime.context_size,
                            gpu_layers = runtime.gpu_layers,
                            threads = runtime.threads,
                            batch_size = runtime.batch_size,
                            "Applied llama runtime settings from config file"
                        );
                    }
                    Err(err) => {
                        tracing::warn!("Failed to apply llama runtime settings config: {}", err);
                    }
                }

                app.manage(storage::AppState { db: db_pool });
                app.manage(streaming::GenerationState::default());
                app.manage(model::ModelState::new(config.model_directory.clone()));
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            chat::create_chat,
            chat::list_chats,
            chat::delete_chat,
            chat::rename_chat,
            chat::set_chat_project,
            message::get_messages,
            message::save_message,
            message::delete_message,
            message::edit_message,
            model::list_models,
            model::load_model,
            model::unload_model,
            model::register_model,
            model::remove_model,
            streaming::generate_stream,
            streaming::cancel_generation,
            feedback::save_feedback,
            feedback::get_feedback,
            feedback::get_feedback_batch,
            feedback::list_all_feedback,
            settings::save_settings,
            settings::load_settings,
            settings::get_reasoning_token_config,
            settings::export_workspace_backup,
            knowledge::ingest_knowledge_file,
            knowledge::list_knowledge_documents,
            knowledge::list_knowledge_document_chunks,
            knowledge::delete_knowledge_document,
            knowledge::search_knowledge,
            knowledge::search_knowledge_vector,
            knowledge::search_knowledge_graph,
            pipeline_commands::run_chat_pipeline,
            pipeline_commands::log_prompt_preview,
            pipeline_commands::log_llama_request_payload,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
