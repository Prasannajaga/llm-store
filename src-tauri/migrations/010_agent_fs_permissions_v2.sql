CREATE TABLE IF NOT EXISTS agent_fs_roots (
  id TEXT PRIMARY KEY NOT NULL,
  path TEXT NOT NULL,
  normalized_path TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_agent_fs_roots_normalized_path
ON agent_fs_roots(normalized_path);

CREATE TABLE IF NOT EXISTS agent_permission_overrides (
  id TEXT PRIMARY KEY NOT NULL,
  tool TEXT NOT NULL,
  pattern TEXT NOT NULL,
  normalized_pattern TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('allow', 'deny', 'ask')),
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  metadata TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_permission_overrides_tool_pattern
ON agent_permission_overrides(tool, normalized_pattern);

