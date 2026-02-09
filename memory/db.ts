import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { DB_PATH } from "./config";
import type { MemoryNode, Edge } from "./types";

/**
 * Lightweight English stemmer for LIKE matching.
 * Strips common verb/noun suffixes so "missed" matches "misses", "writing" matches "writer", etc.
 */
function stemWord(word: string): string {
  const w = word.toLowerCase();
  if (w.length <= 3) return w;
  // Order matters: try longer suffixes first
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

function initSchema(db: Database) {
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

  // Migration: add can_summarize column for existing DBs
  try { db.exec("ALTER TABLE nodes ADD COLUMN can_summarize INTEGER DEFAULT 1"); } catch {}
}

function uuid(): string {
  return crypto.randomUUID();
}

function parseNode(row: Record<string, unknown>): MemoryNode {
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
  };
}

function parseEdge(row: Record<string, unknown>): Edge {
  return {
    id: row.id as string,
    source_id: row.source_id as string,
    target_id: row.target_id as string,
    edge_type: row.edge_type as string,
    attributes: JSON.parse((row.attributes as string) || "{}"),
    created_at: row.created_at as string,
  };
}

// --- CRUD ---

export function createNode(
  node: Omit<MemoryNode, "id" | "created_at">
): string {
  const db = getDb();
  const id = uuid();
  // Hardcoded override: instructions and tool_usage are never summarizable
  const canSummarize = (node.subtype === "instruction" || node.subtype === "tool_usage")
    ? 0
    : (node.can_summarize ?? 1);
  db.prepare(
    `INSERT INTO nodes (id, node_type, subtype, content, salience, confidence, source, valid_from, valid_until, superseded_by, attributes, can_summarize)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    node.node_type,
    node.subtype ?? null,
    node.content,
    node.salience,
    node.confidence,
    node.source,
    node.valid_from ?? null,
    node.valid_until ?? null,
    node.superseded_by ?? null,
    JSON.stringify(node.attributes),
    canSummarize
  );
  return id;
}

export function createEdge(
  edge: Omit<Edge, "id" | "created_at">
): string {
  const db = getDb();
  const id = uuid();
  db.prepare(
    `INSERT INTO edges (id, source_id, target_id, edge_type, attributes)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    id,
    edge.source_id,
    edge.target_id,
    edge.edge_type,
    JSON.stringify(edge.attributes ?? {})
  );
  return id;
}

export function getNode(id: string): MemoryNode | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM nodes WHERE id = ?")
    .get(id) as Record<string, unknown> | null;
  return row ? parseNode(row) : null;
}

export function findEntitiesByName(name: string): MemoryNode[] {
  const db = getDb();
  // Strip common suffixes that L1 might append
  const cleaned = name.replace(/\s+(project|account|client|tool|team|company|org)$/i, "");
  const pattern = `%${cleaned}%`;
  const startPattern = `${cleaned}%`;
  // Prioritize entities whose content starts with the name (exact name match),
  // then sort by salience within each group
  const rows = db
    .prepare(
      `SELECT *, CASE WHEN content LIKE ? THEN 1 ELSE 0 END AS name_match
       FROM nodes
       WHERE node_type = 'entity'
         AND superseded_by IS NULL
         AND (content LIKE ? OR attributes LIKE ?)
       ORDER BY name_match DESC, salience DESC`
    )
    .all(startPattern, pattern, pattern) as Record<string, unknown>[];
  return rows.map(parseNode);
}

export function getRelationships(
  nodeId: string
): Array<{ edge: Edge; target: MemoryNode }> {
  const db = getDb();
  // Get edges where this node is the source
  const outgoing = db
    .prepare(
      `SELECT e.*, n.id as t_id, n.node_type as t_node_type, n.subtype as t_subtype,
              n.content as t_content, n.salience as t_salience, n.confidence as t_confidence,
              n.source as t_source, n.created_at as t_created_at, n.attributes as t_attributes
       FROM edges e JOIN nodes n ON e.target_id = n.id
       WHERE e.source_id = ? AND n.superseded_by IS NULL`
    )
    .all(nodeId) as Record<string, unknown>[];

  // Get edges where this node is the target (reverse relationships)
  const incoming = db
    .prepare(
      `SELECT e.*, n.id as t_id, n.node_type as t_node_type, n.subtype as t_subtype,
              n.content as t_content, n.salience as t_salience, n.confidence as t_confidence,
              n.source as t_source, n.created_at as t_created_at, n.attributes as t_attributes
       FROM edges e JOIN nodes n ON e.source_id = n.id
       WHERE e.target_id = ? AND n.superseded_by IS NULL`
    )
    .all(nodeId) as Record<string, unknown>[];

  const results: Array<{ edge: Edge; target: MemoryNode }> = [];

  for (const row of outgoing) {
    results.push({
      edge: parseEdge(row),
      target: parseNode({
        id: row.t_id,
        node_type: row.t_node_type,
        subtype: row.t_subtype,
        content: row.t_content,
        salience: row.t_salience,
        confidence: row.t_confidence,
        source: row.t_source,
        created_at: row.t_created_at,
        attributes: row.t_attributes,
      }),
    });
  }

  for (const row of incoming) {
    results.push({
      edge: parseEdge(row),
      target: parseNode({
        id: row.t_id,
        node_type: row.t_node_type,
        subtype: row.t_subtype,
        content: row.t_content,
        salience: row.t_salience,
        confidence: row.t_confidence,
        source: row.t_source,
        created_at: row.t_created_at,
        attributes: row.t_attributes,
      }),
    });
  }

  return results;
}

