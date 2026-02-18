/**
 * Tests for memory/db-core.ts — schema, parsing, and stemming utilities.
 */
import { describe, it, expect } from "bun:test";
import { parseNode, parseEdge, stemWord, createTestDb } from "../src/memory/db-core";

// ── parseNode ─────────────────────────────────────────────────────────

describe("parseNode", () => {
  it("parses a complete node row", () => {
    const node = parseNode({
      id: "abc-123",
      node_type: "entity",
      subtype: "person",
      content: "Alice",
      salience: 1.5,
      confidence: 0.9,
      source: "user",
      created_at: "2024-01-01",
      valid_from: "2024-01-01",
      valid_until: null,
      superseded_by: null,
      attributes: '{"role":"engineer"}',
      can_summarize: 1,
      scope: 0.5,
    });
    expect(node.id).toBe("abc-123");
    expect(node.node_type).toBe("entity");
    expect(node.subtype).toBe("person");
    expect(node.content).toBe("Alice");
    expect(node.salience).toBe(1.5);
    expect(node.confidence).toBe(0.9);
    expect(node.attributes).toEqual({ role: "engineer" });
    expect(node.scope).toBe(0.5);
  });

  it("handles null/undefined optional fields", () => {
    const node = parseNode({
      id: "x",
      node_type: "fact",
      subtype: null,
      content: "test",
      salience: 1,
      confidence: 1,
      source: "user",
      created_at: "2024-01-01",
      attributes: "{}",
    });
    expect(node.subtype).toBeFalsy();
    expect(node.valid_from).toBeFalsy();
    expect(node.superseded_by).toBeFalsy();
    expect(node.scope).toBeFalsy();
  });

  it("defaults attributes to empty object on null", () => {
    const node = parseNode({
      id: "x",
      node_type: "fact",
      content: "test",
      salience: 1,
      confidence: 1,
      source: "user",
      created_at: "now",
      attributes: null,
    });
    expect(node.attributes).toEqual({});
  });
});

// ── parseEdge ─────────────────────────────────────────────────────────

describe("parseEdge", () => {
  it("parses an edge row", () => {
    const edge = parseEdge({
      id: "edge-1",
      source_id: "a",
      target_id: "b",
      edge_type: "has_role",
      attributes: '{"weight":1}',
      created_at: "2024-01-01",
    });
    expect(edge.id).toBe("edge-1");
    expect(edge.source_id).toBe("a");
    expect(edge.target_id).toBe("b");
    expect(edge.edge_type).toBe("has_role");
    expect(edge.attributes).toEqual({ weight: 1 });
  });
});

// ── stemWord ──────────────────────────────────────────────────────────

describe("stemWord", () => {
  it("returns short words unchanged", () => {
    expect(stemWord("the")).toBe("the");
    expect(stemWord("is")).toBe("is");
  });

  it("strips common suffixes", () => {
    expect(stemWord("running")).toBe("run"); // strips "ning" suffix first
    expect(stemWord("worked")).toBe("work");  // strips "ed"
    expect(stemWord("players")).toBe("player"); // strips "s"
  });

  it("strips -ting suffix", () => {
    expect(stemWord("creating")).toBe("crea"); // strips "ting"
  });

  it("strips -ly suffix", () => {
    expect(stemWord("quickly")).toBe("quick"); // strips "ly"
  });

  it("preserves double-s words", () => {
    // "ss" ending doesn't strip "s"
    expect(stemWord("across")).toBe("across");
  });
});

// ── createTestDb ──────────────────────────────────────────────────────

describe("createTestDb", () => {
  it("creates in-memory DB with schema", () => {
    const db = createTestDb();
    // Should have nodes, edges, embeddings tables
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map(t => t.name);
    expect(names).toContain("nodes");
    expect(names).toContain("edges");
    expect(names).toContain("embeddings");
    db.close();
  });
});
