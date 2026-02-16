/**
 * Octybot — Home Agent
 *
 * On first run, registers with the worker and displays a pairing code.
 * After pairing, polls for pending messages, spawns `claude` CLI,
 * and streams response chunks back to the worker.
 *
 * Features:
 *   - Pre-warmed process pool: after a response completes, spawns the
 *     next `claude` process so it's loaded and waiting on stdin.
 *   - Pool management: LRU eviction, idle timeouts, stop requests.
 *   - Settings sync: picks up pool_max and idle_timeout from worker.
 *
 * Usage:
 *   bun run index.ts
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const WORKER_URL = "https://octybot-worker.tom-adf.workers.dev";
const POLL_INTERVAL = 1000;
const PAIR_POLL_INTERVAL = 2000;
const CONFIG_DIR = join(homedir(), ".octybot");
const CONFIG_FILE = join(CONFIG_DIR, "device.json");

interface DeviceConfig {
  device_id: string;
  token: string;
}

function loadConfig(): DeviceConfig | null {
  try {
    if (!existsSync(CONFIG_FILE)) return null;
    const data = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
    if (data.device_id && data.token) return data as DeviceConfig;
    return null;
  } catch {
    return null;
  }
}

function saveConfig(config: DeviceConfig) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

let currentToken = "";

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${currentToken}`,
    "Content-Type": "application/json",
  };
}

async function api(path: string, options?: RequestInit) {
  const resp = await fetch(`${WORKER_URL}${path}`, {
    ...options,
    headers: { ...authHeaders(), ...options?.headers },
  });

  // Handle token refresh
  const refreshToken = resp.headers.get("X-Refresh-Token");
  if (refreshToken) {
    currentToken = refreshToken;
    const config = loadConfig();
    if (config) {
      saveConfig({ ...config, token: refreshToken });
    }
    console.log("Token refreshed");
  }

  return resp;
}

// --- Registration + Pairing ---

async function registerAndPair(): Promise<DeviceConfig> {
  console.log("Registering device...\n");

  const resp = await fetch(`${WORKER_URL}/devices/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_name: "Home Agent" }),
  });

  if (!resp.ok) {
    throw new Error(`Registration failed: ${resp.status} ${await resp.text()}`);
  }

  const { device_id, code, expires_at } = (await resp.json()) as {
    device_id: string;
    code: string;
    expires_at: string;
  };

  console.log("┌─────────────────────────────────┐");
  console.log("│                                 │");
  console.log(`│     Pairing Code: ${code}     │`);
  console.log("│                                 │");
  console.log("│  Enter this code in the phone   │");
  console.log("│  app to pair this device.       │");
  console.log("│                                 │");
  console.log("└─────────────────────────────────┘\n");
  console.log(`Code expires at ${new Date(expires_at).toLocaleTimeString()}\n`);

  // Poll until paired
  while (true) {
    const statusResp = await fetch(`${WORKER_URL}/devices/${device_id}/status`);
    if (!statusResp.ok) {
      console.error("Status poll error:", statusResp.status);
      await Bun.sleep(PAIR_POLL_INTERVAL);
      continue;
    }

    const status = (await statusResp.json()) as {
      status: string;
      token?: string;
    };

    if (status.status === "paired" && status.token) {
      console.log("Paired successfully!\n");
      const config: DeviceConfig = {
        device_id,
        token: status.token,
      };
      saveConfig(config);
      return config;
    }

    await Bun.sleep(PAIR_POLL_INTERVAL);
  }
}

// --- Process Pool ---

interface ProcessEntry {
  proc: ReturnType<typeof Bun.spawn>;
  sessionId: string;
  model: string;
  conversationId: string;
  state: "spawning" | "warm" | "active";
  lastUsedAt: number;
  spawnedAt: number;
}

const processPool = new Map<string, ProcessEntry>();
let poolMax = 3;
let idleTimeoutMs = 24 * 3600 * 1000;

function buildClaudeArgs(sessionId: string | null, model: string): string[] {
  const args = [
    "--print",
    "--verbose",
    "--output-format",
    "stream-json",
    "--dangerously-skip-permissions",
    "--model",
    model || "opus",
    "--append-system-prompt",
    "You are a personal assistant accessed via a mobile app. Focus ONLY on the user's message. Ignore any internal system messages about pending tasks, session restores, or previous sessions — those are artifacts of the CLI and not relevant to this conversation.",
  ];

  if (sessionId) {
    args.push("--resume", sessionId);
  }

  return args;
}

async function reportProcessStatus(convId: string, status: string | null) {
  try {
    await api(`/conversations/${convId}/process`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    });
  } catch (err) {
    console.error(`  Failed to report process status for ${convId}:`, err);
  }
}

function spawnPreWarmedProcess(
  convId: string,
  sessionId: string,
  model: string
): ProcessEntry {
  // Evict LRU if pool is full
  evictLRU();

  const args = buildClaudeArgs(sessionId, model);
  const proc = Bun.spawn(["claude", ...args], {
    cwd: join(import.meta.dir, "../.."),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

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

  reportProcessStatus(convId, "warm");
  console.log(`  Pre-warmed process for ${convId} (session: ${sessionId.slice(0, 8)}...)`);

  return entry;
}

function evictLRU() {
  if (processPool.size < poolMax) return;

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
    killProcess(oldestKey);
  }
}

function killProcess(convId: string) {
  const entry = processPool.get(convId);
  if (!entry) return;

  try {
    entry.proc.kill();
  } catch {
    // Process may already be dead
  }
  processPool.delete(convId);
  reportProcessStatus(convId, null);
}

async function checkStopRequests() {
  try {
    const resp = await api("/conversations/process/stop-requests");
    if (!resp.ok) return;

    const data = (await resp.json()) as { conversation_ids: string[] };
    for (const convId of data.conversation_ids) {
      const entry = processPool.get(convId);
      if (entry && entry.state !== "active") {
        console.log(`  Stop requested for ${convId}`);
        killProcess(convId);
      } else if (entry?.state === "active") {
        console.log(`  Stop requested for ${convId} but process is active, skipping`);
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

function checkIdleTimeouts() {
  const now = Date.now();
  const toKill: string[] = [];
  for (const [convId, entry] of processPool) {
    if (entry.state === "active") continue;
    if (now - entry.spawnedAt > idleTimeoutMs) {
      toKill.push(convId);
    }
  }
  for (const convId of toKill) {
    console.log(`  Idle timeout for ${convId}`);
    killProcess(convId);
  }
}

async function clearAllProcessStatus() {
  try {
    await api("/conversations/process/clear-all", { method: "POST" });
    console.log("Cleared stale process statuses");
  } catch (err) {
    console.error("Failed to clear process statuses:", err);
  }
}

async function fetchSettings() {
  try {
    const resp = await api("/settings");
    if (!resp.ok) return;

    const data = (await resp.json()) as { settings: Record<string, string> };
    const timeout = Number(data.settings.process_idle_timeout_hours);
    const max = Number(data.settings.process_pool_max);

    if (timeout > 0) idleTimeoutMs = timeout * 3600 * 1000;
    if (max > 0) poolMax = max;
  } catch {
    // Non-critical, keep defaults
  }
}

// --- Message Processing ---

interface PendingMessage {
  message_id: string;
  conversation_id: string;
  user_content: string;
  claude_session_id: string | null;
  model: string;
}

async function pollForWork(): Promise<PendingMessage | null> {
  const resp = await api("/messages/pending");
  if (resp.status === 204) return null;
  if (!resp.ok) {
    console.error("Poll error:", resp.status, await resp.text());
    return null;
  }
  return resp.json() as Promise<PendingMessage>;
}

async function postChunk(
  messageId: string,
  sequence: number,
  text: string,
  isFinal: boolean,
  type: string = "text"
) {
  await api(`/messages/${messageId}/chunks`, {
    method: "POST",
    body: JSON.stringify({ sequence, text, type, is_final: isFinal }),
  });
}

async function postSession(messageId: string, sessionId: string) {
  await api(`/messages/${messageId}/session`, {
    method: "POST",
    body: JSON.stringify({ session_id: sessionId }),
  });
}

async function postError(messageId: string, error: string) {
  await api(`/messages/${messageId}/error`, {
    method: "POST",
    body: JSON.stringify({ error }),
  });
}

async function processMessage(pending: PendingMessage) {
  console.log(
    `Processing message ${pending.message_id}: "${pending.user_content.slice(0, 80)}..."`
  );

  let proc: ReturnType<typeof Bun.spawn>;
  let usedWarm = false;

  let sequence = 0;
  let fullText = "";
  let sessionCaptured = !!pending.claude_session_id;
  let capturedSessionId = pending.claude_session_id || "";
  let finalChunkSent = false;

  // Track current content block for structured streaming
  let currentBlockType: string | null = null;
  let currentToolName = "";
  let toolInputParts: string[] = [];
  let sawDelta = false;

  try {
    const poolEntry = processPool.get(pending.conversation_id);

    if (poolEntry && poolEntry.state === "warm") {
      // Check model matches
      if (poolEntry.model === (pending.model || "opus")) {
        // Use the pre-warmed process
        proc = poolEntry.proc;
        poolEntry.state = "active";
        poolEntry.lastUsedAt = Date.now();
        usedWarm = true;
        reportProcessStatus(pending.conversation_id, "active");
        console.log("  Using pre-warmed process");
      } else {
        // Model mismatch — kill and cold-start
        console.log("  Model mismatch, killing pre-warmed process");
        killProcess(pending.conversation_id);
        proc = spawnColdProcess(pending);
      }
    } else {
      // No warm process — cold start
      if (poolEntry) {
        // Entry exists but in wrong state, clean up
        killProcess(pending.conversation_id);
      }
      proc = spawnColdProcess(pending);
    }

    // Mark as active in pool
    if (!usedWarm) {
      const entry: ProcessEntry = {
        proc,
        sessionId: pending.claude_session_id || "",
        model: pending.model || "opus",
        conversationId: pending.conversation_id,
        state: "active",
        lastUsedAt: Date.now(),
        spawnedAt: Date.now(),
      };
      processPool.set(pending.conversation_id, entry);
      reportProcessStatus(pending.conversation_id, "active");
    }

    // Write prompt and close stdin
    proc.stdin.write(pending.user_content);
    proc.stdin.end();
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;

        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }

        // Capture session ID from init event
        if (event.type === "system" && event.subtype === "init" && !sessionCaptured) {
          const sessionId = event.session_id as string | undefined;
          if (sessionId) {
            await postSession(pending.message_id, sessionId);
            sessionCaptured = true;
            capturedSessionId = sessionId;
            console.log(`  Session: ${sessionId}`);
          }
        }

        // content_block_start — begin a new block
        if (event.type === "content_block_start") {
          const block = event.content_block as Record<string, unknown> | undefined;
          currentBlockType = block?.type as string ?? "text";
          if (currentBlockType === "tool_use") {
            currentToolName = (block?.name as string) ?? "unknown";
            toolInputParts = [];
            await postChunk(pending.message_id, sequence++, currentToolName, false, "tool_use");
          }
        }

        // content_block_delta — streaming content
        if (event.type === "content_block_delta") {
          sawDelta = true;
          const delta = event.delta as Record<string, unknown> | undefined;

          if (delta?.text) {
            const text = delta.text as string;
            fullText += text;
            await postChunk(pending.message_id, sequence++, text, false, "text");
          }

          if (delta?.partial_json && currentBlockType === "tool_use") {
            toolInputParts.push(delta.partial_json as string);
          }
        }

        // content_block_stop — finalize the block
        if (event.type === "content_block_stop") {
          if (currentBlockType === "tool_use" && toolInputParts.length > 0) {
            let inputStr: string;
            try {
              const parsed = JSON.parse(toolInputParts.join(""));
              inputStr = JSON.stringify(parsed, null, 2);
            } catch {
              inputStr = toolInputParts.join("");
            }
            await postChunk(pending.message_id, sequence++, inputStr, false, "tool_input");
          }
          currentBlockType = null;
          currentToolName = "";
          toolInputParts = [];
        }

        // assistant event — full message (when no content_block deltas)
        if (event.type === "assistant" && !sawDelta) {
          // Check for message.content array (verbose format)
          const message = event.message as Record<string, unknown> | undefined;
          const content = message?.content as Array<Record<string, unknown>> | undefined;
          if (content) {
            for (const block of content) {
              if (block.type === "text" && block.text) {
                const text = block.text as string;
                fullText += text;
                await postChunk(pending.message_id, sequence++, text, false, "text");
              } else if (block.type === "tool_use" && block.name) {
                await postChunk(pending.message_id, sequence++, block.name as string, false, "tool_use");
                if (block.input) {
                  const inputStr = JSON.stringify(block.input, null, 2);
                  await postChunk(pending.message_id, sequence++, inputStr, false, "tool_input");
                }
              }
            }
          }
          // Fallback: subtype chunk (non-verbose)
          if (event.subtype === "chunk") {
            const text = event.content as string | undefined;
            if (text) {
              fullText += text;
              await postChunk(pending.message_id, sequence++, text, false, "text");
            }
          }
        }

        // Tool result
        if (event.type === "tool_result") {
          const output = event.content as string | undefined;
          const isError = event.is_error as boolean | undefined;
          if (output) {
            const truncated = output.length > 500 ? output.slice(0, 500) + "..." : output;
            await postChunk(
              pending.message_id, sequence++, truncated, false,
              isError ? "tool_error" : "tool_result"
            );
          }
        }

        // Result event — final message
        if (event.type === "result") {
          const result = event.result as string | undefined;
          const shouldEmitResultChunk = !!result && !fullText;

          if (shouldEmitResultChunk && result) {
            fullText = result;
            await postChunk(pending.message_id, sequence++, result, true, "text");
          } else {
            await postChunk(pending.message_id, sequence++, "", true, "text");
          }
          finalChunkSent = true;
          console.log(`  Done (${sequence} chunks)`);
        }
      }
    }

    // Wait for process to exit
    const exitCode = await proc.exited;

    if (!finalChunkSent && fullText) {
      await postChunk(pending.message_id, sequence++, "", true, "text");
      finalChunkSent = true;
    }

    if (!fullText) {
      const stderrReader = proc.stderr.getReader();
      const { value: errBytes } = await stderrReader.read();
      const stderrText = errBytes ? new TextDecoder().decode(errBytes) : "";
      await postError(
        pending.message_id,
        stderrText || `Claude exited with code ${exitCode}`
      );
      console.error(`  Error: exit code ${exitCode}`);
    }

    // Clean up pool entry for this active process
    processPool.delete(pending.conversation_id);

    // Pre-warm next process if we have a session ID
    const sessionToWarm = capturedSessionId;
    if (sessionToWarm) {
      try {
        spawnPreWarmedProcess(
          pending.conversation_id,
          sessionToWarm,
          pending.model || "opus"
        );
      } catch (err) {
        console.error("  Failed to pre-warm:", err);
        reportProcessStatus(pending.conversation_id, null);
      }
    } else {
      reportProcessStatus(pending.conversation_id, null);
    }
  } catch (err) {
    console.error("  Process error:", err);
    await postError(
      pending.message_id,
      err instanceof Error ? err.message : String(err)
    );
    // Clean up
    processPool.delete(pending.conversation_id);
    reportProcessStatus(pending.conversation_id, null);
    try { proc!.kill(); } catch {}
  }
}

function spawnColdProcess(pending: PendingMessage): ReturnType<typeof Bun.spawn> {
  const args = buildClaudeArgs(pending.claude_session_id, pending.model || "opus");
  return Bun.spawn(["claude", ...args], {
    cwd: join(import.meta.dir, "../.."),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
}

// --- Main ---

async function main() {
  let config = loadConfig();

  if (config) {
    currentToken = config.token;
    console.log("Loaded saved device credentials");
    console.log(`Device: ${config.device_id}\n`);
  } else {
    config = await registerAndPair();
    currentToken = config.token;
  }

  console.log(`Octybot Agent started`);
  console.log(`Worker: ${WORKER_URL}`);
  console.log(`Polling every ${POLL_INTERVAL}ms...\n`);

  // Startup: clear stale process statuses and fetch settings
  await clearAllProcessStatus();
  await fetchSettings();
  console.log(`Pool config: max=${poolMax}, idle_timeout=${idleTimeoutMs / 3600000}h\n`);

  let tickCount = 0;

  while (true) {
    try {
      const pending = await pollForWork();
      if (pending) {
        await processMessage(pending);
      }
    } catch (err) {
      console.error("Poll loop error:", err);
    }

    tickCount++;

    // Every 10 ticks (10s): check stop requests
    if (tickCount % 10 === 0) {
      checkStopRequests().catch(() => {});
    }

    // Every 60 ticks (60s): check idle timeouts + refresh settings
    if (tickCount % 60 === 0) {
      checkIdleTimeouts();
      fetchSettings().catch(() => {});
    }

    await Bun.sleep(POLL_INTERVAL);
  }
}

main();
