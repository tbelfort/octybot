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
  // Migration: add scope column for instruction retrieval
  try { db.exec("ALTER TABLE nodes ADD COLUMN scope REAL DEFAULT NULL"); } catch {}
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
    scope: row.scope as number | undefined,
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
  // Hardcoded override: instructions and plans are never summarizable (need exact dates/wording)
  const canSummarize = (node.node_type === "instruction" || node.node_type === "plan")
    ? 0
    : (node.can_summarize ?? 1);
  // Scope defaults: instructions 0.5, plans 0.3, others null unless set
  const scope = node.node_type === "instruction"
    ? (node.scope ?? 0.5)
    : node.node_type === "plan"
    ? (node.scope ?? 0.3)
    : (node.scope ?? null);
  db.prepare(
    `INSERT INTO nodes (id, node_type, subtype, content, salience, confidence, source, valid_from, valid_until, superseded_by, attributes, can_summarize, scope)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
    canSummarize,
    scope
  );
  return id;
}

export function createEdge(
  edge: Omit<Edge, "id" | "created_at">
): string {
  const db = getDb();
  // Verify both nodes exist before creating edge
  const sourceExists = db.prepare("SELECT 1 FROM nodes WHERE id = ?").get(edge.source_id);
  const targetExists = db.prepare("SELECT 1 FROM nodes WHERE id = ?").get(edge.target_id);
  if (!sourceExists || !targetExists) {
    const missing = !sourceExists ? edge.source_id : edge.target_id;
    console.error(`[db] Skipping edge creation: node ${missing} not found`);
    return "";
  }
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

export function getRelationships(
  nodeId: string
): Array<{ edge: Edge; target: MemoryNode }> {
  const db = getDb();
  // Get edges where this node is the source
  const outgoing = db
    .prepare(
      `SELECT e.*, n.id as t_id, n.node_type as t_node_type, n.subtype as t_subtype,
              n.content as t_content, n.salience as t_salience, n.confidence as t_confidence,
              n.source as t_source, n.created_at as t_created_at, n.attributes as t_attributes,
              n.can_summarize as t_can_summarize, n.scope as t_scope
       FROM edges e JOIN nodes n ON e.target_id = n.id
       WHERE e.source_id = ? AND n.superseded_by IS NULL`
    )
    .all(nodeId) as Record<string, unknown>[];

  // Get edges where this node is the target (reverse relationships)
  const incoming = db
    .prepare(
      `SELECT e.*, n.id as t_id, n.node_type as t_node_type, n.subtype as t_subtype,
              n.content as t_content, n.salience as t_salience, n.confidence as t_confidence,
              n.source as t_source, n.created_at as t_created_at, n.attributes as t_attributes,
              n.can_summarize as t_can_summarize, n.scope as t_scope
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
        can_summarize: row.t_can_summarize,
        scope: row.t_scope,
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
        can_summarize: row.t_can_summarize,
        scope: row.t_scope,
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

export function getRecentEventIds(days: number): string[] {
  const db = getDb();
  const rows = db.prepare(
    `SELECT id FROM nodes
     WHERE node_type IN ('event', 'plan') AND superseded_by IS NULL
       AND created_at >= datetime('now', ?)
     ORDER BY created_at DESC`
  ).all(`-${days} days`) as { id: string }[];
  return rows.map(r => r.id);
}

export function getEventsByEntity(
  entityId: string,
  days?: number
): MemoryNode[] {
  const db = getDb();
  let query = `SELECT DISTINCT n.* FROM nodes n
       JOIN edges e ON (e.target_id = n.id OR e.source_id = n.id)
       WHERE n.node_type IN ('event', 'plan')
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
         WHERE node_type = 'instruction'
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
       WHERE node_type = 'instruction'
         AND superseded_by IS NULL
         AND (${conditions.join(" OR ")})
       ORDER BY match_score DESC, salience DESC`;

  const rows = db.prepare(query).all(...params) as Record<string, unknown>[];
  return rows.map(parseNode);
}

export function getGlobalInstructions(limit: number = 20): MemoryNode[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM nodes
       WHERE node_type = 'instruction'
         AND scope >= 0.8
         AND superseded_by IS NULL
       ORDER BY scope DESC, salience DESC
       LIMIT ?`
    )
    .all(limit) as Record<string, unknown>[];
  return rows.map(parseNode);
}

export function getInstructionsByEntity(entityId: string): MemoryNode[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT DISTINCT n.* FROM nodes n
       JOIN edges e ON (e.target_id = n.id OR e.source_id = n.id)
       WHERE n.node_type = 'instruction'
         AND n.superseded_by IS NULL
         AND (e.source_id = ? OR e.target_id = ?)
       ORDER BY n.scope DESC, n.salience DESC`
    )
    .all(entityId, entityId) as Record<string, unknown>[];
  return rows.map(parseNode);
}

