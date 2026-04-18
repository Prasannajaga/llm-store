use sqlx::{sqlite::SqlitePoolOptions, Row, SqlitePool};

use crate::error::AppError;
use crate::models::{
    AgentFsRoot, AgentPermissionOverride, Chat, Feedback, FeedbackRating, KnowledgeDocument,
    Message, Project, Role, SettingsEntry,
};
use crate::state_logger;

async fn with_db_read<T, F>(operation: &'static str, future: F) -> Result<T, AppError>
where
    F: std::future::Future<Output = Result<T, AppError>>,
{
    state_logger::db_read(operation, future).await
}

async fn with_db_write<T, F>(operation: &'static str, future: F) -> Result<T, AppError>
where
    F: std::future::Future<Output = Result<T, AppError>>,
{
    state_logger::db_write(operation, future).await
}

#[derive(Clone)]
pub struct AppState {
    pub db: SqlitePool,
}

pub async fn init_db(database_url: &str) -> Result<SqlitePool, AppError> {
    with_db_write("storage.init_db", async {
        let url = if !database_url.contains("?mode=rwc") {
            format!("{}?mode=rwc", database_url)
        } else {
            database_url.to_string()
        };

        let pool = SqlitePoolOptions::new()
            .max_connections(5)
            .connect(&url)
            .await?;

        // Keep relational guarantees enabled even for existing workspaces.
        sqlx::query("PRAGMA foreign_keys = ON")
            .execute(&pool)
            .await?;
        sqlx::query("PRAGMA busy_timeout = 5000")
            .execute(&pool)
            .await?;
        // Best-effort performance tuning; safe to skip if unavailable.
        let _ = sqlx::query("PRAGMA journal_mode = WAL")
            .execute(&pool)
            .await;
        let _ = sqlx::query("PRAGMA synchronous = NORMAL")
            .execute(&pool)
            .await;

        // Run migrations
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .map_err(|e| AppError::Migration(e.to_string()))?;

        Ok(pool)
    })
    .await
}

// Chat operations
pub async fn create_chat(pool: &SqlitePool, chat: &Chat) -> Result<(), AppError> {
    with_db_write("storage.create_chat", async {
        sqlx::query("INSERT INTO chats (id, title, project, created_at) VALUES (?, ?, ?, ?)")
            .bind(&chat.id)
            .bind(&chat.title)
            .bind(&chat.project)
            .bind(&chat.created_at)
            .execute(pool)
            .await?;
        Ok(())
    })
    .await
}

pub async fn list_chats(pool: &SqlitePool) -> Result<Vec<Chat>, AppError> {
    with_db_read("storage.list_chats", async {
        let rows = sqlx::query(
            "SELECT id, title, project, created_at FROM chats ORDER BY created_at DESC",
        )
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
    })
    .await
}

pub async fn delete_chat(pool: &SqlitePool, id: &str) -> Result<(), AppError> {
    with_db_write("storage.delete_chat", async {
        sqlx::query("DELETE FROM chats WHERE id = ?")
            .bind(id)
            .execute(pool)
            .await?;
        Ok(())
    })
    .await
}

pub async fn update_chat_title(pool: &SqlitePool, id: &str, title: &str) -> Result<(), AppError> {
    with_db_write("storage.update_chat_title", async {
        sqlx::query("UPDATE chats SET title = ? WHERE id = ?")
            .bind(title)
            .bind(id)
            .execute(pool)
            .await?;
        Ok(())
    })
    .await
}

pub async fn update_chat_project(
    pool: &SqlitePool,
    id: &str,
    project: Option<String>,
) -> Result<(), AppError> {
    with_db_write("storage.update_chat_project", async {
        sqlx::query("UPDATE chats SET project = ? WHERE id = ?")
            .bind(project)
            .bind(id)
            .execute(pool)
            .await?;
        Ok(())
    })
    .await
}

pub async fn create_project(pool: &SqlitePool, id: &str, name: &str) -> Result<Project, AppError> {
    with_db_write("storage.create_project", async {
        sqlx::query("INSERT INTO projects (id, name, created_at) VALUES (?, ?, datetime('now'))")
            .bind(id)
            .bind(name)
            .execute(pool)
            .await?;

        let row = sqlx::query("SELECT id, name, created_at FROM projects WHERE id = ?")
            .bind(id)
            .fetch_one(pool)
            .await?;

        Ok(Project {
            id: row.get("id"),
            name: row.get("name"),
            created_at: row.get("created_at"),
        })
    })
    .await
}

pub async fn list_projects(pool: &SqlitePool) -> Result<Vec<Project>, AppError> {
    with_db_read("storage.list_projects", async {
        let rows = sqlx::query(
            "SELECT id, name, created_at FROM projects ORDER BY name COLLATE NOCASE ASC",
        )
        .fetch_all(pool)
        .await?;

        let projects = rows
            .iter()
            .map(|row| Project {
                id: row.get("id"),
                name: row.get("name"),
                created_at: row.get("created_at"),
            })
            .collect();

        Ok(projects)
    })
    .await
}

pub async fn delete_project(pool: &SqlitePool, project_id: &str) -> Result<(), AppError> {
    with_db_write("storage.delete_project", async {
        sqlx::query("UPDATE chats SET project = NULL WHERE project = ?")
            .bind(project_id)
            .execute(pool)
            .await?;

        sqlx::query("DELETE FROM projects WHERE id = ?")
            .bind(project_id)
            .execute(pool)
            .await?;

        Ok(())
    })
    .await
}

// Message operations
pub async fn get_messages(pool: &SqlitePool, chat_id: &str) -> Result<Vec<Message>, AppError> {
    with_db_read("storage.get_messages", async {
        let rows = sqlx::query(
            "SELECT id, chat_id, role, content, reasoning_content, context_payload, created_at FROM messages WHERE chat_id = ? ORDER BY created_at ASC",
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
                    reasoning_content: row.get("reasoning_content"),
                    context_payload: row.get("context_payload"),
                    created_at: row.get("created_at"),
                }
            })
            .collect();

        Ok(messages)
    })
    .await
}

