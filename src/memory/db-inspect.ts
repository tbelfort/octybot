/**
 * Inspection & mutation commands for the DB manager.
 * Search, show, delete, delete-entity, update.
 * Extracted from db-manager.ts.
 */

import { existsSync } from "fs";
import { Database } from "bun:sqlite";
import { ACTIVE_DB_PATH } from "./db-profile";

// ── Commands ──

export function cmdSearch(queryParts: string[]) {
  const query = queryParts.join(" ").trim();
  if (!query) throw new Error("Usage: search <query text>");
  if (!existsSync(ACTIVE_DB_PATH)) throw new Error(`No active DB at ${ACTIVE_DB_PATH}`);

  const db = new Database(ACTIVE_DB_PATH);
  db.exec("PRAGMA busy_timeout = 3000");

  // Search by content using LIKE with each word
  const words = query.split(/\s+/).filter(w => w.length > 1);
  const conditions = words.map(() => "LOWER(n.content) LIKE ?");
  const params = words.map(w => `%${w.toLowerCase()}%`);

  const sql = `SELECT n.id, n.node_type, n.subtype, n.content, n.created_at
    FROM nodes n
    WHERE ${conditions.join(" AND ")}
      AND n.superseded_by IS NULL
    ORDER BY n.created_at DESC
    LIMIT 20`;

  const rows = db.prepare(sql).all(...params) as Array<{
    id: string; node_type: string; subtype: string | null; content: string; created_at: string;
  }>;
  db.close();

  if (rows.length === 0) {
    console.log(`No nodes found matching: "${query}"`);
    return;
  }

  console.log(`Found ${rows.length} node(s) matching "${query}":\n`);
  for (const row of rows) {
    const type = row.subtype ? `${row.node_type}/${row.subtype}` : row.node_type;
    console.log(`  [${type}] ${row.content}`);
    console.log(`    id: ${row.id} | created: ${row.created_at}`);
    console.log();
  }
}

export function cmdShow(nameParts: string[]) {
  const name = nameParts.join(" ").trim();
  if (!name) throw new Error("Usage: show <entity-name>");
  if (!existsSync(ACTIVE_DB_PATH)) throw new Error(`No active DB at ${ACTIVE_DB_PATH}`);

  const db = new Database(ACTIVE_DB_PATH);
  db.exec("PRAGMA busy_timeout = 3000");

  // Find entity by name (case-insensitive)
  const entities = db.prepare(
    `SELECT id, node_type, subtype, content, created_at FROM nodes
     WHERE node_type = 'entity' AND superseded_by IS NULL AND LOWER(content) LIKE ?
     ORDER BY created_at DESC`
  ).all(`%${name.toLowerCase()}%`) as Array<{
    id: string; node_type: string; subtype: string | null; content: string; created_at: string;
  }>;

  if (entities.length === 0) {
    console.log(`No entity found matching: "${name}"`);
    db.close();
    return;
  }

  if (entities.length > 1) {
    console.log(`Multiple entities match "${name}" — pick one:\n`);
    for (const e of entities) {
      const type = e.subtype ? `${e.node_type}/${e.subtype}` : e.node_type;
      console.log(`  [${type}] ${e.content}`);
      console.log(`    id: ${e.id}`);
    }
    db.close();
    return;
  }

  const entity = entities[0];
  console.log(`Entity: ${entity.content}`);
  console.log(`  id: ${entity.id} | created: ${entity.created_at}\n`);

  // Find all connected nodes via edges
  const connected = db.prepare(
    `SELECT DISTINCT n.id, n.node_type, n.subtype, n.content, n.created_at, n.scope
     FROM nodes n
     JOIN edges e ON (e.target_id = n.id OR e.source_id = n.id)
     WHERE (e.source_id = ? OR e.target_id = ?)
       AND n.id != ?
       AND n.superseded_by IS NULL
     ORDER BY n.node_type, n.created_at DESC`
  ).all(entity.id, entity.id, entity.id) as Array<{
    id: string; node_type: string; subtype: string | null; content: string; created_at: string; scope: number | null;
  }>;

  if (connected.length === 0) {
    console.log("  (no connected nodes)");
    db.close();
    return;
  }

  // Group by type
  const groups: Record<string, typeof connected> = {};
  for (const node of connected) {
    const key = node.node_type;
    if (!groups[key]) groups[key] = [];
    groups[key].push(node);
  }

  for (const [type, nodes] of Object.entries(groups)) {
    console.log(`${type} (${nodes.length}):`);
    for (const n of nodes) {
      const label = n.subtype ? `${type}/${n.subtype}` : type;
      const scopeTag = n.scope != null ? ` scope=${n.scope}` : "";
      console.log(`  [${label}] ${n.content}`);
      console.log(`    id: ${n.id}${scopeTag}`);
    }
    console.log();
  }

  console.log(`Total: ${connected.length} connected node(s)`);
  db.close();
}

