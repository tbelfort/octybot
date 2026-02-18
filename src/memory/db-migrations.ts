/**
 * Schema migration system for the memory database.
 * Tracks applied migrations in a `schema_migrations` table and runs
 * any unapplied ones in version order.
 */

import { Database } from "bun:sqlite";

interface Migration {
  version: number;
  description: string;
  up: (db: Database) => void;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: "Baseline — marks existing schema as tracked",
    up: (_db) => {
      // no-op: the CREATE TABLE statements in initSchema already cover the
      // original schema. This entry just anchors the version history.
    },
  },
  {
    version: 2,
    description: "Add can_summarize column to nodes",
    up: (db) => {
      // try/catch because the column may already exist from the old bare-alter approach
      try {
        db.exec("ALTER TABLE nodes ADD COLUMN can_summarize INTEGER DEFAULT 1");
      } catch {}
    },
  },
  {
    version: 3,
    description: "Add scope column to nodes for instruction retrieval",
    up: (db) => {
      // try/catch because the column may already exist from the old bare-alter approach
      try {
        db.exec("ALTER TABLE nodes ADD COLUMN scope REAL DEFAULT NULL");
      } catch {}
    },
  },
];

/**
 * Run all pending migrations against `db`.
 * Safe to call on every startup — already-applied versions are skipped.
 */
export function runMigrations(db: Database): void {
  // Ensure the tracking table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      description TEXT,
      applied_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Determine which versions have already been applied
  const rows = db.query("SELECT version FROM schema_migrations").all() as {
    version: number;
  }[];
  const applied = new Set(rows.map((r) => r.version));

  // Run unapplied migrations in order
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;

    migration.up(db);

    db.query(
      "INSERT INTO schema_migrations (version, description) VALUES (?, ?)"
    ).run(migration.version, migration.description);
  }
}
