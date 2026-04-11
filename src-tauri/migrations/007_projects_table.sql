CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL UNIQUE,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_projects_created_at ON projects(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chats_project ON chats(project);

-- Backfill legacy string-based chat.project values into real projects.
INSERT OR IGNORE INTO projects (id, name, created_at)
SELECT lower(hex(randomblob(16))), trim(project), datetime('now')
FROM chats
WHERE project IS NOT NULL
  AND trim(project) <> ''
GROUP BY trim(project);

UPDATE chats
SET project = (
  SELECT p.id
  FROM projects p
  WHERE p.name = trim(chats.project)
)
WHERE project IS NOT NULL
  AND trim(project) <> ''
  AND EXISTS (
    SELECT 1
    FROM projects p
    WHERE p.name = trim(chats.project)
  );
