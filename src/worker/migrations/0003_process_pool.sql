-- Process pool: track pre-warmed Claude CLI sessions per conversation
ALTER TABLE conversations ADD COLUMN process_status TEXT DEFAULT NULL;
ALTER TABLE conversations ADD COLUMN process_stop_requested INTEGER DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_conv_stop_requested
  ON conversations(process_stop_requested) WHERE process_stop_requested = 1;

-- Global settings (key-value)
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES
    ('process_idle_timeout_hours', '24', '2026-02-16T00:00:00.000Z'),
    ('process_pool_max', '3', '2026-02-16T00:00:00.000Z');
