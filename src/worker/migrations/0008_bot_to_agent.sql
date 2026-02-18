-- Rename bot → agent terminology
-- conversations: bot_name → agent_name
ALTER TABLE conversations RENAME COLUMN bot_name TO agent_name;

-- Create agents table (replaces bots)
CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    project_name TEXT NOT NULL,
    agent_name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (project_name) REFERENCES projects(name)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_project_name ON agents(project_name, agent_name);

-- Migrate data from bots → agents
INSERT OR IGNORE INTO agents (id, project_name, agent_name, created_at)
    SELECT id, project_name, bot_name, created_at FROM bots;

-- Drop old bots table
DROP TABLE IF EXISTS bots;

-- Migrate settings
UPDATE settings SET key = 'active_agent' WHERE key = 'active_bot';
