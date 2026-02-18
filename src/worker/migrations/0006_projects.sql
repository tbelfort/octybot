-- Projects and bots for multi-project/bot support
CREATE TABLE IF NOT EXISTS projects (
    name TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    config TEXT DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS bots (
    id TEXT PRIMARY KEY,
    project_name TEXT NOT NULL,
    bot_name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (project_name) REFERENCES projects(name)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_bots_project_name ON bots(project_name, bot_name);
