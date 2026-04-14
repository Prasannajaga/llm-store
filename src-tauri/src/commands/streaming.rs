use crate::error::AppError;
use crate::events::{GENERATION_COMPLETE, GENERATION_ERROR, TOKEN_STREAM};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;

#[derive(Clone)]
pub struct GenerationState {
    pub is_cancelled: Arc<AtomicBool>,
    pub agent_decisions: Arc<Mutex<HashMap<String, bool>>>,
}

impl Default for GenerationState {
    fn default() -> Self {
        Self {
            is_cancelled: Arc::new(AtomicBool::new(false)),
            agent_decisions: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

impl GenerationState {
    fn decision_key(request_id: &str, action_id: &str) -> String {
        format!("{}::{}", request_id.trim(), action_id.trim())
    }

    pub async fn submit_agent_decision(&self, request_id: &str, action_id: &str, approved: bool) {
        let key = Self::decision_key(request_id, action_id);
        let mut lock = self.agent_decisions.lock().await;
        lock.insert(key, approved);
    }

    pub async fn take_agent_decision(&self, request_id: &str, action_id: &str) -> Option<bool> {
        let key = Self::decision_key(request_id, action_id);
        let mut lock = self.agent_decisions.lock().await;
        lock.remove(&key)
    }
}

#[tauri::command]
pub async fn generate_stream(
    app: AppHandle,
    state: State<'_, GenerationState>,
    prompt: String,
) -> Result<(), AppError> {
    // Reset cancellation flag
    state.is_cancelled.store(false, Ordering::SeqCst);

    let is_cancelled = state.is_cancelled.clone();

    // Spawn task so we don't block
    tauri::async_runtime::spawn(async move {
        let dummy_text = format!("This is a mock response to: '{}'. In a real implementation, this would stream tokens from llama.cpp or a local inferencing engine. The response is generated token by token, allowing for a smooth typing animation effect just like ChatGPT. ", prompt);

        // Mock streaming
        let words: Vec<&str> = dummy_text.split(' ').collect();
        for word in words {
            if is_cancelled.load(Ordering::SeqCst) {
                tracing::info!("Generation cancelled by user");
                break;
            }

            let token = format!("{} ", word);

            // Emit token
            if let Err(e) = app.emit(TOKEN_STREAM, &token) {
                tracing::error!("Failed to emit token: {}", e);
                let _ = app.emit(GENERATION_ERROR, e.to_string());
                return;
            }

            // Simulate processing time
            tokio::time::sleep(Duration::from_millis(50)).await;
        }

        // Emit completion event
        let _ = app.emit(GENERATION_COMPLETE, "DONE");
    });

    Ok(())
}

#[tauri::command]
pub async fn cancel_generation(state: State<'_, GenerationState>) -> Result<(), AppError> {
    state.is_cancelled.store(true, Ordering::SeqCst);
    Ok(())
}