export function deleteNode(id: string): boolean {
  const db = getDb();
  const node = getNode(id);
  if (!node) return false;

  // Delete edges referencing this node
  db.prepare("DELETE FROM edges WHERE source_id = ? OR target_id = ?").run(id, id);
  // Delete embedding
  db.prepare("DELETE FROM embeddings WHERE node_id = ?").run(id);
  // Delete the node itself
  db.prepare("DELETE FROM nodes WHERE id = ?").run(id);
  return true;
}

export function supersedeNode(oldId: string, newContent: string): string {
  const db = getDb();
  const oldNode = getNode(oldId);
  if (!oldNode) throw new Error(`Node ${oldId} not found`);

  // Validate replacement content isn't garbled
  const stripped = newContent.replace(/[.\s]/g, "");
  if (stripped.length < newContent.length * 0.3) {
    throw new Error(`Replacement content looks garbled: "${newContent.slice(0, 80)}"`);
  }
  if (newContent.trim().length < 10 && oldNode.node_type !== "entity") {
    throw new Error(`Replacement content too short: "${newContent}"`);
  }

  // Create replacement node
  const newId = createNode({
    node_type: oldNode.node_type,
    subtype: oldNode.subtype,
    content: newContent,
    salience: oldNode.salience,
    confidence: oldNode.confidence,
    source: oldNode.source,
    attributes: oldNode.attributes,
    scope: oldNode.scope,
  });

  // Mark old node as superseded
  db.prepare("UPDATE nodes SET superseded_by = ? WHERE id = ?").run(
    newId,
    oldId
  );

  // Copy edges to new node — deduplicate by (target, edge_type) pair to prevent
  // duplicate edges when old node had both in/out edges to the same target
  const outEdges = db
    .prepare("SELECT * FROM edges WHERE source_id = ?")
    .all(oldId) as Record<string, unknown>[];
  const inEdges = db
    .prepare("SELECT * FROM edges WHERE target_id = ?")
    .all(oldId) as Record<string, unknown>[];

  const seenEdgeIds = new Set<string>();
  const seenTargets = new Set<string>(); // "targetId:edgeType" dedup key

  for (const edge of outEdges) {
    const eid = edge.id as string;
    if (seenEdgeIds.has(eid)) continue;
    seenEdgeIds.add(eid);
    const targetId = edge.target_id as string;
    const edgeType = edge.edge_type as string;
    const dedupKey = `${targetId}:${edgeType}`;
    if (seenTargets.has(dedupKey)) continue;
    seenTargets.add(dedupKey);
    createEdge({
      source_id: newId,
      target_id: targetId,
      edge_type: edgeType,
      attributes: JSON.parse((edge.attributes as string) || "{}"),
    });
  }

  for (const edge of inEdges) {
    const eid = edge.id as string;
    if (seenEdgeIds.has(eid)) continue;
    seenEdgeIds.add(eid);
    const sourceId = edge.source_id as string;
    const edgeType = edge.edge_type as string;
    const dedupKey = `${sourceId}:${edgeType}`;
    if (seenTargets.has(dedupKey)) continue;
    seenTargets.add(dedupKey);
    createEdge({
      source_id: sourceId,
      target_id: newId,
      edge_type: edgeType,
      attributes: JSON.parse((edge.attributes as string) || "{}"),
    });
  }

  return newId;
}

/**
 * Promote a plan node to an event if its valid_from date has passed.
 * Updates both the nodes and embeddings tables.
 * Returns the updated node, or null if not eligible for promotion.
 */
export function promotePlanToEvent(nodeId: string): MemoryNode | null {
  const db = getDb();
  const node = getNode(nodeId);
  if (!node || node.node_type !== "plan" || !node.valid_from) return null;

  const now = new Date();
  const validFrom = new Date(node.valid_from);
  if (validFrom > now) return null; // not yet past

  db.prepare(
    `UPDATE nodes SET node_type = 'event', subtype = 'completed_plan' WHERE id = ?`
  ).run(nodeId);
  db.prepare(
    `UPDATE embeddings SET node_type = 'event' WHERE node_id = ?`
  ).run(nodeId);

  return getNode(nodeId);
}

/**
 * Get plan nodes connected to a specific entity via edges, sorted by valid_from ascending.
 */
export function getPlansByEntity(entityId: string): MemoryNode[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT DISTINCT n.* FROM nodes n
       JOIN edges e ON (e.target_id = n.id OR e.source_id = n.id)
       WHERE n.node_type = 'plan'
         AND n.superseded_by IS NULL
         AND (e.source_id = ? OR e.target_id = ?)
       ORDER BY n.valid_from ASC`
    )
    .all(entityId, entityId) as Record<string, unknown>[];
  return rows.map(parseNode);
}
