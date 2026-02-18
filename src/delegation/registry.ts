/**
 * Agent registry — reads agents.json, provides lookup/validation.
 *
 * agents.json structure:
 * {
 *   "agents": {
 *     "main": { "description": "Primary agent", "connections": ["researcher"] },
 *     "researcher": { "description": "Research specialist", "connections": ["main"] }
 *   }
 * }
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";

export interface AgentConfig {
  description: string;
  connections: string[];
}

export interface AgentsFile {
  agents: Record<string, AgentConfig>;
}

export class AgentRegistry {
  private agents: Record<string, AgentConfig>;
  private filePath: string;

  constructor(projectDir: string) {
    this.filePath = join(projectDir, "agents.json");
    this.agents = {};
    this.load();
  }

  private load(): void {
    if (!existsSync(this.filePath)) {
      throw new Error(`agents.json not found at ${this.filePath}`);
    }

    try {
      const raw = readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as AgentsFile;

      if (!parsed.agents || typeof parsed.agents !== "object") {
        throw new Error("agents.json missing 'agents' object");
      }

      // Validate connections point to real agents
      for (const [name, config] of Object.entries(parsed.agents)) {
        if (!config.description) {
          throw new Error(`Agent "${name}" missing description`);
        }
        for (const conn of config.connections || []) {
          if (conn === name) {
            throw new Error(`Agent "${name}" cannot connect to itself`);
          }
          if (!parsed.agents[conn]) {
            throw new Error(`Agent "${name}" connects to unknown agent "${conn}"`);
          }
        }
      }

      this.agents = parsed.agents;
    } catch (err) {
      if ((err as Error).message.includes("agents.json")) throw err;
      throw new Error(`Failed to parse agents.json: ${(err as Error).message}`);
    }
  }

  /** List all agent names. */
  list(): string[] {
    return Object.keys(this.agents);
  }

  /** Get config for a specific agent. */
  get(name: string): AgentConfig | null {
    return this.agents[name] ?? null;
  }

  /** Check if an agent exists. */
  hasAgent(name: string): boolean {
    return name in this.agents;
  }

  /** Get connections for an agent. */
  connections(name: string): string[] {
    return this.agents[name]?.connections ?? [];
  }

  /** Check if agent A can talk to agent B. */
  canConnect(from: string, to: string): boolean {
    return this.connections(from).includes(to);
  }

  /** Get all agents as entries. */
  entries(): [string, AgentConfig][] {
    return Object.entries(this.agents);
  }
}