export function cmdDelete(nodeIds: string[]) {
  if (nodeIds.length === 0) throw new Error("Usage: delete <node-id> [node-id ...]");
  if (!existsSync(ACTIVE_DB_PATH)) throw new Error(`No active DB at ${ACTIVE_DB_PATH}`);

  const db = new Database(ACTIVE_DB_PATH);
  db.exec("PRAGMA busy_timeout = 3000");

  let deleted = 0;
  for (const id of nodeIds) {
    const node = db.query("SELECT id, node_type, substr(content, 1, 80) as content FROM nodes WHERE id = ?").get(id) as { id: string; node_type: string; content: string } | null;
    if (!node) {
      console.log(`  skip: ${id} (not found)`);
      continue;
    }
    db.run("DELETE FROM edges WHERE source_id = ? OR target_id = ?", id, id);
    db.run("DELETE FROM embeddings WHERE node_id = ?", id);
    db.run("DELETE FROM nodes WHERE id = ?", id);
    console.log(`  deleted: [${node.node_type}] ${node.content}`);
    deleted++;
  }
  db.close();
  console.log(`\nDeleted ${deleted}/${nodeIds.length} node(s).`);
}

export function cmdDeleteEntity(nameParts: string[]) {
  const name = nameParts.join(" ").trim();
  if (!name) throw new Error("Usage: delete-entity <entity-name>");
  if (!existsSync(ACTIVE_DB_PATH)) throw new Error(`No active DB at ${ACTIVE_DB_PATH}`);

  const db = new Database(ACTIVE_DB_PATH);
  db.exec("PRAGMA busy_timeout = 3000");

  // Find entity by name (case-insensitive)
  const entities = db.prepare(
    `SELECT id, content FROM nodes
     WHERE node_type = 'entity' AND superseded_by IS NULL AND LOWER(content) LIKE ?
     ORDER BY created_at DESC`
  ).all(`%${name.toLowerCase()}%`) as Array<{ id: string; content: string }>;

  if (entities.length === 0) {
    console.log(`No entity found matching: "${name}"`);
    db.close();
    return;
  }

  if (entities.length > 1) {
    console.log(`Multiple entities match "${name}" — be more specific:\n`);
    for (const e of entities) {
      console.log(`  ${e.content} (id: ${e.id})`);
    }
    db.close();
    return;
  }

  const entity = entities[0];
  console.log(`Deleting entity: ${entity.content} (${entity.id})\n`);

  // Find all connected node IDs via edges
  const connectedNodes = db.prepare(
    `SELECT DISTINCT n.id, n.node_type, n.content FROM nodes n
     JOIN edges e ON (e.target_id = n.id OR e.source_id = n.id)
     WHERE (e.source_id = ? OR e.target_id = ?)
       AND n.id != ?
       AND n.superseded_by IS NULL`
  ).all(entity.id, entity.id, entity.id) as Array<{
    id: string; node_type: string; content: string;
  }>;

  let deletedNodes = 0;
  let unlinkedNodes = 0;

  for (const node of connectedNodes) {
    // Check if this node has edges to OTHER entities (not the one being deleted)
    const otherEntityEdges = db.prepare(
      `SELECT 1 FROM edges e
       JOIN nodes n ON (
         (e.source_id = n.id AND e.target_id = ?) OR
         (e.target_id = n.id AND e.source_id = ?)
       )
       WHERE n.node_type = 'entity' AND n.id != ?
       LIMIT 1`
    ).get(node.id, node.id, entity.id);

    if (otherEntityEdges) {
      // Connected to other entities — just remove edges to this entity
      db.run(
        `DELETE FROM edges WHERE
         (source_id = ? AND target_id = ?) OR (source_id = ? AND target_id = ?)`,
        entity.id, node.id, node.id, entity.id
      );
      console.log(`  unlinked: [${node.node_type}] ${node.content.slice(0, 80)}`);
      unlinkedNodes++;
    } else {
      // Only connected to this entity — delete entirely
      db.run("DELETE FROM edges WHERE source_id = ? OR target_id = ?", node.id, node.id);
      db.run("DELETE FROM embeddings WHERE node_id = ?", node.id);
      db.run("DELETE FROM nodes WHERE id = ?", node.id);
      console.log(`  deleted: [${node.node_type}] ${node.content.slice(0, 80)}`);
      deletedNodes++;
    }
  }

  // Delete the entity itself
  db.run("DELETE FROM edges WHERE source_id = ? OR target_id = ?", entity.id, entity.id);
  db.run("DELETE FROM embeddings WHERE node_id = ?", entity.id);
  db.run("DELETE FROM nodes WHERE id = ?", entity.id);
  db.close();

  console.log(`\nDone: deleted entity + ${deletedNodes} exclusive node(s), unlinked ${unlinkedNodes} shared node(s).`);
}

export async function cmdUpdate(nodeId: string, contentParts: string[]) {
  const newContent = contentParts.join(" ").trim();
  if (!nodeId || !newContent) throw new Error("Usage: update <node-id> <new content>");
  if (!existsSync(ACTIVE_DB_PATH)) throw new Error(`No active DB at ${ACTIVE_DB_PATH}`);

  const { getDb, closeDb } = await import("./db-core");
  const { supersedeNode, getNode } = await import("./db-crud");
  const { embed } = await import("./voyage");
  const { storeEmbedding } = await import("./vectors");

  const db = getDb();
  const oldNode = getNode(db, nodeId);
  if (!oldNode) throw new Error(`Node not found: ${nodeId}`);

  const oldContent = oldNode.content;
  const newId = supersedeNode(db, nodeId, newContent);

  // Re-embed the new node
  const [vector] = await embed([newContent], "document");
  storeEmbedding(db, newId, oldNode.node_type, vector);

  closeDb();

  console.log(`Updated [${oldNode.node_type}]:`);
  console.log(`  old: ${oldContent}`);
  console.log(`  new: ${newContent}`);
  console.log(`  old_id: ${nodeId} → new_id: ${newId}`);
}