pub async fn save_message(pool: &SqlitePool, message: &Message) -> Result<(), AppError> {
    with_db_write("storage.save_message", async {
        let role_str = match &message.role {
            Role::User => "user",
            Role::Assistant => "assistant",
            Role::System => "system",
        };

        sqlx::query(
            "INSERT INTO messages (id, chat_id, role, content, reasoning_content, context_payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&message.id)
        .bind(&message.chat_id)
        .bind(role_str)
        .bind(&message.content)
        .bind(&message.reasoning_content)
        .bind(&message.context_payload)
        .bind(&message.created_at)
        .execute(pool)
        .await?;
        Ok(())
    })
    .await
}

pub async fn delete_message(pool: &SqlitePool, id: &str) -> Result<(), AppError> {
    with_db_write("storage.delete_message", async {
        sqlx::query("DELETE FROM messages WHERE id = ?")
            .bind(id)
            .execute(pool)
            .await?;
        Ok(())
    })
    .await
}

pub async fn update_message(pool: &SqlitePool, id: &str, content: &str) -> Result<(), AppError> {
    with_db_write("storage.update_message", async {
        sqlx::query("UPDATE messages SET content = ? WHERE id = ?")
            .bind(content)
            .bind(id)
            .execute(pool)
            .await?;
        Ok(())
    })
    .await
}

// Registered model operations
pub async fn register_model(
    pool: &SqlitePool,
    id: &str,
    path: &str,
    display_name: &str,
) -> Result<(), AppError> {
    with_db_write("storage.register_model", async {
        sqlx::query(
            "INSERT OR IGNORE INTO registered_models (id, path, display_name) VALUES (?, ?, ?)",
        )
        .bind(id)
        .bind(path)
        .bind(display_name)
        .execute(pool)
        .await?;
        Ok(())
    })
    .await
}

pub async fn list_registered_models(pool: &SqlitePool) -> Result<Vec<String>, AppError> {
    with_db_read("storage.list_registered_models", async {
        let rows = sqlx::query("SELECT path FROM registered_models ORDER BY registered_at DESC")
            .fetch_all(pool)
            .await?;

        let paths: Vec<String> = rows.iter().map(|row| row.get("path")).collect();
        Ok(paths)
    })
    .await
}

pub async fn remove_registered_model(pool: &SqlitePool, path: &str) -> Result<(), AppError> {
    with_db_write("storage.remove_registered_model", async {
        sqlx::query("DELETE FROM registered_models WHERE path = ?")
            .bind(path)
            .execute(pool)
            .await?;
        Ok(())
    })
    .await
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
    with_db_write("storage.save_feedback", async {
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
    })
    .await
}

pub async fn get_feedback_by_message(
    pool: &SqlitePool,
    message_id: &str,
) -> Result<Option<Feedback>, AppError> {
    with_db_read("storage.get_feedback_by_message", async {
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
    })
    .await
}

pub async fn list_all_feedback(
    pool: &SqlitePool,
    rating_filter: Option<&str>,
) -> Result<Vec<Feedback>, AppError> {
    with_db_read("storage.list_all_feedback", async {
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
    })
    .await
}

/// Batch lookup: fetch all feedback rows whose message_id is in the supplied list.
/// Uses a dynamically built `IN (?, ?, …)` clause for a single round-trip.
pub async fn get_feedback_batch(
    pool: &SqlitePool,
    message_ids: &[String],
) -> Result<Vec<Feedback>, AppError> {
    with_db_read("storage.get_feedback_batch", async {
        if message_ids.is_empty() {
            return Ok(vec![]);
        }

        // Build dynamic placeholders: "?, ?, ?, …"
        let placeholders: String = message_ids
            .iter()
            .map(|_| "?")
            .collect::<Vec<_>>()
            .join(", ");
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
    })
    .await
}

// Settings operations
pub async fn save_setting(pool: &SqlitePool, key: &str, value: &str) -> Result<(), AppError> {
    with_db_write("storage.save_setting", async {
        sqlx::query(
            "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))",
        )
        .bind(key)
        .bind(value)
        .execute(pool)
        .await?;
        Ok(())
    })
    .await
}

pub async fn load_all_settings(pool: &SqlitePool) -> Result<Vec<SettingsEntry>, AppError> {
    with_db_read("storage.load_all_settings", async {
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
    })
    .await
}

pub async fn save_settings_batch(
    pool: &SqlitePool,
    entries: &[SettingsEntry],
) -> Result<(), AppError> {
    with_db_write("storage.save_settings_batch", async {
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
    })
    .await
}

pub async fn list_agent_fs_roots(pool: &SqlitePool) -> Result<Vec<AgentFsRoot>, AppError> {
    with_db_read("storage.list_agent_fs_roots", async {
        let rows = sqlx::query(
            "SELECT id, path, normalized_path, source, created_at
             FROM agent_fs_roots
             ORDER BY created_at ASC",
        )
        .fetch_all(pool)
        .await?;

        Ok(rows
            .iter()
            .map(|r| AgentFsRoot {
                id: r.get("id"),
                path: r.get("path"),
                normalized_path: r.get("normalized_path"),
                source: r.get("source"),
                created_at: r.get("created_at"),
            })
            .collect())
    })
    .await
}

pub async fn find_agent_fs_root_by_normalized_path(
    pool: &SqlitePool,
    normalized_path: &str,
) -> Result<Option<AgentFsRoot>, AppError> {
    with_db_read("storage.find_agent_fs_root_by_normalized_path", async {
        let row = sqlx::query(
            "SELECT id, path, normalized_path, source, created_at
             FROM agent_fs_roots
             WHERE normalized_path = ?",
        )
        .bind(normalized_path)
        .fetch_optional(pool)
        .await?;

        Ok(row.map(|r| AgentFsRoot {
            id: r.get("id"),
            path: r.get("path"),
            normalized_path: r.get("normalized_path"),
            source: r.get("source"),
            created_at: r.get("created_at"),
        }))
    })
    .await
}

pub async fn insert_agent_fs_root(
    pool: &SqlitePool,
    id: &str,
    path: &str,
    normalized_path: &str,
    source: &str,
) -> Result<(), AppError> {
    with_db_write("storage.insert_agent_fs_root", async {
        sqlx::query(
            "INSERT INTO agent_fs_roots (id, path, normalized_path, source, created_at, updated_at)
             VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))",
        )
        .bind(id)
        .bind(path)
        .bind(normalized_path)
        .bind(source)
        .execute(pool)
        .await?;
        Ok(())
    })
    .await
}

