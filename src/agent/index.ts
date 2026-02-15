/**
 * Octybot — Home Agent
 *
 * On first run, registers with the worker and displays a pairing code.
 * After pairing, polls for pending messages, spawns `claude` CLI,
 * and streams response chunks back to the worker.
 *
 * Usage:
 *   bun run index.ts
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import {
  backupMemoryStore,
  clearMemoryStore,
  commitMemoryExchange,
  forgetMemoryBySalience,
  freezeMemorySnapshot,
  getMemoryPluginStatus,
  listMemorySnapshots,
  loadMemoryConfig,
  preparePromptWithMemory,
  restoreMemorySnapshot,
  saveMemoryConfig,
} from "./plugins/memory";

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

function parseToggleValue(value: string | undefined): boolean | null {
  if (!value) return null;
  const normalized = value.toLowerCase();
  if (["on", "true", "1", "enable", "enabled"].includes(normalized)) return true;
  if (["off", "false", "0", "disable", "disabled"].includes(normalized)) return false;
  return null;
}

function memoryCommandHelp(): string {
  return [
    "Memory command usage:",
    "/octybot memory status",
    "/octybot memory on|off",
    "/octybot memory dev on|off",
    "/octybot memory forget <query>",
    "/octybot memory backup",
    "/octybot memory freeze <snapshot-name>",
    "/octybot memory restore <snapshot-name>",
    "/octybot memory list",
    "/octybot memory clear --confirm",
  ].join("\n");
}

function handleMemoryCommand(userContent: string): string | null {
  const input = userContent.trim();
  if (!input.toLowerCase().startsWith("/octybot")) {
    return null;
  }

  const rest = input.slice("/octybot".length).trim();
  if (!rest) {
    return "Usage: /octybot memory <subcommand>";
  }

  const [groupRaw, ...groupArgs] = rest.split(/\s+/).filter(Boolean);
  const group = (groupRaw || "").toLowerCase();
  if (group !== "memory") {
    return `Unknown /octybot command: ${group || "(empty)"}\n\nUsage: /octybot memory <subcommand>`;
  }

  const memoryRest = rest.slice(groupRaw.length).trim();
  if (!memoryRest) {
    return memoryCommandHelp();
  }

  const [subRaw, ...argTokens] = memoryRest.split(/\s+/).filter(Boolean);
  const subcommand = (subRaw || "help").toLowerCase();
  const remainder = memoryRest.slice(subRaw?.length ?? 0).trim();

  try {
    if (subcommand === "help") {
      return memoryCommandHelp();
    }

    if (subcommand === "status") {
      const status = getMemoryPluginStatus();
      return [
        `memory_enabled: ${status.config.enabled}`,
        `dev_mode: ${status.config.dev_mode}`,
        `entries: ${status.total_entries}`,
        `max_entries: ${status.config.max_entries}`,
        `retrieve_top_k: ${status.config.retrieve_top_k}`,
        `max_context_chars: ${status.config.max_context_chars}`,
        `forget_decay: ${status.config.forget_decay}`,
        `min_salience: ${status.config.min_salience}`,
        `correction_boost: ${status.config.correction_boost}`,
        `config_file: ${status.config_file}`,
        `memory_file: ${status.memory_file}`,
        `snapshot_dir: ${status.snapshot_dir}`,
      ].join("\n");
    }

    if (subcommand === "on" || subcommand === "off") {
      const enabled = subcommand === "on";
      const config = saveMemoryConfig({ enabled });
      return `memory_enabled: ${config.enabled}`;
    }

    if (subcommand === "dev") {
      const toggle = parseToggleValue(argTokens[0]);
      if (toggle === null) {
        return "Usage: /octybot memory dev on|off";
      }
      const config = saveMemoryConfig({ dev_mode: toggle });
      return `dev_mode: ${config.dev_mode}`;
    }

    if (subcommand === "forget") {
      if (!remainder) {
        return "Usage: /octybot memory forget <query>";
      }
      const config = loadMemoryConfig();
      const result = forgetMemoryBySalience(remainder, config);
      return [
        "soft_forget: applied",
        `query: ${result.query}`,
        `matched: ${result.matched}`,
        `downgraded: ${result.downgraded}`,
        `total_entries: ${result.total_entries}`,
        `decay_factor: ${result.decay_factor}`,
        `min_salience: ${result.min_salience}`,
      ].join("\n");
    }

    if (subcommand === "freeze") {
      if (!remainder) {
        return "Usage: /octybot memory freeze <snapshot-name>";
      }
      const snapshot = freezeMemorySnapshot(remainder);
      return [
        `snapshot_saved: ${snapshot.name}`,
        `created_at: ${snapshot.created_at}`,
        `entries: ${snapshot.entries}`,
        `file: ${snapshot.file}`,
      ].join("\n");
    }

    if (subcommand === "restore") {
      if (!remainder) {
        return "Usage: /octybot memory restore <snapshot-name>";
      }
      const snapshot = restoreMemorySnapshot(remainder);
      return [
        `snapshot_restored: ${snapshot.name}`,
        `created_at: ${snapshot.created_at}`,
        `entries: ${snapshot.entries}`,
        `file: ${snapshot.file}`,
      ].join("\n");
    }

    if (subcommand === "list") {
      const snapshots = listMemorySnapshots();
      if (snapshots.length === 0) {
        return "No memory snapshots found.";
      }

      return [
        `snapshots: ${snapshots.length}`,
        ...snapshots.map(
          (item, index) =>
            `${index + 1}. ${item.name} | entries=${item.entries} | created_at=${item.created_at} | bytes=${item.bytes}`
        ),
      ].join("\n");
    }

    if (subcommand === "backup") {
      const snapshot = backupMemoryStore();
      return [
        `backup_created: ${snapshot.name}`,
        `entries: ${snapshot.entries}`,
        `file: ${snapshot.file}`,
      ].join("\n");
    }

    if (subcommand === "clear") {
      if (!argTokens.includes("--confirm")) {
        const status = getMemoryPluginStatus();
        return [
          `WARNING: This will permanently delete all ${status.total_entries} memory entries.`,
          ``,
          `To confirm, run: /octybot memory clear --confirm`,
          ``,
          `A backup snapshot will be created automatically before clearing.`,
          `To create a manual backup first: /octybot memory backup`,
        ].join("\n");
      }
      const result = clearMemoryStore();
      const lines = [
        `Memory store cleared. ${result.entries_removed} entries removed.`,
      ];
      if (result.backup_snapshot) {
        lines.push(`Auto-backup saved as: ${result.backup_snapshot}`);
        lines.push(`Restore with: /octybot memory restore ${result.backup_snapshot}`);
      }
      return lines.join("\n");
    }

    return `Unknown subcommand: ${subcommand}\n\n${memoryCommandHelp()}`;
  } catch (err) {
    return `Memory command failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function processMessage(pending: PendingMessage) {
  console.log(
    `Processing message ${pending.message_id}: "${pending.user_content.slice(0, 80)}..."`
  );

  const memoryCommandResponse = handleMemoryCommand(pending.user_content);
  if (memoryCommandResponse !== null) {
    await postChunk(pending.message_id, 0, memoryCommandResponse, true, "text");
    console.log("  Handled /octybot memory command locally");
    return;
  }

  const memoryConfig = loadMemoryConfig();
  const memoryPrompt = preparePromptWithMemory(pending.user_content, memoryConfig);

  const args = [
    "--print",
    "--verbose",
    "--output-format",
    "stream-json",
    "--dangerously-skip-permissions",
    "--model",
    pending.model || "opus",
  ];

  if (pending.claude_session_id) {
    args.push("--resume", pending.claude_session_id);
  }

  const proc = Bun.spawn(["claude", ...args], {
    cwd: join(import.meta.dir, "../.."),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  // Write prompt via stdin (matches falcon-ai pattern)
  proc.stdin.write(memoryPrompt.prompt);
  proc.stdin.end();

  let sequence = 0;
  let fullText = "";
  let sessionCaptured = !!pending.claude_session_id;
  let finalChunkSent = false;
  let memoryCommitted = false;

  // Track current content block for structured streaming
  let currentBlockType: string | null = null;
  let currentToolName = "";
  let toolInputParts: string[] = [];
  let sawDelta = false;

  try {
    if (memoryPrompt.trace && memoryConfig.dev_mode) {
      await postChunk(pending.message_id, sequence++, memoryPrompt.trace.l1, false, "tool_result");
      await postChunk(pending.message_id, sequence++, memoryPrompt.trace.l15, false, "tool_result");
      await postChunk(pending.message_id, sequence++, memoryPrompt.trace.l2, false, "tool_result");
    }

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
          }

          if (!memoryCommitted && fullText) {
            const commitResult = commitMemoryExchange(
              pending.user_content,
              fullText,
              memoryConfig
            );
            memoryCommitted = true;

            if (memoryConfig.dev_mode) {
              const commitSummary = [
                "Memory commit I/O:",
                `saved: ${commitResult.saved}`,
                `reason: ${commitResult.reason}`,
                `total_entries: ${commitResult.total_entries}`,
                `downgraded_count: ${commitResult.downgraded_count ?? 0}`,
              ].join("\n");
              await postChunk(pending.message_id, sequence++, commitSummary, false, "tool_result");
            }
          }

          if (shouldEmitResultChunk && result) {
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

    if (!memoryCommitted && fullText) {
      const commitResult = commitMemoryExchange(
        pending.user_content,
        fullText,
        memoryConfig
      );
      memoryCommitted = true;
      if (memoryConfig.dev_mode && !finalChunkSent) {
        const commitSummary = [
          "Memory commit I/O:",
          `saved: ${commitResult.saved}`,
          `reason: ${commitResult.reason}`,
          `total_entries: ${commitResult.total_entries}`,
          `downgraded_count: ${commitResult.downgraded_count ?? 0}`,
        ].join("\n");
        await postChunk(pending.message_id, sequence++, commitSummary, false, "tool_result");
      }
    }

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
  } catch (err) {
    console.error("  Process error:", err);
    await postError(
      pending.message_id,
      err instanceof Error ? err.message : String(err)
    );
    proc.kill();
  }
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

  while (true) {
    try {
      const pending = await pollForWork();
      if (pending) {
        await processMessage(pending);
      }
    } catch (err) {
      console.error("Poll loop error:", err);
    }
    await Bun.sleep(POLL_INTERVAL);
  }
}

main();
