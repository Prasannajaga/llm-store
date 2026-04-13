CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_chunks_fts USING fts5(
  chunk_id UNINDEXED,
  document_id UNINDEXED,
  file_name UNINDEXED,
  content,
  tokenize = "unicode61 remove_diacritics 2"
);

-- Rebuild index content to keep migration idempotent and deterministic.
DELETE FROM knowledge_chunks_fts;
INSERT INTO knowledge_chunks_fts (chunk_id, document_id, file_name, content)
SELECT
  c.id,
  c.document_id,
  d.file_name,
  c.content
FROM knowledge_chunks c
INNER JOIN knowledge_documents d ON d.id = c.document_id;

CREATE TRIGGER IF NOT EXISTS knowledge_chunks_fts_ai
AFTER INSERT ON knowledge_chunks
BEGIN
  INSERT INTO knowledge_chunks_fts (chunk_id, document_id, file_name, content)
  SELECT
    NEW.id,
    NEW.document_id,
    COALESCE((SELECT file_name FROM knowledge_documents WHERE id = NEW.document_id), ''),
    NEW.content;
END;

CREATE TRIGGER IF NOT EXISTS knowledge_chunks_fts_ad
AFTER DELETE ON knowledge_chunks
BEGIN
  DELETE FROM knowledge_chunks_fts
  WHERE chunk_id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS knowledge_chunks_fts_au
AFTER UPDATE ON knowledge_chunks
BEGIN
  UPDATE knowledge_chunks_fts
  SET
    document_id = NEW.document_id,
    file_name = COALESCE((SELECT file_name FROM knowledge_documents WHERE id = NEW.document_id), ''),
    content = NEW.content
  WHERE chunk_id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS knowledge_documents_fts_file_name_au
AFTER UPDATE OF file_name ON knowledge_documents
BEGIN
  UPDATE knowledge_chunks_fts
  SET file_name = NEW.file_name
  WHERE document_id = NEW.id;
END;