pub async fn delete_agent_fs_root(pool: &SqlitePool, id: &str) -> Result<(), AppError> {
    with_db_write("storage.delete_agent_fs_root", async {
        sqlx::query("DELETE FROM agent_fs_roots WHERE id = ?")
            .bind(id)
            .execute(pool)
            .await?;
        Ok(())
    })
    .await
}

pub async fn list_agent_permission_overrides(
    pool: &SqlitePool,
) -> Result<Vec<AgentPermissionOverride>, AppError> {
    with_db_read("storage.list_agent_permission_overrides", async {
        let rows = sqlx::query(
            "SELECT id, tool, pattern, normalized_pattern, action, created_at, metadata
             FROM agent_permission_overrides
             ORDER BY created_at ASC",
        )
        .fetch_all(pool)
        .await?;

        Ok(rows
            .iter()
            .map(|r| AgentPermissionOverride {
                id: r.get("id"),
                tool: r.get("tool"),
                pattern: r.get("pattern"),
                normalized_pattern: r.get("normalized_pattern"),
                action: r.get("action"),
                created_at: r.get("created_at"),
                metadata: r.get("metadata"),
            })
            .collect())
    })
    .await
}

pub async fn find_agent_permission_override(
    pool: &SqlitePool,
    tool: &str,
    action: &str,
    normalized_pattern: &str,
) -> Result<Option<AgentPermissionOverride>, AppError> {
    with_db_read("storage.find_agent_permission_override", async {
        let row = sqlx::query(
            "SELECT id, tool, pattern, normalized_pattern, action, created_at, metadata
             FROM agent_permission_overrides
             WHERE tool = ? AND action = ? AND normalized_pattern = ?
             ORDER BY created_at DESC
             LIMIT 1",
        )
        .bind(tool)
        .bind(action)
        .bind(normalized_pattern)
        .fetch_optional(pool)
        .await?;

        Ok(row.map(|r| AgentPermissionOverride {
            id: r.get("id"),
            tool: r.get("tool"),
            pattern: r.get("pattern"),
            normalized_pattern: r.get("normalized_pattern"),
            action: r.get("action"),
            created_at: r.get("created_at"),
            metadata: r.get("metadata"),
        }))
    })
    .await
}

