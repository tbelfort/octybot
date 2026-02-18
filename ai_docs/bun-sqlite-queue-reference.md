# bun:sqlite Reference for Message Queue Implementation

## Core API

### Database Creation

```typescript
import { Database } from "bun:sqlite";

// File-based database
const db = new Database("mydb.sqlite");

// In-memory database
const db = new Database(":memory:");

// Read-only mode
const db = new Database("mydb.sqlite", { readonly: true });

// Create if missing
const db = new Database("mydb.sqlite", { create: true });

// ES Module import (alternative)
import db from "./mydb.sqlite" with { type: "sqlite" };
```

### Resource Management

```typescript
// Automatic cleanup with `using`
{
  using db = new Database("mydb.sqlite");
  using query = db.query("SELECT ...");
  // database automatically closes when block exits
}
```

### WAL Mode (Critical for Multi-Agent)

```typescript
db.run("PRAGMA journal_mode = WAL;");
// WAL mode: multiple concurrent readers + single writer
// Writes go to a separate WAL file, readers see consistent snapshots
// Perfect for polling-based message queues
```

### Busy Timeout (Critical for Concurrent Access)

```typescript
db.run("PRAGMA busy_timeout = 5000;");
// Wait up to 5 seconds if database is locked by another writer
// Without this, concurrent writes immediately throw SQLITE_BUSY
```

---

## Query Methods

### Prepared Statements (Cached)

```typescript
// db.query() caches the prepared statement by SQL string
const stmt = db.query("SELECT * FROM messages WHERE to_agent = $agent AND status = $status");
const rows = stmt.all({ $agent: "agent-alpha", $status: "pending" });
```

### Prepared Statements (Uncached)

```typescript
// db.prepare() creates a fresh instance each time
const stmt = db.prepare("INSERT INTO messages (from_agent, to_agent, payload) VALUES (?, ?, ?)");
stmt.run("alpha", "beta", JSON.stringify({ hello: "world" }));
```

### Execution Methods

```typescript
// .all() — returns all rows as objects
const rows = stmt.all({ $param: "value" });
// Returns: [{ id: 1, col: "val" }, { id: 2, col: "val2" }]

// .get() — returns first row or undefined
const row = stmt.get({ $param: "value" });
// Returns: { id: 1, col: "val" } or undefined

// .run() — executes without materializing results
const info = stmt.run();
// Returns: { lastInsertRowid: number, changes: number }

// .values() — returns rows as arrays
const arrays = stmt.values();
// Returns: [["val1", 1], ["val2", 2]]

// .iterate() — streaming iterator for large result sets
for (const row of stmt.iterate()) {
  console.log(row);
}
```

### Parameter Binding

```typescript
// Named parameters
db.query("SELECT $message").all({ $message: "Hello" });
db.query("SELECT :message").all({ ":message": "Hello" });
db.query("SELECT @message").all({ "@message": "Hello" });

// Positional parameters
db.query("SELECT ?1, ?2").all("Hello", "World");
```

---

## Transactions (Critical for Atomic Queue Operations)

```typescript
const insertMsg = db.prepare(
  "INSERT INTO messages (from_agent, to_agent, payload) VALUES ($from, $to, $payload)"
);

const claimMsg = db.prepare(
  "UPDATE messages SET status = 'claimed', claimed_at = unixepoch() WHERE id = $id"
);

// Atomic claim: select + update in one transaction
const claimNext = db.transaction((agentId: string) => {
  const msg = db.query(
    `SELECT * FROM messages WHERE to_agent = ? AND status = 'pending' ORDER BY id LIMIT 1`
  ).get(agentId);
  if (msg) {
    claimMsg.run({ $id: msg.id });
  }
  return msg;
});

// Usage
const message = claimNext("agent-beta");
```

### Transaction Variants

```typescript
// Default — uses BEGIN DEFERRED
claimNext("agent-beta");

// Immediate — acquires write lock immediately (good for queues)
claimNext.immediate("agent-beta");

// Exclusive — full exclusive lock
claimNext.exclusive("agent-beta");
```

### Nested Transactions (Savepoints)

```typescript
const outer = db.transaction(() => {
  db.run("INSERT INTO ...");
  const inner = db.transaction(() => {
    db.run("INSERT INTO ...");
    // If inner throws, only inner rolls back
  });
  inner();
});
outer();
```

---

## Data Types

| JavaScript | SQLite |
|------------|--------|
| `string` | `TEXT` |
| `number` | `INTEGER` or `DECIMAL` |
| `boolean` | `INTEGER` (1 or 0) |
| `Uint8Array` / `Buffer` | `BLOB` |
| `bigint` | `INTEGER` |
| `null` | `NULL` |

---

## Multi-Query Execution

```typescript
// Execute multiple statements in one call
db.run(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_agent TEXT NOT NULL,
    to_agent TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_to_status ON messages(to_agent, status);
`);
```

---

## Statement Utilities

```typescript
const stmt = db.query("SELECT * FROM messages WHERE id = ?1");

