/**
 * SQLite database for storing benchmark results history.
 * Stores at pa-test-1/results.db
 */
import { Database } from "bun:sqlite";
import { join } from "path";

const RESULTS_DB_PATH = join(import.meta.dir, "..", "results.db");

let db: Database | null = null;

function getResultsDb(): Database {
  if (db) return db;
  db = new Database(RESULTS_DB_PATH, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      l1_model TEXT NOT NULL,
      l2_model TEXT NOT NULL,
      embedding_model TEXT NOT NULL,
      test_suite TEXT NOT NULL DEFAULT 'v2',
      total_queries INTEGER,
      retrieval_queries INTEGER,
      store_queries INTEGER,
      retrieval_hit_rate REAL,
      store_hit_rate REAL,
      overall_hit_rate REAL,
      retrieval_full_pass INTEGER,
      retrieval_full_pass_total INTEGER,
      store_full_pass INTEGER,
      store_full_pass_total INTEGER,
      done_tool_rate REAL,
      avg_tool_calls REAL,
      avg_duration_ms REAL,
      total_duration_ms INTEGER,
      l1_input_tokens INTEGER DEFAULT 0,
      l1_output_tokens INTEGER DEFAULT 0,
      l2_input_tokens INTEGER DEFAULT 0,
      l2_output_tokens INTEGER DEFAULT 0,
      embedding_tokens INTEGER DEFAULT 0,
      l1_cost_usd REAL DEFAULT 0,
      l2_cost_usd REAL DEFAULT 0,
      embedding_cost_usd REAL DEFAULT 0,
      total_cost_usd REAL DEFAULT 0,
      errors INTEGER DEFAULT 0,
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS query_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL REFERENCES runs(id),
      query_id TEXT NOT NULL,
      phase TEXT NOT NULL,
      prompt TEXT NOT NULL,
      expected_count INTEGER,
      hit_count INTEGER,
      misses TEXT,
      tool_calls INTEGER,
      terminated_by TEXT,
      duration_ms INTEGER,
      context_preview TEXT
    );
  `);
  return db;
}

export interface RunRecord {
  timestamp: string;
  l1_model: string;
  l2_model: string;
  embedding_model: string;
  test_suite: string;
  total_queries: number;
  retrieval_queries: number;
  store_queries: number;
  retrieval_hit_rate: number;
  store_hit_rate: number;
  overall_hit_rate: number;
  retrieval_full_pass: number;
  retrieval_full_pass_total: number;
  store_full_pass: number;
  store_full_pass_total: number;
  done_tool_rate: number;
  avg_tool_calls: number;
  avg_duration_ms: number;
  total_duration_ms: number;
  l1_input_tokens: number;
  l1_output_tokens: number;
  l2_input_tokens: number;
  l2_output_tokens: number;
  embedding_tokens: number;
  l1_cost_usd: number;
  l2_cost_usd: number;
  embedding_cost_usd: number;
  total_cost_usd: number;
  errors: number;
  notes?: string;
}

export interface QueryRecord {
  query_id: string;
  phase: string;
  prompt: string;
  expected_count: number;
  hit_count: number;
  misses: string[];
  tool_calls: number;
  terminated_by: string;
  duration_ms: number;
  context_preview: string;
}

export function saveRun(run: RunRecord, queries: QueryRecord[]): number {
  const db = getResultsDb();

  const stmt = db.prepare(`
    INSERT INTO runs (
      timestamp, l1_model, l2_model, embedding_model, test_suite,
      total_queries, retrieval_queries, store_queries,
      retrieval_hit_rate, store_hit_rate, overall_hit_rate,
      retrieval_full_pass, retrieval_full_pass_total,
      store_full_pass, store_full_pass_total,
      done_tool_rate, avg_tool_calls, avg_duration_ms, total_duration_ms,
      l1_input_tokens, l1_output_tokens, l2_input_tokens, l2_output_tokens,
      embedding_tokens, l1_cost_usd, l2_cost_usd, embedding_cost_usd, total_cost_usd,
      errors, notes
    ) VALUES (
      ?, ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?,
      ?, ?,
      ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?
    )
  `);

  const result = stmt.run(
    run.timestamp, run.l1_model, run.l2_model, run.embedding_model, run.test_suite,
    run.total_queries, run.retrieval_queries, run.store_queries,
    run.retrieval_hit_rate, run.store_hit_rate, run.overall_hit_rate,
    run.retrieval_full_pass, run.retrieval_full_pass_total,
    run.store_full_pass, run.store_full_pass_total,
    run.done_tool_rate, run.avg_tool_calls, run.avg_duration_ms, run.total_duration_ms,
    run.l1_input_tokens, run.l1_output_tokens, run.l2_input_tokens, run.l2_output_tokens,
    run.embedding_tokens, run.l1_cost_usd, run.l2_cost_usd, run.embedding_cost_usd, run.total_cost_usd,
    run.errors, run.notes || null
  );

  const runId = Number(result.lastInsertRowid);

  const qStmt = db.prepare(`
    INSERT INTO query_results (
      run_id, query_id, phase, prompt, expected_count, hit_count,
      misses, tool_calls, terminated_by, duration_ms, context_preview
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const q of queries) {
    qStmt.run(
      runId, q.query_id, q.phase, q.prompt, q.expected_count, q.hit_count,
      JSON.stringify(q.misses), q.tool_calls, q.terminated_by, q.duration_ms,
      q.context_preview.slice(0, 500)
    );
  }

  return runId;
}

export function listRuns(): Array<RunRecord & { id: number }> {
  const db = getResultsDb();
  return db.prepare("SELECT * FROM runs ORDER BY id DESC").all() as Array<RunRecord & { id: number }>;
}

export function closeResultsDb() {
  if (db) { db.close(); db = null; }
}