pub async fn insert_agent_permission_override(
    pool: &SqlitePool,
    id: &str,
    tool: &str,
    pattern: &str,
    normalized_pattern: &str,
    action: &str,
    metadata: Option<&str>,
) -> Result<(), AppError> {
    with_db_write("storage.insert_agent_permission_override", async {
        sqlx::query(
            "INSERT INTO agent_permission_overrides
                (id, tool, pattern, normalized_pattern, action, created_at, metadata)
             VALUES (?, ?, ?, ?, ?, datetime('now'), ?)",
        )
        .bind(id)
        .bind(tool)
        .bind(pattern)
        .bind(normalized_pattern)
        .bind(action)
        .bind(metadata)
        .execute(pool)
        .await?;
        Ok(())
    })
    .await
}

pub async fn get_knowledge_document_id_by_path(
    pool: &SqlitePool,
    file_path: &str,
) -> Result<Option<String>, AppError> {
    with_db_read("storage.get_knowledge_document_id_by_path", async {
        let row = sqlx::query("SELECT id FROM knowledge_documents WHERE file_path = ?")
            .bind(file_path)
            .fetch_optional(pool)
            .await?;

        Ok(row.map(|r| r.get("id")))
    })
    .await
}

pub async fn insert_knowledge_document(
    pool: &SqlitePool,
    id: &str,
    file_name: &str,
    file_path: &str,
    content: &str,
    embedding: &str,
) -> Result<(), AppError> {
    with_db_write("storage.insert_knowledge_document", async {
        sqlx::query(
            "INSERT INTO knowledge_documents (id, file_name, file_path, content, embedding, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))",
        )
        .bind(id)
        .bind(file_name)
        .bind(file_path)
        .bind(content)
        .bind(embedding)
        .execute(pool)
        .await?;
        Ok(())
    })
    .await
}

