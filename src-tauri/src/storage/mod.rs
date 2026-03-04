use sqlx::{sqlite::SqlitePoolOptions, Row, SqlitePool};

use crate::error::AppError;
use crate::models::{Chat, Message, Role};

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
