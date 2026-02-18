/**
 * Process pool — spawn, evict, kill, stop-check, idle-check for Claude CLI processes.
 * Depends on: config.ts, api-client.ts
 */

import { DEFAULT_MODEL, SYSTEM_PROMPT, getProjectDir } from "./config";
import { api } from "./api-client";
import type { StopRequestsResponse } from "../shared/api-types";

// --- Types ---

export interface ProcessEntry {
  proc: ReturnType<typeof Bun.spawn>;
  sessionId: string;
  model: string;
  conversationId: string;
  state: "spawning" | "warm" | "active";
  lastUsedAt: number;
  spawnedAt: number;
}

// --- Mutable pool state ---

export const processPool = new Map<string, ProcessEntry>();
export const activeStopRequests = new Set<string>();

let poolMax = 3;
let idleTimeoutMs = 24 * 3600 * 1000;

export function getPoolMax(): number {
  return poolMax;
}

export function setPoolMax(value: number) {
  poolMax = value;
}

export function getIdleTimeoutMs(): number {
  return idleTimeoutMs;
}

export function setIdleTimeoutMs(value: number) {
  idleTimeoutMs = value;
}

// --- Claude CLI spawning ---

function buildClaudeArgs(sessionId: string | null, model: string): string[] {
  const args = [
    "--print",
    "--verbose",
    "--output-format",
    "stream-json",
    "--dangerously-skip-permissions",
    "--model",
    model || DEFAULT_MODEL,
    "--append-system-prompt",
    SYSTEM_PROMPT,
  ];

  if (sessionId) {
    args.push("--resume", sessionId);
  }

  return args;
}

export function spawnClaude(sessionId: string | null, model: string, project?: string) {
  const args = buildClaudeArgs(sessionId, model);
  return Bun.spawn(["claude", ...args], {
    cwd: getProjectDir(project),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
}

// --- Process status reporting ---

export async function reportProcessStatus(convId: string, status: string | null) {
  try {
    await api(`/conversations/${convId}/process`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    });
  } catch (err) {
    console.error(`  Failed to report process status for ${convId}:`, err);
  }
}

// --- Pool management ---

export async function killProcess(convId: string) {
  const entry = processPool.get(convId);
  if (!entry) return;

  try {
    entry.proc.kill();
  } catch {
    // Process may already be dead
  }
  processPool.delete(convId);
  await reportProcessStatus(convId, null);
}

async function evictLRU() {
  while (processPool.size >= poolMax) {
    let oldest: ProcessEntry | null = null;
    let oldestKey = "";

    for (const [key, entry] of processPool) {
      if (entry.state === "active") continue;
      if (!oldest || entry.lastUsedAt < oldest.lastUsedAt) {
        oldest = entry;
        oldestKey = key;
      }
    }

    if (oldest) {
      console.log(`  Evicting LRU process for ${oldestKey}`);
      await killProcess(oldestKey);
    } else {
      break; // all remaining are active, can't evict
    }
  }
}

export async function spawnPreWarmedProcess(
  convId: string,
  sessionId: string,
  model: string
): Promise<ProcessEntry> {
  // Evict LRU if pool is full
  await evictLRU();

  const proc = spawnClaude(sessionId, model);

  const entry: ProcessEntry = {
    proc,
    sessionId,
    model,
    conversationId: convId,
    state: "warm",
    lastUsedAt: Date.now(),
    spawnedAt: Date.now(),
  };

  processPool.set(convId, entry);

  // Handle unexpected process exit (crash)
  proc.exited.then((code) => {
    const current = processPool.get(convId);
    if (current && current.proc === proc && current.state !== "active") {
      console.log(`  Pre-warmed process for ${convId} exited (code ${code})`);
      processPool.delete(convId);
      reportProcessStatus(convId, null);
    }
  });

  await reportProcessStatus(convId, "warm");
  console.log(`  Pre-warmed process for ${convId} (session: ${sessionId.slice(0, 8)}...)`);

  return entry;
}

// --- Maintenance checks ---

export async function checkStopRequests() {
  try {
    const resp = await api("/conversations/process/stop-requests");
    if (!resp.ok) return;

    const data = (await resp.json()) as StopRequestsResponse;
    for (const convId of data.conversation_ids) {
      const entry = processPool.get(convId);
      if (entry && entry.state !== "active") {
        console.log(`  Stop requested for ${convId}`);
        await killProcess(convId);
      } else if (entry?.state === "active") {
        console.log(`  Stop requested for ${convId} (active, will honor in stream)`);
        activeStopRequests.add(convId);
      }
      // Clear the flag even if we don't have the process or it's active
      await api(`/conversations/${convId}/process`, {
        method: "PATCH",
        body: JSON.stringify({ status: entry?.state === "active" ? "active" : null }),
      });
    }
  } catch (err) {
    console.error("  Stop request check failed:", err);
  }
}

export async function checkIdleTimeouts() {
  const now = Date.now();
  const toKill: string[] = [];
  for (const [convId, entry] of processPool) {
    if (entry.state === "active") continue;
    if (now - entry.lastUsedAt > idleTimeoutMs) {
      toKill.push(convId);
    }
  }
  for (const convId of toKill) {
    console.log(`  Idle timeout for ${convId}`);
    await killProcess(convId);
  }
}

export async function clearAllProcessStatus() {
  try {
    await api("/conversations/process/clear-all", { method: "POST" });
    console.log("Cleared stale process statuses");
  } catch (err) {
    console.error("Failed to clear process statuses:", err);
  }
}
