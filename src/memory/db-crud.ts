/**
 * CRUD operations on nodes and edges.
 * Extracted from db.ts.
 */

import type { Database } from "bun:sqlite";
import { uuid, parseNode, parseEdge } from "./db-core";
import type { MemoryNode, Edge } from "./types";

export function createNode(
  db: Database,
  node: Omit<MemoryNode, "id" | "created_at">
): string {
  const id = uuid();
  const canSummarize = node.node_type === "instruction"
    ? 0
    : (node.can_summarize ?? 1);
  const scope = node.node_type === "instruction"
    ? (node.scope ?? 0.5)
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
  db: Database,
  edge: Omit<Edge, "id" | "created_at">
): string {
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

export function getNode(db: Database, id: string): MemoryNode | null {
  const row = db
    .prepare("SELECT * FROM nodes WHERE id = ?")
    .get(id) as Record<string, unknown> | null;
  return row ? parseNode(row) : null;
}

export function deleteNode(db: Database, id: string): boolean {
  const node = getNode(db, id);
  if (!node) return false;

  db.prepare("DELETE FROM edges WHERE source_id = ? OR target_id = ?").run(id, id);
  db.prepare("DELETE FROM embeddings WHERE node_id = ?").run(id);
  db.prepare("DELETE FROM nodes WHERE id = ?").run(id);
  return true;
}

export function supersedeNode(db: Database, oldId: string, newContent: string): string {
  const oldNode = getNode(db, oldId);
  if (!oldNode) throw new Error(`Node ${oldId} not found`);

  const newId = createNode(db, {
    node_type: oldNode.node_type,
    subtype: oldNode.subtype,
    content: newContent,
    salience: oldNode.salience,
    confidence: oldNode.confidence,
    source: oldNode.source,
    attributes: oldNode.attributes,
    scope: oldNode.scope,
  });

  db.prepare("UPDATE nodes SET superseded_by = ? WHERE id = ?").run(
    newId,
    oldId
  );

  const outEdges = db
    .prepare("SELECT * FROM edges WHERE source_id = ?")
    .all(oldId) as Record<string, unknown>[];
  const inEdges = db
    .prepare("SELECT * FROM edges WHERE target_id = ?")
    .all(oldId) as Record<string, unknown>[];

  const seenEdgeIds = new Set<string>();

  for (const edge of outEdges) {
    const eid = edge.id as string;
    if (seenEdgeIds.has(eid)) continue;
    seenEdgeIds.add(eid);
    createEdge(db, {
      source_id: newId,
      target_id: edge.target_id as string,
      edge_type: edge.edge_type as string,
      attributes: JSON.parse((edge.attributes as string) || "{}"),
    });
  }

  for (const edge of inEdges) {
    const eid = edge.id as string;
    if (seenEdgeIds.has(eid)) continue;
    seenEdgeIds.add(eid);
    createEdge(db, {
      source_id: edge.source_id as string,
      target_id: newId,
      edge_type: edge.edge_type as string,
      attributes: JSON.parse((edge.attributes as string) || "{}"),
    });
  }

  return newId;
}

export function promotePlanToEvent(db: Database, id: string): MemoryNode | null {
  const node = getNode(db, id);
  if (!node || node.node_type !== "plan") return null;

  db.prepare(
    "UPDATE nodes SET node_type = 'event', subtype = 'completed_plan' WHERE id = ?"
  ).run(id);
  db.prepare(
    "UPDATE embeddings SET node_type = 'event' WHERE node_id = ?"
  ).run(id);

  return getNode(db, id);
}
