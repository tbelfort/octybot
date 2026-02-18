/**
 * Agent runtime — spawns and manages Claude Code processes per agent.
 *
 * Each agent runs in its own directory with its own hooks and memory.
 * Agent dirs are resolved from ~/.octybot/ config and directory structure.
 */

import { join } from "path";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";

export interface AgentProcess {
  name: string;
  proc: ReturnType<typeof Bun.spawn>;
  startedAt: number;
  lastActiveAt: number;
}

export interface RuntimeConfig {
  octyHome?: string;         // defaults to ~/.octybot
  idleTimeoutMs?: number;    // Kill idle agents after this (default: 5 min)
}

export class AgentRuntime {
  private processes = new Map<string, AgentProcess>();
  private octyHome: string;

  constructor(config: RuntimeConfig = {}) {
    this.octyHome = config.octyHome || join(homedir(), ".octybot");
  }

  /**
   * Resolve the working directory for an agent.
   * 1. Check config.json project_dirs for custom dir
   * 2. Try ~/.octybot/agents/<name>/
   * 3. Try ~/.octybot/projects/<name>/
   */
  private resolveAgentDir(agentName: string): string {
    // Check for custom dir mapping in config
    try {
      const configPath = join(this.octyHome, "config.json");
      if (existsSync(configPath)) {
        const config = JSON.parse(readFileSync(configPath, "utf-8"));
        if (config.project_dirs?.[agentName]) {
          const customDir = config.project_dirs[agentName];
          if (existsSync(customDir)) return customDir;
        }
      }
    } catch {}

    // Try agents/ then projects/
    const agentsPath = join(this.octyHome, "agents", agentName);
    if (existsSync(agentsPath)) return agentsPath;

    const projectsPath = join(this.octyHome, "projects", agentName);
    if (existsSync(projectsPath)) return projectsPath;

    return agentsPath; // default (will fail with clear error in run())
  }

  /**
   * Run a command as a specific agent, passing input via stdin.
   * Returns the stdout output.
   */
  async run(agentName: string, input: string, timeoutMs = 60000, systemPrompt?: string): Promise<string> {
    const agentDir = this.resolveAgentDir(agentName);
    if (!existsSync(agentDir)) {
      throw new Error(`Agent directory not found: ${agentDir}`);
    }

    // Build a clean env — strip all CLAUDE* vars so the child Claude Code
    // instance starts fresh (no nested session detection, no stale state).
    const cleanEnv: Record<string, string> = {};
    for (const [key, val] of Object.entries(process.env)) {
      if (val !== undefined && !key.startsWith("CLAUDE")) {
        cleanEnv[key] = val;
      }
    }
    cleanEnv.OCTYBOT_AGENT = agentName;

    const args = ["claude", "--print", "--dangerously-skip-permissions"];
    if (systemPrompt) {
      args.push("--append-system-prompt", systemPrompt);
    }
    args.push("-");

    const proc = Bun.spawn(args, {
      cwd: agentDir,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: cleanEnv,
    });

    // Guard against concurrent runs of the same agent
    if (this.processes.has(agentName)) {
      proc.kill();
      throw new Error(`Agent ${agentName} is already running`);
    }

    // Write input to stdin and close it
    const writer = proc.stdin!;
    writer.write(input);
    writer.end();

    // Track the process
    const entry: AgentProcess = {
      name: agentName,
      proc,
      startedAt: Date.now(),
      lastActiveAt: Date.now(),
    };
    this.processes.set(agentName, entry);

    // Race between completion and timeout
    let timer: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Agent ${agentName} timed out after ${timeoutMs}ms`)), timeoutMs);
    });

    try {
      const [stdout, stderr] = await Promise.race([
        Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]),
        timeoutPromise,
      ]) as [string, string];

      clearTimeout(timer!);
      const exitCode = await proc.exited;
      this.processes.delete(agentName);

      // Log stderr for debugging hook issues
      if (stderr.trim()) {
        process.stderr.write(`[delegation:${agentName}] stderr: ${stderr.trim()}\n`);
        try {
          const { writeFileSync } = require("fs");
          writeFileSync(join(this.octyHome, "delegation-debug.log"),
            `[${new Date().toISOString()}] ${agentName}\nstdout: ${stdout.slice(0, 500)}\nstderr: ${stderr}\ncwd: ${agentDir}\nexit: ${exitCode}\n---\n`,
            { flag: "a" });
        } catch {}
      }

      if (exitCode !== 0) {
        throw new Error(`Agent ${agentName} exited with code ${exitCode}: ${stderr}`);
      }

      return stdout.trim();
    } catch (err) {
      clearTimeout(timer!);
      // Kill on timeout
      await this.forceKill(proc);
      this.processes.delete(agentName);
      throw err;
    }
  }

  /**
   * Check if an agent process is currently running.
   * Lazily cleans up stale entries where the process has already exited.
   */
  isRunning(agentName: string): boolean {
    const entry = this.processes.get(agentName);
    if (!entry) return false;
    if (entry.proc.exitCode !== null) {
      this.processes.delete(agentName);
      return false;
    }
    return true;
  }

  /**
   * Kill a specific agent process.
   */
  async kill(agentName: string): Promise<boolean> {
    const entry = this.processes.get(agentName);
    if (!entry) return false;
    this.processes.delete(agentName);
    await this.forceKill(entry.proc);
    return true;
  }

  /**
   * Kill all running agent processes.
   */
  async killAll(): Promise<void> {
    const entries = Array.from(this.processes.values());
    this.processes.clear();
    await Promise.all(entries.map(e => this.forceKill(e.proc)));
  }

  /**
   * Force-kill a process: SIGTERM, then SIGKILL after 5s if still alive.
   */
  private async forceKill(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
    try {
      proc.kill();
    } catch {
      return; // already dead
    }

    const exited = Promise.race([
      proc.exited,
      new Promise<"timeout">(resolve => setTimeout(() => resolve("timeout"), 5000)),
    ]);

    const result = await exited;
    if (result === "timeout") {
      try {
        proc.kill(9);
      } catch {
        // already dead
      }
    }
  }

  /**
   * List running agents with their uptime.
   */
  listRunning(): { name: string; uptimeMs: number }[] {
    const now = Date.now();
    return Array.from(this.processes.values()).map(p => ({
      name: p.name,
      uptimeMs: now - p.startedAt,
    }));
  }
}
