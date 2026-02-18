/**
 * Tests for the Agent Registry.
 *
 * The registry scans ~/.octybot/agents/ (and projects/) for agent dirs,
 * reading agent.json from each. Tests simulate this by creating a temp
 * directory structure with agents/<name>/agent.json.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { AgentRegistry } from "../src/delegation/registry";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";

const TEST_DIR = join(import.meta.dir, ".test-registry");

/** Create an agent dir with agent.json inside TEST_DIR/agents/<name>/ */
function createAgent(name: string, config: { description: string; connections: string[]; tools?: string[] }) {
  const agentDir = join(TEST_DIR, "agents", name);
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "agent.json"), JSON.stringify(config, null, 2));
}

/** Create a legacy agent dir with agents.json inside TEST_DIR/projects/<name>/ */
function createLegacyAgent(name: string, config: { description: string; connections: string[] }) {
  const agentDir = join(TEST_DIR, "projects", name);
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "agents.json"), JSON.stringify({ agents: { [name]: config } }, null, 2));
}

beforeEach(() => {
  mkdirSync(join(TEST_DIR, "agents"), { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
});

describe("AgentRegistry", () => {
  it("scans agent directories", () => {
    createAgent("main", { description: "Primary agent", connections: ["researcher"] });
    createAgent("researcher", { description: "Research specialist", connections: [] });

    const registry = new AgentRegistry(TEST_DIR);
    expect(registry.list().sort()).toEqual(["main", "researcher"]);
  });

  it("get returns agent config", () => {
    createAgent("main", { description: "Primary agent", connections: [] });

    const registry = new AgentRegistry(TEST_DIR);
    const config = registry.get("main");
    expect(config).not.toBeNull();
    expect(config!.description).toBe("Primary agent");
    expect(config!.connections).toEqual([]);
  });

  it("get returns null for unknown agent", () => {
    createAgent("main", { description: "Primary agent", connections: [] });

    const registry = new AgentRegistry(TEST_DIR);
    expect(registry.get("unknown")).toBeNull();
  });

  it("hasAgent checks existence", () => {
    createAgent("main", { description: "Primary agent", connections: [] });

    const registry = new AgentRegistry(TEST_DIR);
    expect(registry.hasAgent("main")).toBe(true);
    expect(registry.hasAgent("nonexistent")).toBe(false);
  });

  it("connections returns agent connections", () => {
    createAgent("main", { description: "Primary", connections: ["researcher", "writer"] });
    createAgent("researcher", { description: "Research", connections: ["main"] });
    createAgent("writer", { description: "Writer", connections: ["main"] });

    const registry = new AgentRegistry(TEST_DIR);
    expect(registry.connections("main")).toEqual(["researcher", "writer"]);
    expect(registry.connections("researcher")).toEqual(["main"]);
    expect(registry.connections("nonexistent")).toEqual([]);
  });

  it("canConnect checks directional connection", () => {
    createAgent("main", { description: "Primary", connections: ["researcher"] });
    createAgent("researcher", { description: "Research", connections: [] });

    const registry = new AgentRegistry(TEST_DIR);
    expect(registry.canConnect("main", "researcher")).toBe(true);
    expect(registry.canConnect("researcher", "main")).toBe(false);
  });

  it("returns empty list when no agents exist", () => {
    const registry = new AgentRegistry(TEST_DIR);
    expect(registry.list()).toEqual([]);
  });

  it("reads legacy agents.json from projects/", () => {
    createLegacyAgent("old-agent", { description: "Legacy agent", connections: [] });

    const registry = new AgentRegistry(TEST_DIR);
    expect(registry.hasAgent("old-agent")).toBe(true);
    expect(registry.get("old-agent")!.description).toBe("Legacy agent");
  });

  it("agents/ takes priority over projects/ for same name", () => {
    createAgent("shared", { description: "New version", connections: [] });
    createLegacyAgent("shared", { description: "Old version", connections: [] });

    const registry = new AgentRegistry(TEST_DIR);
    expect(registry.get("shared")!.description).toBe("New version");
  });

  it("entries returns all agents", () => {
    createAgent("main", { description: "Primary", connections: [] });
    createAgent("helper", { description: "Helper", connections: [] });

    const registry = new AgentRegistry(TEST_DIR);
    const entries = registry.entries();
    expect(entries.length).toBe(2);
    expect(entries.map(([name]) => name).sort()).toEqual(["helper", "main"]);
  });
});
