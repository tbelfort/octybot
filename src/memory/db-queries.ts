/**
 * Query functions for the memory graph.
 * Extracted from db.ts.
 */

import { Database } from "bun:sqlite";
import { parseNode, parseEdge, stemWord } from "./db-core";
import { getNode } from "./db-crud";
import type { MemoryNode, Edge } from "./types";

export function getRelationships(
  db: Database,
  nodeId: string
): Array<{ edge: Edge; target: MemoryNode }> {
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

  const mapRow = (row: Record<string, unknown>) => ({
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

  for (const row of outgoing) results.push(mapRow(row));
  for (const row of incoming) results.push(mapRow(row));

  return results;
}

export function getFactsByEntity(db: Database, entityId: string): MemoryNode[] {
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

export function getRecentEventIds(db: Database, days: number): string[] {
  const rows = db.prepare(
    `SELECT id FROM nodes
     WHERE node_type = 'event' AND superseded_by IS NULL
       AND created_at >= datetime('now', ?)
     ORDER BY created_at DESC`
  ).all(`-${days} days`) as { id: string }[];
  return rows.map(r => r.id);
}

export function getEventsByEntity(
  db: Database,
  entityId: string,
  days?: number
): MemoryNode[] {
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

export function getInstructions(db: Database, topic?: string): MemoryNode[] {
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

  const words = topic.trim().split(/\s+/).filter(w => w.length > 2);
  if (words.length === 0) {
    return [];
  }

  const conditions = words.map(() => `(content LIKE ?)`);
  const matchScore = words.map(() => `(CASE WHEN content LIKE ? THEN 1 ELSE 0 END)`).join(" + ");
  const params: unknown[] = [];
  for (const word of words) {
    params.push(`%${stemWord(word)}%`);
  }
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

export function getGlobalInstructions(db: Database): MemoryNode[] {
  const rows = db
    .prepare(
      `SELECT * FROM nodes
       WHERE node_type = 'instruction'
         AND scope >= 0.8
         AND superseded_by IS NULL`
    )
    .all() as Record<string, unknown>[];
  return rows.map(parseNode);
}

export function getInstructionsByEntity(db: Database, entityId: string): MemoryNode[] {
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
