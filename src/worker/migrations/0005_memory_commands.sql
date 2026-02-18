CREATE TABLE IF NOT EXISTS memory_commands (
    id TEXT PRIMARY KEY,
    command TEXT NOT NULL,
    args TEXT DEFAULT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    result TEXT DEFAULT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_cmd_status ON memory_commands(status);
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('memory_enabled', '1', datetime('now'));
