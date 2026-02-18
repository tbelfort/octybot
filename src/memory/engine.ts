/**
 * MemoryEngine — standalone memory system that owns its database.
 *
 * Usage:
 *   const engine = new MemoryEngine({ dbPath: "~/.octybot/data/default/default/memory.db" });
 *   const context = await engine.retrieve(prompt, layer1Result);
 *   await engine.store(prompt, layer1Result);
 *   engine.close();
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname, join } from "path";
import { initSchema } from "./db-core";
import { classify } from "./layer1";
import { agenticLoop } from "./layer2";
import { followUpPipeline } from "./follow-up";
import type { AgenticResult } from "./layer2";
import type { Layer1Result, ConversationTurn } from "./types";

export interface MemoryConfig {
  dbPath: string;
  statePath?: string;
}

export class MemoryEngine {
  private db: Database;
  private config: MemoryConfig;
  private statePath: string;

  constructor(config: MemoryConfig) {
    this.config = config;
    this.statePath = config.statePath ?? join(dirname(config.dbPath), ".conversation-state.json");
    mkdirSync(dirname(config.dbPath), { recursive: true });
    this.db = new Database(config.dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    initSchema(this.db);
  }

  /**
   * Classify + retrieve context for a prompt.
   * Returns curated context string, or null if nothing relevant.
   */
  async retrieve(prompt: string, layer1Result?: Layer1Result): Promise<string | null> {
    const l1 = layer1Result ?? (await classify(prompt)).result;
    if (!l1.operations.retrieve) return null;

    const result = await agenticLoop(this.db, prompt, {
      ...l1,
      operations: { retrieve: true, store: false },
    });

    return result.curatedContext || result.context || null;
  }

  /**
   * Classify + store memories from a prompt.
   */
  async store(prompt: string, layer1Result?: Layer1Result): Promise<void> {
    const l1 = layer1Result ?? (await classify(prompt)).result;

    const hasStorableContent =
      l1.implied_facts.length > 0 ||
      l1.events.length > 0 ||
      l1.opinions.length > 0 ||
      l1.intents.includes("instruction");

    if (!hasStorableContent) return;

    await agenticLoop(this.db, prompt, {
      ...l1,
      operations: { retrieve: false, store: true },
    });
  }

  /**
   * Full pipeline: retrieve + store in parallel.
   * Returns the agentic result with context, turns, timing, etc.
   */
  async process(prompt: string, layer1Result?: Layer1Result): Promise<AgenticResult> {
    const l1 = layer1Result ?? (await classify(prompt)).result;
    return agenticLoop(this.db, prompt, l1);
  }

  /**
   * Conversation-aware follow-up retrieval.
   */
  async followUp(prompt: string, previousTurns: ConversationTurn[]): Promise<{ context: string } | null> {
    const result = await followUpPipeline(this.db, prompt, previousTurns);
    if (!result) return null;
    return { context: result.context };
  }

  /** Get the underlying database instance. */
  getDatabase(): Database {
    return this.db;
  }

  /** Close the database connection. */
  close(): void {
    this.db.close();
  }
}