export function getFactsByEntity(entityId: string): MemoryNode[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT DISTINCT n.* FROM nodes n
       JOIN edges e ON (e.target_id = n.id OR e.source_id = n.id)
       WHERE n.node_type IN ('fact', 'opinion')
         AND n.superseded_by IS NULL
         AND (e.source_id = ? OR e.target_id = ?)
       ORDER BY n.salience DESC`
    )
    .all(entityId, entityId) as Record<string, unknown>[];
  return rows.map(parseNode);
}

export function getEventsByEntity(
  entityId: string,
  days?: number
): MemoryNode[] {
  const db = getDb();
  let query = `SELECT DISTINCT n.* FROM nodes n
       JOIN edges e ON (e.target_id = n.id OR e.source_id = n.id)
       WHERE n.node_type = 'event'
         AND n.superseded_by IS NULL
         AND (e.source_id = ? OR e.target_id = ?)`;

  const params: unknown[] = [entityId, entityId];

  if (days) {
    query += ` AND n.created_at >= datetime('now', ?)`;
    params.push(`-${days} days`);
  }

  query += ` ORDER BY n.created_at DESC`;

  const rows = db.prepare(query).all(...params) as Record<string, unknown>[];
  return rows.map(parseNode);
}

export function getInstructions(topic?: string): MemoryNode[] {
  const db = getDb();

  if (!topic) {
    const rows = db
      .prepare(
        `SELECT * FROM nodes
         WHERE subtype IN ('instruction', 'tool_usage')
           AND superseded_by IS NULL
         ORDER BY salience DESC`
      )
      .all() as Record<string, unknown>[];
    return rows.map(parseNode);
  }

  // Split topic into words, stem each, use OR logic with relevance ranking.
  // "writer deadline policy" matches "When a writer misses a deadline..."
  // because 2 of 3 words match — ranked higher than 1-word matches.
  const words = topic.trim().split(/\s+/).filter(w => w.length > 2);
  if (words.length === 0) {
    return [];
  }

  // Build: (content LIKE ? OR content LIKE ? OR ...) with a match-count score
  const conditions = words.map(() => `(content LIKE ?)`);
  const matchScore = words.map(() => `(CASE WHEN content LIKE ? THEN 1 ELSE 0 END)`).join(" + ");
  const params: unknown[] = [];
  // First set: for the OR filter (at least one word must match)
  for (const word of words) {
    params.push(`%${stemWord(word)}%`);
  }
  // Second set: for the match score calculation
  for (const word of words) {
    params.push(`%${stemWord(word)}%`);
  }

  const query = `SELECT *, (${matchScore}) as match_score FROM nodes
       WHERE subtype IN ('instruction', 'tool_usage')
         AND superseded_by IS NULL
         AND (${conditions.join(" OR ")})
       ORDER BY match_score DESC, salience DESC`;

  const rows = db.prepare(query).all(...params) as Record<string, unknown>[];
  return rows.map(parseNode);
}

export function supersedeNode(oldId: string, newContent: string): string {
  const db = getDb();
  const oldNode = getNode(oldId);
  if (!oldNode) throw new Error(`Node ${oldId} not found`);

  // Create replacement node
  const newId = createNode({
    node_type: oldNode.node_type,
    subtype: oldNode.subtype,
    content: newContent,
    salience: oldNode.salience,
    confidence: oldNode.confidence,
    source: oldNode.source,
    attributes: oldNode.attributes,
  });

  // Mark old node as superseded
  db.prepare("UPDATE nodes SET superseded_by = ? WHERE id = ?").run(
    newId,
    oldId
  );

  // Copy edges to new node
  const outEdges = db
    .prepare("SELECT * FROM edges WHERE source_id = ?")
    .all(oldId) as Record<string, unknown>[];
  const inEdges = db
    .prepare("SELECT * FROM edges WHERE target_id = ?")
    .all(oldId) as Record<string, unknown>[];

  for (const edge of outEdges) {
    createEdge({
      source_id: newId,
      target_id: edge.target_id as string,
      edge_type: edge.edge_type as string,
      attributes: JSON.parse((edge.attributes as string) || "{}"),
    });
  }

  for (const edge of inEdges) {
    createEdge({
      source_id: edge.source_id as string,
      target_id: newId,
      edge_type: edge.edge_type as string,
      attributes: JSON.parse((edge.attributes as string) || "{}"),
    });
  }

  return newId;
}
