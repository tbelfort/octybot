/**
 * Tests for memory/db-crud.ts and memory/db-queries.ts — CRUD and query operations.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createTestDb } from "../src/memory/db-core";
import { createNode, createEdge, getNode, deleteNode, supersedeNode, promotePlanToEvent } from "../src/memory/db-crud";
import { getRelationships, getFactsByEntity, getInstructions, getGlobalInstructions, getInstructionsByEntity } from "../src/memory/db-queries";

let db: Database;

beforeEach(() => {
  db = createTestDb();
});

afterEach(() => {
  db.close();
});

// ── createNode / getNode ──────────────────────────────────────────────

describe("createNode + getNode", () => {
  it("creates and retrieves a basic entity", () => {
    const id = createNode(db, {
      node_type: "entity",
      content: "Alice (person)",
      salience: 1.0,
      confidence: 1.0,
      source: "user",
      attributes: {},
    });
    expect(id).toMatch(/^[a-f0-9-]+$/);

    const node = getNode(db, id);
    expect(node).not.toBeNull();
    expect(node!.content).toBe("Alice (person)");
    expect(node!.node_type).toBe("entity");
  });

  it("returns null for nonexistent node", () => {
    expect(getNode(db, "nonexistent-id")).toBeNull();
  });

  it("defaults instruction scope to 0.5", () => {
    const id = createNode(db, {
      node_type: "instruction",
      content: "Always greet the user",
      salience: 1.0,
      confidence: 1.0,
      source: "user",
      attributes: {},
    });
    const node = getNode(db, id);
    expect(node!.scope).toBe(0.5);
  });

  it("sets can_summarize to 0 for instructions", () => {
    const id = createNode(db, {
      node_type: "instruction",
      content: "Never reveal secrets",
      salience: 1.0,
      confidence: 1.0,
      source: "user",
      attributes: {},
    });
    const node = getNode(db, id);
    expect(node!.can_summarize).toBe(0);
  });

  it("preserves custom scope on instructions", () => {
    const id = createNode(db, {
      node_type: "instruction",
      content: "Global rule",
      salience: 1.0,
      confidence: 1.0,
      source: "user",
      attributes: {},
      scope: 0.9,
    });
    const node = getNode(db, id);
    expect(node!.scope).toBe(0.9);
  });

  it("sets scope to null for non-instruction types", () => {
    const id = createNode(db, {
      node_type: "fact",
      content: "Sky is blue",
      salience: 1.0,
      confidence: 1.0,
      source: "user",
      attributes: {},
    });
    const node = getNode(db, id);
    expect(node!.scope).toBeFalsy();
  });
});

// ── createEdge ────────────────────────────────────────────────────────

describe("createEdge", () => {
  it("creates an edge between two nodes", () => {
    const e1 = createNode(db, { node_type: "entity", content: "Alice", salience: 1, confidence: 1, source: "user", attributes: {} });
    const f1 = createNode(db, { node_type: "fact", content: "Engineer", salience: 1, confidence: 1, source: "user", attributes: {} });
    const edgeId = createEdge(db, { source_id: e1, target_id: f1, edge_type: "has_role" });
    expect(edgeId).toMatch(/^[a-f0-9-]+$/);
  });
});

// ── deleteNode ────────────────────────────────────────────────────────

describe("deleteNode", () => {
  it("deletes a node and its edges", () => {
    const e1 = createNode(db, { node_type: "entity", content: "Alice", salience: 1, confidence: 1, source: "user", attributes: {} });
    const f1 = createNode(db, { node_type: "fact", content: "Engineer", salience: 1, confidence: 1, source: "user", attributes: {} });
    createEdge(db, { source_id: e1, target_id: f1, edge_type: "has_role" });

    expect(deleteNode(db, e1)).toBe(true);
    expect(getNode(db, e1)).toBeNull();

    // Edge should be gone too
    const rels = getRelationships(db, f1);
    expect(rels.length).toBe(0);
  });

  it("returns false for nonexistent node", () => {
    expect(deleteNode(db, "nonexistent")).toBe(false);
  });
});

// ── supersedeNode ─────────────────────────────────────────────────────

describe("supersedeNode", () => {
  it("creates new node and marks old as superseded", () => {
    const oldId = createNode(db, { node_type: "fact", content: "Alice is a junior", salience: 1, confidence: 1, source: "user", attributes: {} });
    const newId = supersedeNode(db, oldId, "Alice is a senior");

    const oldNode = getNode(db, oldId);
    expect(oldNode!.superseded_by).toBe(newId);

    const newNode = getNode(db, newId);
    expect(newNode!.content).toBe("Alice is a senior");
    expect(newNode!.node_type).toBe("fact");
  });

  it("copies edges to the new node", () => {
    const entity = createNode(db, { node_type: "entity", content: "Alice", salience: 1, confidence: 1, source: "user", attributes: {} });
    const factId = createNode(db, { node_type: "fact", content: "Old fact", salience: 1, confidence: 1, source: "user", attributes: {} });
    createEdge(db, { source_id: entity, target_id: factId, edge_type: "about" });

    const newFactId = supersedeNode(db, factId, "New fact");

    // New fact should have the "about" edge from entity
    const rels = getRelationships(db, newFactId);
    expect(rels.length).toBeGreaterThanOrEqual(1);
    expect(rels.some(r => r.edge.edge_type === "about")).toBe(true);
  });

  it("throws for nonexistent node", () => {
    expect(() => supersedeNode(db, "nonexistent", "new content")).toThrow("not found");
  });
});

// ── promotePlanToEvent ────────────────────────────────────────────────

describe("promotePlanToEvent", () => {
  it("converts a plan node to event type", () => {
    const planId = createNode(db, {
      node_type: "plan",
      subtype: "scheduled",
      content: "Launch product",
      salience: 1,
      confidence: 1,
      source: "user",
      attributes: {},
      valid_from: "2024-01-01",
    });

    const promoted = promotePlanToEvent(db, planId);
    expect(promoted).not.toBeNull();
    expect(promoted!.node_type).toBe("event");
    expect(promoted!.subtype).toBe("completed_plan");
    expect(promoted!.content).toBe("Launch product");
  });

  it("returns null for non-plan node", () => {
    const factId = createNode(db, { node_type: "fact", content: "Something", salience: 1, confidence: 1, source: "user", attributes: {} });
    expect(promotePlanToEvent(db, factId)).toBeNull();
  });

  it("returns null for nonexistent node", () => {
    expect(promotePlanToEvent(db, "nonexistent")).toBeNull();
  });
});

// ── getRelationships ──────────────────────────────────────────────────

describe("getRelationships", () => {
  it("returns outgoing and incoming edges", () => {
    const e1 = createNode(db, { node_type: "entity", content: "Alice", salience: 1, confidence: 1, source: "user", attributes: {} });
    const e2 = createNode(db, { node_type: "entity", content: "Acme", salience: 1, confidence: 1, source: "user", attributes: {} });
    const f1 = createNode(db, { node_type: "fact", content: "Engineer", salience: 1, confidence: 1, source: "user", attributes: {} });
    createEdge(db, { source_id: e1, target_id: f1, edge_type: "has_role" });
    createEdge(db, { source_id: e2, target_id: e1, edge_type: "employs" });

    const rels = getRelationships(db, e1);
    expect(rels.length).toBe(2);

    const edgeTypes = rels.map(r => r.edge.edge_type).sort();
    expect(edgeTypes).toEqual(["employs", "has_role"]);
  });

  it("skips superseded target nodes", () => {
    const e1 = createNode(db, { node_type: "entity", content: "Alice", salience: 1, confidence: 1, source: "user", attributes: {} });
    const oldFact = createNode(db, { node_type: "fact", content: "Old role", salience: 1, confidence: 1, source: "user", attributes: {} });
    createEdge(db, { source_id: e1, target_id: oldFact, edge_type: "has_role" });

    // Supersede it
    supersedeNode(db, oldFact, "New role");

    const rels = getRelationships(db, e1);
    // Old fact should be excluded (superseded), new fact should appear via copied edge
    const contents = rels.map(r => r.target.content);
    expect(contents).not.toContain("Old role");
    expect(contents).toContain("New role");
  });
});

// ── getInstructions ───────────────────────────────────────────────────

describe("getInstructions", () => {
  it("returns all instructions when no topic", () => {
    createNode(db, { node_type: "instruction", content: "Be polite", salience: 1, confidence: 1, source: "user", attributes: {} });
    createNode(db, { node_type: "instruction", content: "Check databases", salience: 1, confidence: 1, source: "user", attributes: {} });
    createNode(db, { node_type: "fact", content: "Sky is blue", salience: 1, confidence: 1, source: "user", attributes: {} });

    const results = getInstructions(db);
    expect(results.length).toBe(2);
    expect(results.every(r => r.node_type === "instruction")).toBe(true);
  });

  it("filters by topic keyword matching", () => {
    createNode(db, { node_type: "instruction", content: "Always check the database", salience: 1, confidence: 1, source: "user", attributes: {} });
    createNode(db, { node_type: "instruction", content: "Be polite to users", salience: 1, confidence: 1, source: "user", attributes: {} });

    const results = getInstructions(db, "database");
    expect(results.length).toBe(1);
    expect(results[0].content).toContain("database");
  });

  it("skips superseded instructions", () => {
    const id = createNode(db, { node_type: "instruction", content: "Old rule", salience: 1, confidence: 1, source: "user", attributes: {} });
    supersedeNode(db, id, "New rule");

    const results = getInstructions(db);
    const contents = results.map(r => r.content);
    expect(contents).not.toContain("Old rule");
    expect(contents).toContain("New rule");
  });

  it("returns empty for topic with only short words", () => {
    createNode(db, { node_type: "instruction", content: "Something", salience: 1, confidence: 1, source: "user", attributes: {} });
    const results = getInstructions(db, "a b");
    expect(results.length).toBe(0);
  });
});

// ── getGlobalInstructions ─────────────────────────────────────────────

describe("getGlobalInstructions", () => {
  it("returns only instructions with scope >= 0.8", () => {
    createNode(db, { node_type: "instruction", content: "Global rule", salience: 1, confidence: 1, source: "user", attributes: {}, scope: 0.9 });
    createNode(db, { node_type: "instruction", content: "Local rule", salience: 1, confidence: 1, source: "user", attributes: {}, scope: 0.3 });
    createNode(db, { node_type: "instruction", content: "Default scope rule", salience: 1, confidence: 1, source: "user", attributes: {} }); // scope defaults to 0.5

    const results = getGlobalInstructions(db);
    expect(results.length).toBe(1);
    expect(results[0].content).toBe("Global rule");
  });
});

// ── getInstructionsByEntity ───────────────────────────────────────────

describe("getInstructionsByEntity", () => {
  it("returns instructions connected to an entity via edges", () => {
    const entity = createNode(db, { node_type: "entity", content: "Slack", salience: 1, confidence: 1, source: "user", attributes: {} });
    const instr1 = createNode(db, { node_type: "instruction", content: "Use threads in Slack", salience: 1, confidence: 1, source: "user", attributes: {} });
    const instr2 = createNode(db, { node_type: "instruction", content: "Unrelated rule", salience: 1, confidence: 1, source: "user", attributes: {} });
    createEdge(db, { source_id: entity, target_id: instr1, edge_type: "has_instruction" });

    const results = getInstructionsByEntity(db, entity);
    expect(results.length).toBe(1);
    expect(results[0].content).toBe("Use threads in Slack");
  });
});

// ── getFactsByEntity ──────────────────────────────────────────────────

describe("getFactsByEntity", () => {
  it("returns facts connected to an entity", () => {
    const entity = createNode(db, { node_type: "entity", content: "Alice", salience: 1, confidence: 1, source: "user", attributes: {} });
    const fact = createNode(db, { node_type: "fact", content: "Software engineer", salience: 1, confidence: 1, source: "user", attributes: {} });
    const opinion = createNode(db, { node_type: "opinion", content: "Prefers dark mode", salience: 1, confidence: 1, source: "user", attributes: {} });
    createEdge(db, { source_id: entity, target_id: fact, edge_type: "has_role" });
    createEdge(db, { source_id: entity, target_id: opinion, edge_type: "preference" });

    const results = getFactsByEntity(db, entity);
    expect(results.length).toBe(2);
    const contents = results.map(r => r.content);
    expect(contents).toContain("Software engineer");
    expect(contents).toContain("Prefers dark mode");
  });
});
