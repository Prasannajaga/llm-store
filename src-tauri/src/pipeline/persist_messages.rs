use std::time::Instant;

use chrono::Utc;
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::models::{Message, Role};
use crate::storage;

use super::types::{LayerOutcome, PipelineWarning, PipelineWarningCode};

pub const LAYER_NAME: &str = "persist_messages";

#[derive(Debug, Clone)]
pub struct PersistedMessageIds {
    pub user_message_id: String,
    pub assistant_message_id: String,
}

pub async fn run(
    pool: &SqlitePool,
    chat_id: &str,
    user_prompt: &str,
    assistant_text: &str,
) -> LayerOutcome<PersistedMessageIds> {
    let started = Instant::now();
    let now = Utc::now();
    let user_message_id = Uuid::new_v4().to_string();
    let assistant_message_id = Uuid::new_v4().to_string();

    let user_message = Message {
        id: user_message_id.clone(),
        chat_id: chat_id.to_string(),
        role: Role::User,
        content: user_prompt.to_string(),
        created_at: now,
    };

    let assistant_message = Message {
        id: assistant_message_id.clone(),
        chat_id: chat_id.to_string(),
        role: Role::Assistant,
        content: assistant_text.to_string(),
        created_at: now,
    };

    let mut warnings = Vec::new();
    let mut failed = false;

    if let Err(err) = storage::save_message(pool, &user_message).await {
        failed = true;
        warnings.push(PipelineWarning {
            code: PipelineWarningCode::PersistenceSkipped,
            layer: LAYER_NAME.to_string(),
            message: format!("Failed to persist user message: {}", err),
        });
    }

    if let Err(err) = storage::save_message(pool, &assistant_message).await {
        failed = true;
        warnings.push(PipelineWarning {
            code: PipelineWarningCode::PersistenceSkipped,
            layer: LAYER_NAME.to_string(),
            message: format!("Failed to persist assistant message: {}", err),
        });
    }

    let elapsed = started.elapsed().as_millis() as u64;
    if failed {
        LayerOutcome::failed(warnings, elapsed)
    } else {
        LayerOutcome::success(
            PersistedMessageIds {
                user_message_id,
                assistant_message_id,
            },
            elapsed,
        )
    }
}
