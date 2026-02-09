/**
 * Pure embedding store — flat vector DB with no graph concepts.
 * Just content + vector. Cosine similarity search.
 */
import { Database } from "bun:sqlite";

let db: Database | null = null;
let dbPath: string = "";

export function initStore(path: string) {
  dbPath = path;
  db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL, vector BLOB NOT NULL, created_at TEXT DEFAULT (datetime('now')))");
  // Verify table exists
  const check = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='items'").get();
  if (!check) throw new Error("Failed to create items table");
}

export function storeItem(content: string, vector: number[]): number {
  if (!db) throw new Error("Store not initialized");
  const blob = Buffer.from(new Float32Array(vector).buffer);
  const result = db.prepare("INSERT INTO items (content, vector) VALUES (?, ?)").run(content, blob);
  return Number(result.lastInsertRowid);
}

export function searchItems(queryVector: number[], topK: number): Array<{ id: number; content: string; score: number }> {
  if (!db) throw new Error("Store not initialized");

  const rows = db.prepare("SELECT id, content, vector FROM items").all() as Array<{
    id: number;
    content: string;
    vector: Buffer;
  }>;

  const scored = rows.map((row) => {
    const stored = new Float32Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength / 4);
    const score = cosineSimilarity(queryVector, stored);
    return { id: row.id, content: row.content, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

export function closeStore() {
  if (db) { db.close(); db = null; }
}

export function resetStore() {
  closeStore();
  try { require("fs").rmSync(dbPath); } catch {}
}

function cosineSimilarity(a: number[], b: Float32Array): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
