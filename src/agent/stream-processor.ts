/**
 * Stream processor — processMessage(), pollForWork(), chunk/session/error posting.
 * Depends on: config.ts, api-client.ts, process-pool.ts
 */

import { DEFAULT_MODEL } from "./config";
import { api } from "./api-client";
import {
  type ProcessEntry,
  processPool,
  activeStopRequests,
  spawnClaude,
  reportProcessStatus,
  killProcess,
  spawnPreWarmedProcess,
} from "./process-pool";
import type { PendingMessage } from "../shared/api-types";

// --- API helpers ---

export async function pollForWork(): Promise<PendingMessage | null> {
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

// --- Cold process spawning ---

function spawnColdProcess(pending: PendingMessage): ReturnType<typeof Bun.spawn> {
  return spawnClaude(pending.claude_session_id, pending.model || DEFAULT_MODEL);
}

// --- Main message processing ---

export async function processMessage(pending: PendingMessage) {
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
  let stoppedByRequest = false;

  // Track current content block for structured streaming
  let currentBlockType: string | null = null;
  let currentToolName = "";
  let toolInputParts: string[] = [];
  let sawDelta = false;

  try {
    const poolEntry = processPool.get(pending.conversation_id);

    if (poolEntry && poolEntry.state === "warm") {
      // Check model matches
      if (poolEntry.model === (pending.model || DEFAULT_MODEL)) {
        // Use the pre-warmed process
        proc = poolEntry.proc;
        poolEntry.state = "active";
        poolEntry.lastUsedAt = Date.now();
        usedWarm = true;
        await reportProcessStatus(pending.conversation_id, "active");
        console.log("  Using pre-warmed process");
      } else {
        // Model mismatch — kill and cold-start
        console.log("  Model mismatch, killing pre-warmed process");
        await killProcess(pending.conversation_id);
        proc = spawnColdProcess(pending);
      }
    } else {
      // No warm process — cold start
      if (poolEntry) {
        // Entry exists but in wrong state, clean up
        await killProcess(pending.conversation_id);
      }
      proc = spawnColdProcess(pending);
    }

    // Mark as active in pool
    if (!usedWarm) {
      const entry: ProcessEntry = {
        proc,
        sessionId: pending.claude_session_id || "",
        model: pending.model || DEFAULT_MODEL,
        conversationId: pending.conversation_id,
        state: "active",
        lastUsedAt: Date.now(),
        spawnedAt: Date.now(),
      };
      processPool.set(pending.conversation_id, entry);
      await reportProcessStatus(pending.conversation_id, "active");
    }

    // Write prompt and close stdin
    try {
      proc.stdin.write(pending.user_content);
      proc.stdin.end();
    } catch (err) {
      throw new Error(`Failed to write to process stdin: ${err}`);
    }
    // Start concurrent stderr drain so it doesn't block stdout
    const stderrChunks: string[] = [];
    const stderrPromise = (async () => {
      const stderrReader = proc.stderr.getReader();
      const stderrDecoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await stderrReader.read();
          if (done) break;
          stderrChunks.push(stderrDecoder.decode(value, { stream: true }));
        }
      } catch {
        // stderr closed
      }
    })();

    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // Honor stop requests for active processes
      if (activeStopRequests.has(pending.conversation_id)) {
        activeStopRequests.delete(pending.conversation_id);
        stoppedByRequest = true;
        console.log("  Stop request honored, aborting");
        break;
      }

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
          currentBlockType = (block?.type as string) ?? "text";
          if (currentBlockType === "tool_use") {
            currentToolName = (block?.name as string) ?? "unknown";
            toolInputParts = [];
            await postChunk(
              pending.message_id,
              sequence++,
              currentToolName,
              false,
              "tool_use"
            );
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
            await postChunk(
              pending.message_id,
              sequence++,
              inputStr,
              false,
              "tool_input"
            );
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
                await postChunk(
                  pending.message_id,
                  sequence++,
                  block.name as string,
                  false,
                  "tool_use"
                );
                if (block.input) {
                  const inputStr = JSON.stringify(block.input, null, 2);
                  await postChunk(
                    pending.message_id,
                    sequence++,
                    inputStr,
                    false,
                    "tool_input"
                  );
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
            const truncated =
              output.length > 500 ? output.slice(0, 500) + "..." : output;
            await postChunk(
              pending.message_id,
              sequence++,
              truncated,
              false,
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

    // Kill process if we broke out early (stop request)
    if (stoppedByRequest) {
      try {
        proc.kill();
      } catch {}
    }

    // Wait for process to exit
    const exitCode = await proc.exited;

    if (!finalChunkSent) {
      await postChunk(pending.message_id, sequence++, "", true, "text");
      finalChunkSent = true;
    }

    if (!fullText && !stoppedByRequest) {
      await stderrPromise;
      const stderrText = stderrChunks.join("");
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
        await spawnPreWarmedProcess(
          pending.conversation_id,
          sessionToWarm,
          pending.model || DEFAULT_MODEL
        );
      } catch (err) {
        console.error("  Failed to pre-warm:", err);
        await reportProcessStatus(pending.conversation_id, null);
      }
    } else {
      await reportProcessStatus(pending.conversation_id, null);
    }
  } catch (err) {
    console.error("  Process error:", err);
    await postError(
      pending.message_id,
      err instanceof Error ? err.message : String(err)
    );
    // Clean up
    processPool.delete(pending.conversation_id);
    await reportProcessStatus(pending.conversation_id, null);
    // @ts-ignore — proc may be uninitialized if spawn failed
    if (proc) try { proc.kill(); } catch {}
  }
}
