/**
 * Agent runtime — spawns and manages Claude Code processes per agent.
 *
 * Each agent runs in its own project directory with its own hooks.
 * The runtime tracks spawned processes and can reap idle ones.
 */

import { join } from "path";
import { existsSync } from "fs";

export interface AgentProcess {
  name: string;
  proc: ReturnType<typeof Bun.spawn>;
  startedAt: number;
  lastActiveAt: number;
}

export interface RuntimeConfig {
  projectDir: string;
  idleTimeoutMs?: number;  // Kill idle agents after this (default: 5 min)
}

export class AgentRuntime {
  private processes = new Map<string, AgentProcess>();
  private config: RuntimeConfig;

  constructor(config: RuntimeConfig) {
    this.config = config;
  }

  /**
   * Run a command as a specific agent, passing input via stdin.
   * Returns the stdout output.
   */
  async run(agentName: string, input: string, timeoutMs = 60000): Promise<string> {
    const agentDir = join(this.config.projectDir, "agents", agentName);
    if (!existsSync(agentDir)) {
      throw new Error(`Agent directory not found: ${agentDir}`);
    }

    const proc = Bun.spawn(["claude", "--print", "-"], {
      cwd: agentDir,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        OCTYBOT_AGENT: agentName,
      },
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