pub async fn insert_knowledge_chunk(
    pool: &SqlitePool,
    id: &str,
    document_id: &str,
    chunk_index: i64,
    content: &str,
    embedding: &str,
) -> Result<(), AppError> {
    with_db_write("storage.insert_knowledge_chunk", async {
        sqlx::query(
            "INSERT INTO knowledge_chunks (id, document_id, chunk_index, content, embedding, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))",
        )
        .bind(id)
        .bind(document_id)
        .bind(chunk_index)
        .bind(content)
        .bind(embedding)
        .execute(pool)
        .await?;
        Ok(())
    })
    .await
}

pub async fn delete_knowledge_chunks_by_document(
    pool: &SqlitePool,
    document_id: &str,
) -> Result<(), AppError> {
    with_db_write("storage.delete_knowledge_chunks_by_document", async {
        sqlx::query("DELETE FROM knowledge_chunks WHERE document_id = ?")
            .bind(document_id)
            .execute(pool)
            .await?;
        Ok(())
    })
    .await
}

pub async fn delete_knowledge_document(
    pool: &SqlitePool,
    document_id: &str,
) -> Result<(), AppError> {
    with_db_write("storage.delete_knowledge_document", async {
        // Explicit chunk deletion keeps behavior reliable even if SQLite foreign key
        // constraints are disabled in an existing environment.
        delete_knowledge_chunks_by_document(pool, document_id).await?;
        sqlx::query("DELETE FROM knowledge_documents WHERE id = ?")
            .bind(document_id)
            .execute(pool)
            .await?;
        Ok(())
    })
    .await
}

pub async fn list_knowledge_documents(
    pool: &SqlitePool,
) -> Result<Vec<KnowledgeDocument>, AppError> {
    with_db_read("storage.list_knowledge_documents", async {
        let rows = sqlx::query(
            r#"
            SELECT
                d.id,
                d.file_name,
                d.file_path,
                d.created_at,
                COUNT(c.id) as chunk_count
            FROM knowledge_documents d
            LEFT JOIN knowledge_chunks c ON c.document_id = d.id
            GROUP BY d.id, d.file_name, d.file_path, d.created_at
            ORDER BY d.created_at DESC
            "#,
        )
        .fetch_all(pool)
        .await?;

        let docs = rows
            .iter()
            .map(|r| KnowledgeDocument {
                id: r.get("id"),
                file_name: r.get("file_name"),
                file_path: r.get("file_path"),
                chunk_count: r.get("chunk_count"),
                created_at: r.get("created_at"),
            })
            .collect();

        Ok(docs)
    })
    .await
}

#[derive(Debug, Clone)]
pub struct KnowledgeChunkRecord {
    pub chunk_id: String,
    pub document_id: String,
    pub chunk_index: i64,
    pub file_name: String,
    pub content: String,
    pub embedding: String,
}

#[derive(Debug, Clone)]
pub struct NewKnowledgeChunkRecord {
    pub id: String,
    pub chunk_index: i64,
    pub content: String,
    pub embedding: String,
}

pub async fn list_knowledge_chunks(
    pool: &SqlitePool,
    document_id: Option<&str>,
) -> Result<Vec<KnowledgeChunkRecord>, AppError> {
    with_db_read("storage.list_knowledge_chunks", async {
        let rows = if let Some(doc_id) = document_id {
            sqlx::query(
                r#"
                SELECT
                    c.id as chunk_id,
                    c.document_id as document_id,
                    c.chunk_index as chunk_index,
                    d.file_name as file_name,
                    c.content as content,
                    c.embedding as embedding
                FROM knowledge_chunks c
                INNER JOIN knowledge_documents d ON d.id = c.document_id
                WHERE c.document_id = ?
                ORDER BY c.chunk_index ASC
                "#,
            )
            .bind(doc_id)
            .fetch_all(pool)
            .await?
        } else {
            sqlx::query(
                r#"
                SELECT
                    c.id as chunk_id,
                    c.document_id as document_id,
                    c.chunk_index as chunk_index,
                    d.file_name as file_name,
                    c.content as content,
                    c.embedding as embedding
                FROM knowledge_chunks c
                INNER JOIN knowledge_documents d ON d.id = c.document_id
                ORDER BY d.created_at DESC, c.chunk_index ASC
                "#,
            )
            .fetch_all(pool)
            .await?
        };

        let chunks = rows
            .iter()
            .map(|r| KnowledgeChunkRecord {
                chunk_id: r.get("chunk_id"),
                document_id: r.get("document_id"),
                chunk_index: r.get("chunk_index"),
                file_name: r.get("file_name"),
                content: r.get("content"),
                embedding: r.get("embedding"),
            })
            .collect();

        Ok(chunks)
    })
    .await
}

