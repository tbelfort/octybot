/**
 * UserPromptSubmit hook entry point.
 * Reads JSON from stdin, runs the memory pipeline, outputs JSON to stdout.
 *
 * Two paths:
 *   PATH 1 (full pipeline): No recent conversation state -> L1 -> L1.5 -> L2 -> curation
 *   PATH 2 (follow-up):     Recent state exists -> single LLM call for delta queries + storage
 */
import { MemoryEngine } from "../engine";
import { classify } from "../layer1";
import { readConversationState, writeConversationState } from "../state";
import { createTrace, isDevMode, getDevModeFile } from "../debug";
import { DB_PATH, DEBUG_DIR, CONVERSATION_STATE_PATH, validateConfig } from "../config";
import { reportCosts } from "../costs";
import { appendFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { ConversationTurn } from "../types";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function respond(additionalContext: string) {
  const output = {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext,
    },
  };
  console.log(JSON.stringify(output));
}

/**
 * Build a brief context summary from retrieve results for future pronoun resolution.
 */
function buildContextSummary(context: string): string | undefined {
  if (!context) return undefined;
  const cleaned = context
    .split("\n")
    .filter(line => line.trim().length > 0)
    .map(line => {
      return line
        .replace(/\s*\(id:\s*[^)]+\)/g, "")
        .replace(/\s*\[score:\s*[\d.]+\]/g, "")
        .replace(/\s*salience:\s*[\d.]+/g, "")
        .trim();
    })
    .filter(line => line.length > 10)
    .slice(0, 3)
    .join("; ");
  return cleaned.slice(0, 400) || undefined;
}

