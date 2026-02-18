/**
 * Tests for memory/assemble.ts — context assembly from tool results.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { unlinkSync, existsSync } from "fs";
import { assembleContext, flattenSections, type ContextSections } from "../src/memory/assemble";
import type { ToolTurn, MemoryNode } from "../src/memory/types";

const TEST_DB = "/tmp/test-assemble.db";

function createSchema(db: Database) {
  db.run(`CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY,
    node_type TEXT NOT NULL,
    subtype TEXT,
    content TEXT NOT NULL,
    salience REAL DEFAULT 1.0,
    confidence REAL DEFAULT 1.0,
    source TEXT DEFAULT 'user',
    created_at TEXT DEFAULT (datetime('now')),
    valid_from TEXT,
    valid_until TEXT,
    superseded_by TEXT,
    attributes TEXT DEFAULT '{}',
    can_summarize INTEGER DEFAULT 1,
    scope REAL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS edges (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    edge_type TEXT NOT NULL,
    attributes TEXT DEFAULT '{}',
    created_at TEXT DEFAULT (datetime('now'))
  )`);
}

function insertNode(db: Database, id: string, type: string, content: string, opts: Record<string, unknown> = {}) {
  db.run(
    `INSERT INTO nodes (id, node_type, subtype, content, salience, scope, superseded_by, valid_from) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, type, opts.subtype ?? null, content, opts.salience ?? 1.0, opts.scope ?? null, opts.superseded_by ?? null, opts.valid_from ?? null]
  );
}

function insertEdge(db: Database, sourceId: string, targetId: string, edgeType: string) {
  db.run(
    `INSERT INTO edges (id, source_id, target_id, edge_type) VALUES (?, ?, ?, ?)`,
    [crypto.randomUUID(), sourceId, targetId, edgeType]
  );
}

function makeTurn(toolName: string, result: string): ToolTurn {
  return {
    tool_call: { name: toolName, arguments: {} },
    result: { name: toolName, result },
  };
}

let db: Database;

describe("assembleContext", () => {
  beforeEach(() => {
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
    db = new Database(TEST_DB);
    createSchema(db);
  });

  afterEach(() => {
    db.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      try { unlinkSync(TEST_DB + suffix); } catch {}
    }
  });

  it("returns empty sections when no tool turns provided", () => {
    const sections = assembleContext(db, []);
    expect(sections.entities).toBe("");
    expect(sections.instructions).toBe("");
    expect(sections.facts).toBe("");
    expect(sections.events).toBe("");
    expect(sections.plans).toBe("");
  });

  it("returns empty sections when turns have no node IDs", () => {
    const turns: ToolTurn[] = [
      makeTurn("search_entity", "No entities found matching 'test'"),
    ];
    const sections = assembleContext(db, turns);
    expect(sections.entities).toBe("");
  });

  it("extracts entity nodes from tool results", () => {
    insertNode(db, "e1", "entity", "Alice (person)");
    const turns: ToolTurn[] = [
      makeTurn("search_entity", "Alice (person) (id: e1) [score: 0.85]"),
    ];
    const sections = assembleContext(db, turns);
    expect(sections.entities).toContain("Alice (person)");
  });

  it("extracts fact nodes from tool results", () => {
    insertNode(db, "f1", "fact", "Alice works at Acme Corp");
    const turns: ToolTurn[] = [
      makeTurn("search_facts", "Alice works at Acme Corp (id: f1) [score: 0.9]"),
    ];
    const sections = assembleContext(db, turns);
    expect(sections.facts).toContain("Alice works at Acme Corp");
  });

  it("extracts instruction nodes from tool results", () => {
    insertNode(db, "a1", "instruction", "Always check the database before responding", { scope: 0.8 });
    const turns: ToolTurn[] = [
      makeTurn("get_instructions", "Always check the database before responding (id: a1) [score: 0.7]"),
    ];
    const sections = assembleContext(db, turns);
    expect(sections.instructions).toContain("Always check the database before responding");
  });

  it("skips superseded nodes", () => {
    insertNode(db, "f1", "fact", "Old fact", { superseded_by: "f2" });
    insertNode(db, "f2", "fact", "New fact");
    const turns: ToolTurn[] = [
      makeTurn("search_facts", "Old fact (id: f1) [score: 0.9]\nNew fact (id: f2) [score: 0.8]"),
    ];
    const sections = assembleContext(db, turns);
    expect(sections.facts).not.toContain("Old fact");
    expect(sections.facts).toContain("New fact");
  });

  it("takes the highest score when a node appears in multiple tools", () => {
    insertNode(db, "f1", "fact", "Shared fact");
    const turns: ToolTurn[] = [
      makeTurn("search_facts", "Shared fact (id: f1) [score: 0.3]"),
      makeTurn("search_facts", "Shared fact (id: f1) [score: 0.9]"),
    ];
    const sections = assembleContext(db, turns);
    expect(sections.facts).toContain("Shared fact");
  });

  it("skips done/store tool turns", () => {
    const turns: ToolTurn[] = [
      makeTurn("done", ""),
      makeTurn("store_memory", "Stored node xyz"),
    ];
    const sections = assembleContext(db, turns);
    expect(sections.entities).toBe("");
    expect(sections.facts).toBe("");
  });

  it("sorts instructions by cosine score first, scope as tiebreaker", () => {
    insertNode(db, "a1", "instruction", "Low scope high score", { scope: 0.2 });
    insertNode(db, "a2", "instruction", "High scope low score", { scope: 0.9 });
    const turns: ToolTurn[] = [
      makeTurn("get_instructions",
        "Low scope high score (id: a1) [score: 0.9]\nHigh scope low score (id: a2) [score: 0.5]"),
    ];
    const sections = assembleContext(db, turns);
    const lines = sections.instructions.split("\n");
    expect(lines[0]).toContain("Low scope high score");
    expect(lines[1]).toContain("High scope low score");
  });

  it("handles events and plans separately", () => {
    insertNode(db, "ae1", "event", "Meeting happened yesterday");
    insertNode(db, "be1", "plan", "Launch next week", { valid_from: "2099-12-31" });
    const turns: ToolTurn[] = [
      makeTurn("search_events", "Meeting happened yesterday (id: ae1) [score: 0.8]\nLaunch next week (id: be1) [score: 0.7]"),
    ];
    const sections = assembleContext(db, turns);
    expect(sections.events).toContain("Meeting happened yesterday");
    expect(sections.plans).toContain("Launch next week");
  });

  it("includes entity relationships", () => {
    insertNode(db, "e1", "entity", "Alice");
    insertNode(db, "f1", "fact", "Software engineer");
    insertEdge(db, "e1", "f1", "has_role");
    const turns: ToolTurn[] = [
      makeTurn("search_entity", "Alice (id: e1) [score: 0.9]"),
    ];
    const sections = assembleContext(db, turns);
    expect(sections.entities).toContain("Alice");
    expect(sections.entities).toContain("has_role");
    expect(sections.entities).toContain("Software engineer");
  });
});

describe("flattenSections", () => {
  it("returns empty string for all-empty sections", () => {
    const sections: ContextSections = { entities: "", instructions: "", facts: "", events: "", plans: "" };
    expect(flattenSections(sections)).toBe("");
  });

  it("includes section headers for non-empty sections", () => {
    const sections: ContextSections = {
      entities: "Alice",
      instructions: "Do X",
      facts: "",
      events: "",
      plans: "",
    };
    const result = flattenSections(sections);
    expect(result).toContain("People & things:\nAlice");
    expect(result).toContain("Instructions:\nDo X");
    expect(result).not.toContain("Facts:");
  });

  it("joins sections with double newlines", () => {
    const sections: ContextSections = {
      entities: "Alice",
      instructions: "",
      facts: "Fact 1",
      events: "",
      plans: "",
    };
    const result = flattenSections(sections);
    expect(result).toContain("People & things:\nAlice\n\nFacts:\nFact 1");
  });
});
