/**
 * Database singleton, schema initialization, and parse utilities.
 * Extracted from db.ts.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { DB_PATH } from "./config";
import { runMigrations } from "./db-migrations";
import type { MemoryNode, Edge } from "./types";

let _db: Database | null = null;

export function getDb(): Database {
  if (_db) return _db;

  mkdirSync(dirname(DB_PATH), { recursive: true });
  _db = new Database(DB_PATH);
  _db.exec("PRAGMA journal_mode = WAL");
  initSchema(_db);
  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

export function createTestDb(path?: string): Database {
  const dbPath = path || ":memory:";
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  initSchema(db);
  return db;
}

export function initSchema(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY,
      node_type TEXT NOT NULL,
      subtype TEXT,
      content TEXT NOT NULL,
      salience REAL DEFAULT 1.0,
      confidence REAL DEFAULT 1.0,
      source TEXT DEFAULT 'user',
      created_at TEXT DEFAULT (datetime('now')),
      valid_from TEXT,
      valid_until TEXT,
      superseded_by TEXT,
      attributes TEXT DEFAULT '{}',
      can_summarize INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS edges (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES nodes(id),
      target_id TEXT NOT NULL REFERENCES nodes(id),
      edge_type TEXT NOT NULL,
      attributes TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(node_type);
    CREATE INDEX IF NOT EXISTS idx_nodes_subtype ON nodes(subtype);
    CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
    CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
    CREATE INDEX IF NOT EXISTS idx_edges_type ON edges(edge_type);

    CREATE TABLE IF NOT EXISTS embeddings (
      node_id TEXT PRIMARY KEY REFERENCES nodes(id),
      node_type TEXT NOT NULL,
      vector BLOB NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  runMigrations(db);
}

export function uuid(): string {
  return crypto.randomUUID();
}

export function parseNode(row: Record<string, unknown>): MemoryNode {
  return {
    id: row.id as string,
    node_type: row.node_type as MemoryNode["node_type"],
    subtype: row.subtype as string | undefined,
    content: row.content as string,
    salience: row.salience as number,
    confidence: row.confidence as number,
    source: row.source as "user" | "claude",
    created_at: row.created_at as string,
    valid_from: row.valid_from as string | undefined,
    valid_until: row.valid_until as string | undefined,
    superseded_by: row.superseded_by as string | undefined,
    attributes: JSON.parse((row.attributes as string) || "{}"),
    can_summarize: row.can_summarize as number | undefined,
    scope: row.scope as number | undefined,
  };
}

export function parseEdge(row: Record<string, unknown>): Edge {
  return {
    id: row.id as string,
    source_id: row.source_id as string,
    target_id: row.target_id as string,
    edge_type: row.edge_type as string,
    attributes: JSON.parse((row.attributes as string) || "{}"),
    created_at: row.created_at as string,
  };
}

export function stemWord(word: string): string {
  const w = word.toLowerCase();
  if (w.length <= 3) return w;
  for (const suffix of ["ting", "sing", "ning", "ling", "ring", "ding", "ping", "ying"]) {
    if (w.endsWith(suffix) && w.length > suffix.length + 2)
      return w.slice(0, -suffix.length);
  }
  for (const suffix of ["ied", "ies", "ing", "ed", "er", "es", "ly"]) {
    if (w.endsWith(suffix) && w.length > suffix.length + 2)
      return w.slice(0, -suffix.length);
  }
  if (w.endsWith("s") && !w.endsWith("ss") && w.length > 4)
    return w.slice(0, -1);
  return w;
}
