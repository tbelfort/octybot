import { getDb } from "./db";

export function storeEmbedding(
  nodeId: string,
  nodeType: string,
  vector: number[]
): void {
  const db = getDb();
  const blob = new Float32Array(vector).buffer;
  db.prepare(
    `INSERT OR REPLACE INTO embeddings (node_id, node_type, vector)
     VALUES (?, ?, ?)`
  ).run(nodeId, nodeType, Buffer.from(blob));
}

export function searchSimilar(
  query: number[],
  topK: number,
  filter?: { nodeType?: string; nodeIds?: string[] }
): Array<{ nodeId: string; score: number }> {
  const db = getDb();

  let sql = `SELECT e.node_id, e.node_type, e.vector, COALESCE(n.salience, 1.0) as salience
             FROM embeddings e LEFT JOIN nodes n ON e.node_id = n.id`;
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filter?.nodeType) {
    conditions.push(`e.node_type = ?`);
    params.push(filter.nodeType);
  }

  if (filter?.nodeIds?.length) {
    conditions.push(
      `e.node_id IN (${filter.nodeIds.map(() => "?").join(",")})`
    );
    params.push(...filter.nodeIds);
  }

  // Exclude superseded nodes
  conditions.push(
    `e.node_id NOT IN (SELECT id FROM nodes WHERE superseded_by IS NOT NULL)`
  );

  if (conditions.length > 0) {
    sql += ` WHERE ${conditions.join(" AND ")}`;
  }

  const rows = db.prepare(sql).all(...params) as Array<{
    node_id: string;
    node_type: string;
    vector: Buffer;
    salience: number;
  }>;

  const results: Array<{ nodeId: string; score: number }> = [];

  for (const row of rows) {
    const stored = new Float32Array(
      row.vector.buffer,
      row.vector.byteOffset,
      row.vector.byteLength / 4
    );
    const cosineScore = cosineSimilarity(query, stored);
    const finalScore = cosineScore * row.salience;
    results.push({ nodeId: row.node_id, score: finalScore });
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, topK);
}

function cosineSimilarity(
  a: number[] | Float32Array,
  b: number[] | Float32Array
): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
