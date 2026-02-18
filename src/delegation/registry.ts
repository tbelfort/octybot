/**
 * Agent registry — scans agent directories and reads agent.json configs.
 *
 * Each agent lives in its own folder at:
 *   ~/.octybot/agents/<name>/agent.json     (new)
 *   ~/.octybot/projects/<name>/agent.json   (backward compat)
 *
 * agent.json format (flat, one per folder):
 * { "description": "What this agent does", "connections": ["other-agent"], "tools": [] }
 */

import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export interface AgentConfig {
  description: string;
  connections: string[];
  tools?: string[];
}

export class AgentRegistry {
  private agents: Record<string, AgentConfig>;
  private octyHome: string;

  constructor(octyHome?: string) {
    this.octyHome = octyHome || join(homedir(), ".octybot");
    this.agents = {};
    this.scan();
  }

  /**
   * Scan agent directories and build the registry.
   * Checks agents/ first, then projects/ for backward compat.
   */
  private scan(): void {
    const seen = new Set<string>();

    // Scan ~/.octybot/agents/
    this.scanDir(join(this.octyHome, "agents"), seen);

    // Scan ~/.octybot/projects/ (backward compat)
    this.scanDir(join(this.octyHome, "projects"), seen);
  }

  private scanDir(dir: string, seen: Set<string>): void {
    if (!existsSync(dir)) return;

    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const name = entry.name;
      if (seen.has(name)) continue; // agents/ takes priority over projects/

      const agentDir = join(dir, name);
      const config = this.readConfig(agentDir);
      if (config) {
        this.agents[name] = config;
        seen.add(name);
      }
    }
  }

  /**
   * Read agent config from a directory.
   * Tries agent.json first, then legacy agents.json.
   */
  private readConfig(agentDir: string): AgentConfig | null {
    // New format: agent.json (flat)
    const agentJsonPath = join(agentDir, "agent.json");
    if (existsSync(agentJsonPath)) {
      try {
        const raw = JSON.parse(readFileSync(agentJsonPath, "utf-8"));
        return {
          description: raw.description || "",
          connections: raw.connections || [],
          tools: raw.tools || [],
        };
      } catch {
        return null;
      }
    }

    // Legacy format: agents.json (multi-agent, take first entry)
    const legacyPath = join(agentDir, "agents.json");
    if (existsSync(legacyPath)) {
      try {
        const raw = JSON.parse(readFileSync(legacyPath, "utf-8"));
        if (raw.agents && typeof raw.agents === "object") {
          const first = Object.values(raw.agents)[0] as any;
          if (first) {
            return {
              description: first.description || "",
              connections: first.connections || [],
              tools: first.tools || [],
            };
          }
        }
      } catch {
        return null;
      }
    }

    return null;
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
