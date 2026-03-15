use sqlx::{sqlite::SqlitePoolOptions, Row, SqlitePool};

use crate::error::AppError;
use crate::models::{Chat, Feedback, FeedbackRating, Message, Role, SettingsEntry};

#[derive(Clone)]
pub struct AppState {
    pub db: SqlitePool,
}

pub async fn init_db(database_url: &str) -> Result<SqlitePool, AppError> {
    let url = if !database_url.contains("?mode=rwc") {
        format!("{}?mode=rwc", database_url)
    } else {
        database_url.to_string()
    };

    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect(&url)
        .await?;

    // Run migrations
    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .map_err(|e| AppError::Migration(e.to_string()))?;

    Ok(pool)
}

// Chat operations
pub async fn create_chat(pool: &SqlitePool, chat: &Chat) -> Result<(), AppError> {
    sqlx::query("INSERT INTO chats (id, title, project, created_at) VALUES (?, ?, ?, ?)")
        .bind(&chat.id)
        .bind(&chat.title)
        .bind(&chat.project)
        .bind(&chat.created_at)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn list_chats(pool: &SqlitePool) -> Result<Vec<Chat>, AppError> {
    let rows = sqlx::query("SELECT id, title, project, created_at FROM chats ORDER BY created_at DESC")
        .fetch_all(pool)
        .await?;

    let chats = rows
        .iter()
        .map(|row| Chat {
            id: row.get("id"),
            title: row.get("title"),
            project: row.get("project"),
            created_at: row.get("created_at"),
        })
        .collect();

    Ok(chats)
}

pub async fn delete_chat(pool: &SqlitePool, id: &str) -> Result<(), AppError> {
    sqlx::query("DELETE FROM chats WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn update_chat_title(pool: &SqlitePool, id: &str, title: &str) -> Result<(), AppError> {
    sqlx::query("UPDATE chats SET title = ? WHERE id = ?")
        .bind(title)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn update_chat_project(pool: &SqlitePool, id: &str, project: Option<String>) -> Result<(), AppError> {
    sqlx::query("UPDATE chats SET project = ? WHERE id = ?")
        .bind(project)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

// Message operations
pub async fn get_messages(pool: &SqlitePool, chat_id: &str) -> Result<Vec<Message>, AppError> {
    let rows = sqlx::query(
        "SELECT id, chat_id, role, content, created_at FROM messages WHERE chat_id = ? ORDER BY created_at ASC",
    )
    .bind(chat_id)
    .fetch_all(pool)
    .await?;

    let messages = rows
        .iter()
        .map(|row| {
            let role_str: String = row.get("role");
            let role = match role_str.as_str() {
                "user" => Role::User,
                "assistant" => Role::Assistant,
                "system" => Role::System,
                _ => Role::User,
            };

            Message {
                id: row.get("id"),
                chat_id: row.get("chat_id"),
                role,
                content: row.get("content"),
                created_at: row.get("created_at"),
            }
        })
        .collect();

    Ok(messages)
}

pub async fn save_message(pool: &SqlitePool, message: &Message) -> Result<(), AppError> {
    let role_str = match &message.role {
        Role::User => "user",
        Role::Assistant => "assistant",
        Role::System => "system",
    };

    sqlx::query(
        "INSERT INTO messages (id, chat_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(&message.id)
    .bind(&message.chat_id)
    .bind(role_str)
    .bind(&message.content)
    .bind(&message.created_at)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn delete_message(pool: &SqlitePool, id: &str) -> Result<(), AppError> {
    sqlx::query("DELETE FROM messages WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn update_message(pool: &SqlitePool, id: &str, content: &str) -> Result<(), AppError> {
    sqlx::query("UPDATE messages SET content = ? WHERE id = ?")
        .bind(content)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

// Registered model operations
pub async fn register_model(pool: &SqlitePool, id: &str, path: &str, display_name: &str) -> Result<(), AppError> {
    sqlx::query(
        "INSERT OR IGNORE INTO registered_models (id, path, display_name) VALUES (?, ?, ?)",
    )
    .bind(id)
    .bind(path)
    .bind(display_name)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn list_registered_models(pool: &SqlitePool) -> Result<Vec<String>, AppError> {
    let rows = sqlx::query("SELECT path FROM registered_models ORDER BY registered_at DESC")
        .fetch_all(pool)
        .await?;

    let paths: Vec<String> = rows.iter().map(|row| row.get("path")).collect();
    Ok(paths)
}

pub async fn remove_registered_model(pool: &SqlitePool, path: &str) -> Result<(), AppError> {
    sqlx::query("DELETE FROM registered_models WHERE path = ?")
        .bind(path)
        .execute(pool)
        .await?;
    Ok(())
}

// Feedback operations
pub async fn save_feedback(
    pool: &SqlitePool,
    id: &str,
    message_id: &str,
    rating: &str,
    prompt: &str,
    response: &str,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT OR REPLACE INTO feedback (id, message_id, rating, prompt, response) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(id)
    .bind(message_id)
    .bind(rating)
    .bind(prompt)
    .bind(response)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn get_feedback_by_message(
    pool: &SqlitePool,
    message_id: &str,
) -> Result<Option<Feedback>, AppError> {
    let row = sqlx::query(
        "SELECT id, message_id, rating, prompt, response, created_at FROM feedback WHERE message_id = ?",
    )
    .bind(message_id)
    .fetch_optional(pool)
    .await?;

    Ok(row.map(|r| {
        let rating_str: String = r.get("rating");
        let rating = match rating_str.as_str() {
            "good" => FeedbackRating::Good,
            _ => FeedbackRating::Bad,
        };
        Feedback {
            id: r.get("id"),
            message_id: r.get("message_id"),
            rating,
            prompt: r.get("prompt"),
            response: r.get("response"),
            created_at: r.get("created_at"),
        }
    }))
}

pub async fn list_all_feedback(
    pool: &SqlitePool,
    rating_filter: Option<&str>,
) -> Result<Vec<Feedback>, AppError> {
    let rows = if let Some(rating) = rating_filter {
        sqlx::query(
            "SELECT id, message_id, rating, prompt, response, created_at FROM feedback WHERE rating = ? ORDER BY created_at DESC",
        )
        .bind(rating)
        .fetch_all(pool)
        .await?
    } else {
        sqlx::query(
            "SELECT id, message_id, rating, prompt, response, created_at FROM feedback ORDER BY created_at DESC",
        )
        .fetch_all(pool)
        .await?
    };

    let feedbacks = rows
        .iter()
        .map(|r| {
            let rating_str: String = r.get("rating");
            let rating = match rating_str.as_str() {
                "good" => FeedbackRating::Good,
                _ => FeedbackRating::Bad,
            };
            Feedback {
                id: r.get("id"),
                message_id: r.get("message_id"),
                rating,
                prompt: r.get("prompt"),
                response: r.get("response"),
                created_at: r.get("created_at"),
            }
        })
        .collect();

    Ok(feedbacks)
}

/// Batch lookup: fetch all feedback rows whose message_id is in the supplied list.
/// Uses a dynamically built `IN (?, ?, …)` clause for a single round-trip.
pub async fn get_feedback_batch(
    pool: &SqlitePool,
    message_ids: &[String],
) -> Result<Vec<Feedback>, AppError> {
    if message_ids.is_empty() {
        return Ok(vec![]);
    }

    // Build dynamic placeholders: "?, ?, ?, …"
    let placeholders: String = message_ids.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
    let sql = format!(
        "SELECT id, message_id, rating, prompt, response, created_at FROM feedback WHERE message_id IN ({})",
        placeholders
    );

    let mut query = sqlx::query(&sql);
    for mid in message_ids {
        query = query.bind(mid);
    }

    let rows = query.fetch_all(pool).await?;

    let feedbacks = rows
        .iter()
        .map(|r| {
            let rating_str: String = r.get("rating");
            let rating = match rating_str.as_str() {
                "good" => FeedbackRating::Good,
                _ => FeedbackRating::Bad,
            };
            Feedback {
                id: r.get("id"),
                message_id: r.get("message_id"),
                rating,
                prompt: r.get("prompt"),
                response: r.get("response"),
                created_at: r.get("created_at"),
            }
        })
        .collect();

    Ok(feedbacks)
}

// Settings operations
pub async fn save_setting(pool: &SqlitePool, key: &str, value: &str) -> Result<(), AppError> {
    sqlx::query(
        "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))",
    )
    .bind(key)
    .bind(value)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn load_all_settings(pool: &SqlitePool) -> Result<Vec<SettingsEntry>, AppError> {
    let rows = sqlx::query("SELECT key, value FROM settings")
        .fetch_all(pool)
        .await?;

    let settings = rows
        .iter()
        .map(|r| SettingsEntry {
            key: r.get("key"),
            value: r.get("value"),
        })
        .collect();

    Ok(settings)
}

pub async fn save_settings_batch(
    pool: &SqlitePool,
    entries: &[SettingsEntry],
) -> Result<(), AppError> {
    let mut tx = pool.begin().await?;
    for entry in entries {
        sqlx::query(
            "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))",
        )
        .bind(&entry.key)
        .bind(&entry.value)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}