pub async fn list_knowledge_chunks_limited(
    pool: &SqlitePool,
    document_id: Option<&str>,
    limit: usize,
) -> Result<Vec<KnowledgeChunkRecord>, AppError> {
    with_db_read("storage.list_knowledge_chunks_limited", async {
        if limit == 0 {
            return Ok(vec![]);
        }

        let rows = if let Some(doc_id) = document_id {
            sqlx::query(
                r#"
                SELECT
                    c.id as chunk_id,
                    c.document_id as document_id,
                    c.chunk_index as chunk_index,
                    d.file_name as file_name,
                    c.content as content,
                    c.embedding as embedding
                FROM knowledge_chunks c
                INNER JOIN knowledge_documents d ON d.id = c.document_id
                WHERE c.document_id = ?
                ORDER BY c.chunk_index ASC
                LIMIT ?
                "#,
            )
            .bind(doc_id)
            .bind(limit as i64)
            .fetch_all(pool)
            .await?
        } else {
            sqlx::query(
                r#"
                SELECT
                    c.id as chunk_id,
                    c.document_id as document_id,
                    c.chunk_index as chunk_index,
                    d.file_name as file_name,
                    c.content as content,
                    c.embedding as embedding
                FROM knowledge_chunks c
                INNER JOIN knowledge_documents d ON d.id = c.document_id
                ORDER BY d.created_at DESC, c.chunk_index ASC
                LIMIT ?
                "#,
            )
            .bind(limit as i64)
            .fetch_all(pool)
            .await?
        };

        let chunks = rows
            .iter()
            .map(|r| KnowledgeChunkRecord {
                chunk_id: r.get("chunk_id"),
                document_id: r.get("document_id"),
                chunk_index: r.get("chunk_index"),
                file_name: r.get("file_name"),
                content: r.get("content"),
                embedding: r.get("embedding"),
            })
            .collect();

        Ok(chunks)
    })
    .await
}

pub async fn list_knowledge_chunks_by_document_ids_limited(
    pool: &SqlitePool,
    document_ids: &[String],
    limit: usize,
) -> Result<Vec<KnowledgeChunkRecord>, AppError> {
    with_db_read(
        "storage.list_knowledge_chunks_by_document_ids_limited",
        async {
            if limit == 0 || document_ids.is_empty() {
                return Ok(vec![]);
            }

            let mut seen = std::collections::HashSet::new();
            let normalized_doc_ids = document_ids
                .iter()
                .map(|doc_id| doc_id.trim())
                .filter(|doc_id| !doc_id.is_empty())
                .filter(|doc_id| seen.insert((*doc_id).to_string()))
                .map(ToOwned::to_owned)
                .collect::<Vec<_>>();

            if normalized_doc_ids.is_empty() {
                return Ok(vec![]);
            }

            let placeholders = normalized_doc_ids
                .iter()
                .map(|_| "?")
                .collect::<Vec<_>>()
                .join(", ");
            let sql = format!(
                r#"
                SELECT
                    c.id as chunk_id,
                    c.document_id as document_id,
                    c.chunk_index as chunk_index,
                    d.file_name as file_name,
                    c.content as content,
                    c.embedding as embedding
                FROM knowledge_chunks c
                INNER JOIN knowledge_documents d ON d.id = c.document_id
                WHERE c.document_id IN ({})
                ORDER BY d.created_at DESC, c.document_id ASC, c.chunk_index ASC
                LIMIT ?
                "#,
                placeholders
            );

            let mut query = sqlx::query(&sql);
            for doc_id in &normalized_doc_ids {
                query = query.bind(doc_id);
            }
            query = query.bind(limit as i64);

            let rows = query.fetch_all(pool).await?;
            let chunks = rows
                .iter()
                .map(|r| KnowledgeChunkRecord {
                    chunk_id: r.get("chunk_id"),
                    document_id: r.get("document_id"),
                    chunk_index: r.get("chunk_index"),
                    file_name: r.get("file_name"),
                    content: r.get("content"),
                    embedding: r.get("embedding"),
                })
                .collect();

            Ok(chunks)
        },
    )
    .await
}

