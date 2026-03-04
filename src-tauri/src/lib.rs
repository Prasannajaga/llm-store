pub mod commands;
pub mod config;
pub mod error;
pub mod events;
pub mod inference;
pub mod models;
pub mod storage;

use commands::{chat, message, model, streaming};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    tracing::info!("Starting llm-store desktop application");

    tauri::Builder::default()
        .setup(|app| {
            let config = config::AppConfig::load().expect("Failed to load app configuration");
            
            // Initialize database
            tauri::async_runtime::block_on(async move {
                let db_pool = storage::init_db(&config.database_url)
                    .await
                    .expect("Failed to initialize database");
                
                app.manage(storage::AppState { db: db_pool });
                app.manage(streaming::GenerationState::default());
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
            streaming::generate_stream,
            streaming::cancel_generation,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
