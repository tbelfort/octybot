/**
 * Tests for the Agent Registry.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { AgentRegistry } from "../src/delegation/registry";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";

const TEST_DIR = join(import.meta.dir, ".test-registry");

function writeAgentsJson(agents: Record<string, { description: string; connections: string[] }>) {
  writeFileSync(join(TEST_DIR, "agents.json"), JSON.stringify({ agents }, null, 2));
}

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
});

describe("AgentRegistry", () => {
  it("loads valid agents.json", () => {
    writeAgentsJson({
      main: { description: "Primary agent", connections: ["researcher"] },
      researcher: { description: "Research specialist", connections: ["main"] },
    });

    const registry = new AgentRegistry(TEST_DIR);
    expect(registry.list()).toEqual(["main", "researcher"]);
  });

  it("get returns agent config", () => {
    writeAgentsJson({
      main: { description: "Primary agent", connections: [] },
    });

    const registry = new AgentRegistry(TEST_DIR);
    const config = registry.get("main");
    expect(config).not.toBeNull();
    expect(config!.description).toBe("Primary agent");
    expect(config!.connections).toEqual([]);
  });

  it("get returns null for unknown agent", () => {
    writeAgentsJson({
      main: { description: "Primary agent", connections: [] },
    });

    const registry = new AgentRegistry(TEST_DIR);
    expect(registry.get("unknown")).toBeNull();
  });

  it("hasAgent checks existence", () => {
    writeAgentsJson({
      main: { description: "Primary agent", connections: [] },
    });

    const registry = new AgentRegistry(TEST_DIR);
    expect(registry.hasAgent("main")).toBe(true);
    expect(registry.hasAgent("nonexistent")).toBe(false);
  });

  it("connections returns agent connections", () => {
    writeAgentsJson({
      main: { description: "Primary", connections: ["researcher", "writer"] },
      researcher: { description: "Research", connections: ["main"] },
      writer: { description: "Writer", connections: ["main"] },
    });

    const registry = new AgentRegistry(TEST_DIR);
    expect(registry.connections("main")).toEqual(["researcher", "writer"]);
    expect(registry.connections("researcher")).toEqual(["main"]);
    expect(registry.connections("nonexistent")).toEqual([]);
  });

  it("canConnect checks directional connection", () => {
    writeAgentsJson({
      main: { description: "Primary", connections: ["researcher"] },
      researcher: { description: "Research", connections: [] },
    });

    const registry = new AgentRegistry(TEST_DIR);
    expect(registry.canConnect("main", "researcher")).toBe(true);
    expect(registry.canConnect("researcher", "main")).toBe(false);
  });

  it("throws on missing agents.json", () => {
    expect(() => new AgentRegistry(TEST_DIR)).toThrow("agents.json not found");
  });

  it("throws on invalid connection target", () => {
    writeAgentsJson({
      main: { description: "Primary", connections: ["ghost"] },
    });

    expect(() => new AgentRegistry(TEST_DIR)).toThrow('connects to unknown agent "ghost"');
  });

  it("throws on missing description", () => {
    writeFileSync(
      join(TEST_DIR, "agents.json"),
      JSON.stringify({ agents: { main: { connections: [] } } })
    );

    expect(() => new AgentRegistry(TEST_DIR)).toThrow('missing description');
  });

  it("throws on self-connection", () => {
    writeAgentsJson({
      main: { description: "Primary", connections: ["main"] },
    });

    expect(() => new AgentRegistry(TEST_DIR)).toThrow('cannot connect to itself');
  });

  it("entries returns all agents", () => {
    writeAgentsJson({
      main: { description: "Primary", connections: [] },
      helper: { description: "Helper", connections: [] },
    });

    const registry = new AgentRegistry(TEST_DIR);
    const entries = registry.entries();
    expect(entries.length).toBe(2);
    expect(entries.map(([name]) => name).sort()).toEqual(["helper", "main"]);
  });
});