pub async fn insert_knowledge_document_with_chunks(
    pool: &SqlitePool,
    id: &str,
    file_name: &str,
    file_path: &str,
    content: &str,
    embedding: &str,
    chunks: &[NewKnowledgeChunkRecord],
) -> Result<(), AppError> {
    with_db_write("storage.insert_knowledge_document_with_chunks", async {
        let mut tx = pool.begin().await?;

        sqlx::query(
            "INSERT INTO knowledge_documents (id, file_name, file_path, content, embedding, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))",
        )
        .bind(id)
        .bind(file_name)
        .bind(file_path)
        .bind(content)
        .bind(embedding)
        .execute(&mut *tx)
        .await?;

        for chunk in chunks {
            sqlx::query(
                "INSERT INTO knowledge_chunks (id, document_id, chunk_index, content, embedding, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))",
            )
            .bind(&chunk.id)
            .bind(id)
            .bind(chunk.chunk_index)
            .bind(&chunk.content)
            .bind(&chunk.embedding)
            .execute(&mut *tx)
            .await?;
        }

        tx.commit().await?;
        Ok(())
    })
    .await
}

pub async fn search_knowledge_chunks_fts(
    pool: &SqlitePool,
    fts_query: &str,
    document_ids: Option<&[String]>,
    limit: usize,
) -> Result<Vec<KnowledgeChunkRecord>, AppError> {
    with_db_read("storage.search_knowledge_chunks_fts", async {
        let normalized_query = fts_query.trim();
        if normalized_query.is_empty() || limit == 0 {
            return Ok(vec![]);
        }

        let mut seen = std::collections::HashSet::new();
        let normalized_doc_ids = document_ids
            .unwrap_or(&[])
            .iter()
            .map(|doc_id| doc_id.trim())
            .filter(|doc_id| !doc_id.is_empty())
            .filter(|doc_id| seen.insert((*doc_id).to_string()))
            .map(ToOwned::to_owned)
            .collect::<Vec<_>>();

        let mut sql = String::from(
            r#"
            SELECT
                c.id as chunk_id,
                c.document_id as document_id,
                c.chunk_index as chunk_index,
                d.file_name as file_name,
                c.content as content,
                c.embedding as embedding
            FROM knowledge_chunks_fts
            INNER JOIN knowledge_chunks c ON c.id = knowledge_chunks_fts.chunk_id
            INNER JOIN knowledge_documents d ON d.id = c.document_id
            WHERE knowledge_chunks_fts MATCH ?
            "#,
        );

        if !normalized_doc_ids.is_empty() {
            let placeholders = normalized_doc_ids
                .iter()
                .map(|_| "?")
                .collect::<Vec<_>>()
                .join(", ");
            sql.push_str(&format!(" AND c.document_id IN ({})", placeholders));
        }

        sql.push_str(" ORDER BY bm25(knowledge_chunks_fts) ASC LIMIT ?");

        let mut query = sqlx::query(&sql).bind(normalized_query);
        for doc_id in &normalized_doc_ids {
            query = query.bind(doc_id);
        }
        query = query.bind(limit as i64);

        let rows = query.fetch_all(pool).await?;
        let chunks = rows
            .iter()
            .map(|r| KnowledgeChunkRecord {
                chunk_id: r.get("chunk_id"),
                document_id: r.get("document_id"),
                chunk_index: r.get("chunk_index"),
                file_name: r.get("file_name"),
                content: r.get("content"),
                embedding: r.get("embedding"),
            })
            .collect();

        Ok(chunks)
    })
    .await
}