async function main() {
  if (existsSync(join(homedir(), ".octybot", "memory-disabled"))) {
    process.exit(0);
  }

  // Fail fast on missing config
  const configErrors = validateConfig();
  if (configErrors.length) {
    process.stderr.write(`[on-prompt] Config validation failed:\n${configErrors.map(e => `  - ${e}`).join("\n")}\n`);
    process.exit(0);
  }

  const engine = new MemoryEngine({ dbPath: DB_PATH, statePath: CONVERSATION_STATE_PATH });
  const startMs = Date.now();
  const logFile = join(DEBUG_DIR, "hook-debug.log");
  const log = (msg: string) => {
    const line = `[on-prompt ${Date.now() - startMs}ms] ${new Date().toISOString()} ${msg}\n`;
    process.stderr.write(line);
    try { appendFileSync(logFile, line); } catch {}
  };

  log("hook started");
  const raw = await readStdin();
  log(`stdin: ${raw.length} bytes`);
  let input: { prompt?: string; [key: string]: unknown };

  try {
    input = JSON.parse(raw);
  } catch {
    log("JSON parse failed, exiting");
    engine.close();
    process.exit(0);
  }

  const prompt = input.prompt;
  log(`prompt field: ${prompt ? `"${prompt.slice(0, 80)}"` : "MISSING"}`);
  log(`stdin keys: ${Object.keys(input).join(", ")}`);
  if (!prompt || typeof prompt !== "string") {
    log("no prompt, exiting");
    engine.close();
    process.exit(0);
  }

  if (prompt.trim().toLowerCase().startsWith("/octybot")) {
    engine.close();
    process.exit(0);
  }

  const sessionId = (input.session_id as string) || (input.sessionId as string) || undefined;
  const devMode = isDevMode();
  const trace = createTrace(prompt);

  // ── Conversation state + new-conversation detection ──
  const rawState = readConversationState(CONVERSATION_STATE_PATH);
  let previousTurns = rawState?.turns ?? [];

  if (rawState && previousTurns.length > 0) {
    const canCompareSessionIds = sessionId && rawState.sessionId;
    if (canCompareSessionIds && sessionId !== rawState.sessionId) {
      log(`new session (${sessionId?.slice(0, 8)} vs ${rawState.sessionId?.slice(0, 8)}), resetting state`);
      previousTurns = [];
    }
  }

  const hasRecentState = previousTurns.length > 0;

  if (hasRecentState) {
    // ── PATH 2: Conversation-aware follow-up pipeline ──
    log(`follow-up path: ${previousTurns.length} previous turns`);

    const result = await engine.followUp(prompt, previousTurns);

    if (result) {
      log(`follow-up complete: ${result.context.length} chars context`);
      trace.finish(result.context);

      const newTurn: ConversationTurn = {
        prompt,
        entities: [],
        contextSummary: buildContextSummary(result.context),
        timestamp: Date.now(),
      };
      writeConversationState(CONVERSATION_STATE_PATH, [...previousTurns, newTurn], sessionId);

      let additionalContext = "";
      if (result.context) {
        additionalContext += `<memory>\n${result.context}\n</memory>`;
      }

      if (devMode) {
        const devFile = getDevModeFile();
        if (devFile) appendFileSync(devFile, trace.format() + "\n");
      }

      await reportCosts().catch(() => {});
      engine.close();

      if (!additionalContext) {
        process.exit(0);
      }

      respond(additionalContext);
      return;
    }

    log("follow-up pipeline returned null, falling back to full pipeline");
  }

  // ── PATH 1: Full pipeline ──
  log(hasRecentState ? "full pipeline (follow-up fallback)" : "full pipeline (no recent state)");

  const l1c = await classify(prompt);
  const l1 = l1c.result;
  trace.addLayer1(l1);
  trace.addLayer1Raw(l1c.raw);

  const hasContent =
    l1.entities.length > 0 ||
    l1.implied_facts.length > 0 ||
    l1.events.length > 0 ||
    l1.opinions.length > 0 ||
    l1.concepts.length > 0 ||
    l1.implied_processes.length > 0;

  if (!hasContent) {
    writeConversationState(CONVERSATION_STATE_PATH, [...previousTurns, { prompt, entities: [], timestamp: Date.now() }], sessionId);

    if (devMode) {
      trace.finish("");
      const devFile = getDevModeFile();
      if (devFile) appendFileSync(devFile, trace.format() + "\n");
    }
    await reportCosts().catch(() => {});
    engine.close();
    process.exit(0);
  }

  // Full pipeline via MemoryEngine
  const result = await engine.process(prompt, l1);
  const context = result.curatedContext || result.context;

  if (result.searchPlan) trace.addSearchPlan(result.searchPlan);
  if (result.timing) trace.addTiming({
    layer1_ms: l1c.duration_ms,
    layer1_5_ms: result.timing.plan_ms,
    layer2_ms: result.timing.search_ms,
  });
  for (const turn of result.turns) {
    trace.addToolCall(turn);
  }

  trace.finish(context);

  const entityNames = l1.entities.map(e => e.name);
  writeConversationState(
    CONVERSATION_STATE_PATH,
    [...previousTurns, { prompt, entities: entityNames, contextSummary: buildContextSummary(context), timestamp: Date.now() }],
    sessionId
  );

  let additionalContext = "";

  if (context) {
    additionalContext += `<memory>\n${context}\n</memory>`;
  }

  if (result.contradictions?.length) {
    for (const c of result.contradictions) {
      additionalContext += `\n<memory-action-needed>\nA new instruction was stored that may conflict with an existing one:\n- New: "${c.newContent}"\n- Existing: "${c.oldContent}"\nQuestion: ${c.question}\nPlease ask the user to clarify.\n</memory-action-needed>`;
    }
  }

  if (devMode) {
    const devFile = getDevModeFile();
    if (devFile) appendFileSync(devFile, trace.format() + "\n");
  }

  await reportCosts().catch(() => {});
  engine.close();

  if (!additionalContext) {
    process.exit(0);
  }

  respond(additionalContext);
}

main().catch((err) => {
  process.stderr.write(`on-prompt hook error: ${err?.message || err}\n`);
  process.exit(0);
});
