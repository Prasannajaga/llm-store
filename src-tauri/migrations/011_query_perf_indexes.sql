CREATE INDEX IF NOT EXISTS idx_messages_chat_id_created_at
ON messages(chat_id, created_at);

CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_document_chunk
ON knowledge_chunks(document_id, chunk_index);