stmt.columnNames;    // ["id", "from_agent", "to_agent", "payload", "status", "created_at"]
stmt.paramsCount;    // 1
stmt.toString();     // Expanded SQL with bound values
stmt.finalize();     // Free resources
```

---

## Performance Notes

- bun:sqlite is 3-6x faster than better-sqlite3
- bun:sqlite is 8-9x faster than deno.land/x/sqlite
- WAL mode improves concurrent read performance significantly
- Prepared statements are cached by SQL string via `db.query()`
- Use `.immediate()` transactions for queue operations to avoid deadlocks

---

## SQLite as Message Queue: Concurrency Details

### WAL Mode Behavior
- **Multiple concurrent readers**: Yes, unlimited
- **Multiple concurrent writers**: No, serialized (one at a time)
- **Reader blocks writer**: No (readers use snapshots)
- **Writer blocks reader**: No (WAL isolates them)
- **Write contention**: Use `PRAGMA busy_timeout` to wait instead of error

### Best Practices for Queue Pattern
1. Always use WAL mode (`PRAGMA journal_mode = WAL`)
2. Set busy timeout (`PRAGMA busy_timeout = 5000`)
3. Use `.immediate()` transactions for claim operations
4. Keep transactions short (claim one message at a time)
5. Use `CREATE INDEX` on `(to_agent, status)` for fast polling
6. Poll at 100-500ms intervals (balance latency vs overhead)
7. Prune old messages periodically (`DELETE WHERE status = 'done' AND done_at < ?`)

---

## Complete Queue Implementation Template

```typescript
import { Database } from "bun:sqlite";
import { join } from "path";
import { homedir } from "os";

interface QueueMessage {
  id: number;
  from_agent: string;
  to_agent: string;
  type: string;
  correlation_id: string | null;
  payload: string;
  status: string;
  created_at: number;
  claimed_at: number | null;
  done_at: number | null;
}

export class AgentQueue {
  private db: Database;

  constructor(dbPath?: string) {
    this.db = new Database(dbPath ?? join(homedir(), ".octybot", "messages.db"));
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA busy_timeout = 5000");
    this.init();
  }

  private init() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_agent TEXT NOT NULL,
        to_agent TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'request',
        correlation_id TEXT,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        claimed_at INTEGER,
        done_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_to_status ON messages(to_agent, status);
      CREATE INDEX IF NOT EXISTS idx_correlation ON messages(correlation_id);
    `);
  }

  send(from: string, to: string, payload: object, opts?: { correlationId?: string; type?: string }) {
    this.db.run(
      `INSERT INTO messages (from_agent, to_agent, type, correlation_id, payload) VALUES (?, ?, ?, ?, ?)`,
      [from, to, opts?.type ?? "request", opts?.correlationId ?? null, JSON.stringify(payload)]
    );
  }

  receive = this.db.transaction((agentId: string): QueueMessage | null => {
    const msg = this.db.query<QueueMessage, [string]>(
      `SELECT * FROM messages WHERE to_agent = ? AND status = 'pending' ORDER BY id LIMIT 1`
    ).get(agentId);
    if (msg) {
      this.db.run(`UPDATE messages SET status = 'claimed', claimed_at = unixepoch() WHERE id = ?`, [msg.id]);
    }
    return msg ?? null;
  });

  done(messageId: number) {
    this.db.run(`UPDATE messages SET status = 'done', done_at = unixepoch() WHERE id = ?`, [messageId]);
  }

  async waitForResponse(correlationId: string, timeoutMs = 30_000): Promise<QueueMessage> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const msg = this.db.transaction(() => {
        const m = this.db.query<QueueMessage, [string]>(
          `SELECT * FROM messages WHERE correlation_id = ? AND type = 'response' AND status = 'pending' LIMIT 1`
        ).get(correlationId);
        if (m) {
          this.db.run(`UPDATE messages SET status = 'claimed', claimed_at = unixepoch() WHERE id = ?`, [m.id]);
        }
        return m;
      })();
      if (msg) return msg;
      await Bun.sleep(100);
    }
    throw new Error(`Timeout waiting for response to ${correlationId}`);
  }

  prune(olderThanSeconds = 3600) {
    this.db.run(`DELETE FROM messages WHERE status = 'done' AND done_at < unixepoch() - ?`, [olderThanSeconds]);
  }

  pendingCount(agentId: string): number {
    const row = this.db.query<{ count: number }, [string]>(
      `SELECT COUNT(*) as count FROM messages WHERE to_agent = ? AND status = 'pending'`
    ).get(agentId);
    return row?.count ?? 0;
  }

  close() {
    this.db.close();
  }
}
```

---

## Sources

- [bun:sqlite Documentation](https://bun.com/docs/runtime/sqlite)
- [bun:sqlite API Reference](https://bun.com/reference/bun/sqlite)
- [SQLite WAL Mode](https://sqlite.org/wal.html)
- [SQLite Isolation](https://sqlite.org/isolation.html)
- [SQLite Concurrent Writes](https://tenthousandmeters.com/blog/sqlite-concurrent-writes-and-database-is-locked-errors/)
- [LiteQueue (Python SQLite Queue)](https://github.com/litements/litequeue)
