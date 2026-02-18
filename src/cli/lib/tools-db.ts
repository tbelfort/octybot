/**
 * Tools database — SQLite DB for tool ↔ skill ↔ agent mappings.
 * Stored at ~/.octybot/tools.db
 */
import { Database } from "bun:sqlite";
import { join } from "path";
import { OCTYBOT_HOME } from "../../memory/config";

const DB_PATH = join(OCTYBOT_HOME, "tools.db");

let _db: Database | null = null;

function getDb(): Database {
  if (_db) return _db;
  _db = new Database(DB_PATH, { create: true });
  _db.exec("PRAGMA journal_mode = WAL");
  _db.exec("PRAGMA foreign_keys = ON");
  migrate(_db);
  return _db;
}

function migrate(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tools (
      name TEXT PRIMARY KEY,
      source_path TEXT NOT NULL,
      installed_at TEXT NOT NULL,
      language TEXT,
      description TEXT
    );

    CREATE TABLE IF NOT EXISTS skills (
      name TEXT PRIMARY KEY,
      tool_name TEXT NOT NULL REFERENCES tools(name) ON DELETE CASCADE,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_tools (
      project_name TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      tool_name TEXT NOT NULL REFERENCES tools(name) ON DELETE CASCADE,
      added_at TEXT NOT NULL,
      PRIMARY KEY (project_name, agent_name, tool_name)
    );
  `);
}

// ── Tool CRUD ──

export interface ToolRecord {
  name: string;
  source_path: string;
  installed_at: string;
  language: string | null;
  description: string | null;
}

export interface SkillRecord {
  name: string;
  tool_name: string;
  content: string;
  created_at: string;
}

export interface AgentToolRecord {
  project_name: string;
  agent_name: string;
  tool_name: string;
  added_at: string;
}

export function insertTool(tool: {
  name: string;
  source_path: string;
  language?: string;
  description?: string;
}): void {
  const db = getDb();
  db.run(
    `INSERT OR REPLACE INTO tools (name, source_path, installed_at, language, description)
     VALUES (?, ?, ?, ?, ?)`,
    [tool.name, tool.source_path, new Date().toISOString(), tool.language || null, tool.description || null]
  );
}

export function insertSkill(skill: {
  name: string;
  tool_name: string;
  content: string;
}): void {
  const db = getDb();
  db.run(
    `INSERT OR REPLACE INTO skills (name, tool_name, content, created_at)
     VALUES (?, ?, ?, ?)`,
    [skill.name, skill.tool_name, skill.content, new Date().toISOString()]
  );
}

export function addAgentTool(project: string, agent: string, toolName: string): void {
  const db = getDb();
  db.run(
    `INSERT OR IGNORE INTO agent_tools (project_name, agent_name, tool_name, added_at)
     VALUES (?, ?, ?, ?)`,
    [project, agent, toolName, new Date().toISOString()]
  );
}

export function removeAgentTool(project: string, agent: string, toolName: string): void {
  const db = getDb();
  db.run(
    `DELETE FROM agent_tools WHERE project_name = ? AND agent_name = ? AND tool_name = ?`,
    [project, agent, toolName]
  );
}

export function getTool(name: string): ToolRecord | null {
  const db = getDb();
  return db.query("SELECT * FROM tools WHERE name = ?").get(name) as ToolRecord | null;
}

export function getSkill(name: string): SkillRecord | null {
  const db = getDb();
  return db.query("SELECT * FROM skills WHERE name = ?").get(name) as SkillRecord | null;
}

export function getSkillByTool(toolName: string): SkillRecord | null {
  const db = getDb();
  return db.query("SELECT * FROM skills WHERE tool_name = ?").get(toolName) as SkillRecord | null;
}

export function listAllTools(): ToolRecord[] {
  const db = getDb();
  return db.query("SELECT * FROM tools ORDER BY name").all() as ToolRecord[];
}

export function listAgentToolRecords(project: string, agent: string): AgentToolRecord[] {
  const db = getDb();
  return db.query(
    "SELECT * FROM agent_tools WHERE project_name = ? AND agent_name = ? ORDER BY tool_name"
  ).all(project, agent) as AgentToolRecord[];
}

export function listToolAgents(toolName: string): AgentToolRecord[] {
  const db = getDb();
  return db.query(
    "SELECT * FROM agent_tools WHERE tool_name = ? ORDER BY project_name, agent_name"
  ).all(toolName) as AgentToolRecord[];
}

export function deleteTool(name: string): void {
  const db = getDb();
  db.run("DELETE FROM tools WHERE name = ?", [name]);
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
