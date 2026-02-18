/**
 * SQLite-based message bus for inter-agent communication.
 *
 * Messages flow: send() → claim() → respond() → waitForResponse()
 * Uses SQLite transactions for atomic claim (no double-processing).
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { randomUUID } from "crypto";

export type MessageStatus = "pending" | "claimed" | "responded" | "expired";

export interface Message {
  id: string;
  from_agent: string;
  to_agent: string;
  content: string;
  status: MessageStatus;
  response?: string;
  claimed_at?: string;
  responded_at?: string;
  created_at: string;
  expires_at?: string;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    from_agent TEXT NOT NULL,
    to_agent TEXT NOT NULL,
    content TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    response TEXT,
    claimed_at TEXT,
    responded_at TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_messages_to_status ON messages(to_agent, status);
  CREATE INDEX IF NOT EXISTS idx_messages_from_status ON messages(from_agent, status);
`;

export class MessageBus {
  private db: Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  /**
   * Send a message from one agent to another.
   * Returns the message ID for tracking.
   */
  send(fromAgent: string, toAgent: string, content: string, ttlMs?: number): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    const expiresAt = ttlMs
      ? new Date(Date.now() + ttlMs).toISOString()
      : null;

    this.db.run(
      `INSERT INTO messages (id, from_agent, to_agent, content, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [id, fromAgent, toAgent, content, now, expiresAt]
    );

    return id;
  }

  /**
   * Atomically claim the next pending message for an agent.
   * Returns null if no messages are available.
   */
  claim(agentName: string): Message | null {
    const now = new Date().toISOString();

    // Transaction ensures atomic claim
    const result = this.db.transaction(() => {
      // Expire old messages first
      this.db.run(
        `UPDATE messages SET status = 'expired' WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at < ?`,
        [now]
      );

      const row = this.db.query(
        `SELECT * FROM messages WHERE to_agent = ? AND status = 'pending' ORDER BY created_at ASC LIMIT 1`
      ).get(agentName) as Message | null;

      if (!row) return null;

      this.db.run(
        `UPDATE messages SET status = 'claimed', claimed_at = ? WHERE id = ?`,
        [now, row.id]
      );

      return { ...row, status: "claimed" as MessageStatus, claimed_at: now };
    })();

    return result;
  }

  /**
   * Atomically claim a specific message by ID.
   * Returns null if message doesn't exist, isn't pending, or is expired.
   */
  claimById(messageId: string): Message | null {
    const now = new Date().toISOString();

    const result = this.db.transaction(() => {
      const row = this.db.query(
        `SELECT * FROM messages WHERE id = ? AND status = 'pending'`
      ).get(messageId) as Message | null;

      if (!row) return null;

      // Check expiry
      if (row.expires_at && row.expires_at < now) {
        this.db.run(
          `UPDATE messages SET status = 'expired' WHERE id = ?`,
          [messageId]
        );
        return null;
      }

      this.db.run(
        `UPDATE messages SET status = 'claimed', claimed_at = ? WHERE id = ?`,
        [now, messageId]
      );

      return { ...row, status: "claimed" as MessageStatus, claimed_at: now };
    })();

    return result;
  }

  /**
   * Write a response to a claimed message.
   */
  respond(messageId: string, response: string): void {
    const now = new Date().toISOString();
    const result = this.db.run(
      `UPDATE messages SET status = 'responded', response = ?, responded_at = ? WHERE id = ? AND status = 'claimed'`,
      [response, now, messageId]
    );

    if (result.changes === 0) {
      throw new Error(`Cannot respond to message ${messageId}: not in 'claimed' state`);
    }
  }

  /**
   * Wait for a response to a sent message.
   * Polls at the given interval until response arrives or timeout.
   */
  async waitForResponse(messageId: string, timeoutMs = 30000, pollMs = 200): Promise<Message | null> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const row = this.db.query(
        `SELECT * FROM messages WHERE id = ? AND status = 'responded'`
      ).get(messageId) as Message | null;

      if (row) return row;

      await new Promise(resolve => setTimeout(resolve, pollMs));
    }

    // Timeout — expire the message
    this.db.run(
      `UPDATE messages SET status = 'expired' WHERE id = ? AND status IN ('pending', 'claimed')`,
      [messageId]
    );

    return null;
  }

  /**
   * Get a message by ID.
   */
  get(messageId: string): Message | null {
    return this.db.query(`SELECT * FROM messages WHERE id = ?`).get(messageId) as Message | null;
  }

  /**
   * List messages for an agent (inbox or outbox).
   */
  list(agentName: string, direction: "inbox" | "outbox", status?: MessageStatus): Message[] {
    const col = direction === "inbox" ? "to_agent" : "from_agent";
    if (status) {
      return this.db.query(
        `SELECT * FROM messages WHERE ${col} = ? AND status = ? ORDER BY created_at DESC`
      ).all(agentName, status) as Message[];
    }
    return this.db.query(
      `SELECT * FROM messages WHERE ${col} = ? ORDER BY created_at DESC`
    ).all(agentName) as Message[];
  }

  /**
   * Remove old messages (responded or expired older than maxAgeMs).
   */
  prune(maxAgeMs = 24 * 60 * 60 * 1000): number {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    const result = this.db.run(
      `DELETE FROM messages WHERE status IN ('responded', 'expired') AND created_at < ?`,
      [cutoff]
    );
    return result.changes;
  }

  close(): void {
    this.db.close();
  }
}
