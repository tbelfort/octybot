/**
 * CLI to view saved debug traces.
 *
 * Usage:
 *   bun pa-test-1/debug-viewer.ts              # show latest trace
 *   bun pa-test-1/debug-viewer.ts list          # list recent traces
 *   bun pa-test-1/debug-viewer.ts list 20       # list last 20
 *   bun pa-test-1/debug-viewer.ts <id>          # show specific trace (partial match)
 *   bun pa-test-1/debug-viewer.ts last 3        # show last 3 traces
 *   bun pa-test-1/debug-viewer.ts dev-mode      # toggle dev-mode
 */
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { DEBUG_DIR } from "./memory/config";
import { isDevMode, toggleDevMode } from "./memory/debug";
import type { PipelineTrace, ToolTurn } from "./memory/types";

function listTraces(): string[] {
  try {
    return readdirSync(DEBUG_DIR)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

function loadTrace(filename: string): PipelineTrace {
  return JSON.parse(readFileSync(join(DEBUG_DIR, filename), "utf-8"));
}

function formatTurn(turn: ToolTurn, index: number, prevReasoning?: string): string[] {
  const lines: string[] = [];
  if (turn.reasoning && turn.reasoning !== prevReasoning) {
    lines.push(`  \x1b[36mThinking:\x1b[0m "${turn.reasoning.slice(0, 400)}${turn.reasoning.length > 400 ? "..." : ""}"`);
  }
  const args = JSON.stringify(turn.tool_call.arguments);
  lines.push(`  \x1b[33m${index}. ${turn.tool_call.name}\x1b[0m(${args})`);
  const resultStr = typeof turn.result.result === "string" ? turn.result.result : JSON.stringify(turn.result.result);
  const display = resultStr.length > 500 ? resultStr.slice(0, 500) + "..." : resultStr;
  if (display) {
    lines.push(`     \x1b[2m→ ${display}\x1b[0m`);
  }
  return lines;
}

function formatTrace(trace: PipelineTrace): string {
  const lines: string[] = [];
  lines.push(`\n\x1b[1m═══ Memory Pipeline Trace ═══\x1b[0m`);
  lines.push(`\x1b[1mPrompt:\x1b[0m "${trace.prompt}"`);
  lines.push(`\x1b[1mDuration:\x1b[0m ${trace.duration_ms}ms`);
  if (trace.timing) {
    const t = trace.timing;
    lines.push(`\x1b[1mTiming:\x1b[0m L1=${t.layer1_ms}ms, L1.5=${t.layer1_5_ms ?? "n/a"}ms, L2=${t.layer2_ms}ms`);
  }
  lines.push(``);

  // Layer 1
  lines.push(`\x1b[1m── Layer 1: Classification ──\x1b[0m`);
  if (trace.layer1_raw) {
    lines.push(`\x1b[2mRaw: ${trace.layer1_raw.slice(0, 500)}${trace.layer1_raw.length > 500 ? "..." : ""}\x1b[0m`);
    lines.push(``);
  }
  lines.push(`Entities: ${trace.layer1.entities.map(e => `\x1b[32m${e.name}\x1b[0m (${e.type}${e.ambiguous ? ", ambiguous" : ""})`).join(", ") || "(none)"}`);
  lines.push(`Facts: ${trace.layer1.implied_facts.join("; ") || "(none)"}`);
  lines.push(`Events: ${trace.layer1.events.join("; ") || "(none)"}`);
  lines.push(`Opinions: ${trace.layer1.opinions.join("; ") || "(none)"}`);
  lines.push(`Concepts: ${trace.layer1.concepts.join(", ") || "(none)"}`);
  lines.push(`Processes: ${trace.layer1.implied_processes.join("; ") || "(none)"}`);
  lines.push(`Intents: \x1b[35m${trace.layer1.intents.join(", ")}\x1b[0m`);
  lines.push(`Operations: retrieve=${trace.layer1.operations.retrieve}, store=${trace.layer1.operations.store}`);
  lines.push(``);

  // Layer 1.5
  if (trace.layer1_5_plan) {
    lines.push(`\x1b[1m── Layer 1.5: Search Plan ──\x1b[0m`);
    lines.push(`\x1b[36m${trace.layer1_5_plan}\x1b[0m`);
    lines.push(``);
  }

  // Layer 2
  const retrieveTurns = trace.layer2_turns.filter(t => !t._pipeline || t._pipeline === "retrieve");
  const storeTurns = trace.layer2_turns.filter(t => t._pipeline === "store");

  if (retrieveTurns.length > 0) {
    lines.push(`\x1b[1m── Layer 2: Retrieve (${retrieveTurns.length} calls) ──\x1b[0m`);
    for (let i = 0; i < retrieveTurns.length; i++) {
      lines.push(...formatTurn(retrieveTurns[i], i + 1, retrieveTurns[i - 1]?.reasoning));
    }
    lines.push(``);
  }

  if (storeTurns.length > 0) {
    lines.push(`\x1b[1m── Layer 2: Store (${storeTurns.length} calls) ──\x1b[0m`);
    for (let i = 0; i < storeTurns.length; i++) {
      lines.push(...formatTurn(storeTurns[i], i + 1, storeTurns[i - 1]?.reasoning));
    }
    lines.push(``);
  }

  // No pipeline label
  if (retrieveTurns.length === 0 && storeTurns.length === 0 && trace.layer2_turns.length > 0) {
    lines.push(`\x1b[1m── Layer 2: Tool Calls (${trace.layer2_turns.length}) ──\x1b[0m`);
    for (let i = 0; i < trace.layer2_turns.length; i++) {
      lines.push(...formatTurn(trace.layer2_turns[i], i + 1, trace.layer2_turns[i - 1]?.reasoning));
    }
    lines.push(``);
  }

  // Context
  lines.push(`\x1b[1m── Assembled Context ──\x1b[0m`);
  lines.push(trace.final_context || "\x1b[2m(empty)\x1b[0m");
  lines.push(`\x1b[1m═══════════════════════════\x1b[0m\n`);

  return lines.join("\n");
}

// ── CLI ─────────────────────────────────────────────────────────────

const arg = process.argv[2];
const arg2 = process.argv[3];

if (arg === "dev-mode" || arg === "devmode") {
  const enabled = toggleDevMode();
  console.log(`Dev-mode: ${enabled ? "\x1b[32mENABLED\x1b[0m" : "\x1b[31mDISABLED\x1b[0m"}`);
  process.exit(0);
}

if (arg === "list") {
  const traces = listTraces();
  const count = parseInt(arg2 || "10");
  if (traces.length === 0) {
    console.log("No traces found. Traces are saved automatically on each prompt.");
  } else {
    console.log(`${traces.length} trace(s) total, showing last ${Math.min(count, traces.length)}:\n`);
    for (const f of traces.slice(0, count)) {
      const data = loadTrace(f);
      const prompt = data.prompt.slice(0, 60) + (data.prompt.length > 60 ? "..." : "");
      const turns = data.layer2_turns.length;
      console.log(`  ${f.replace(".json", "")}  "${prompt}"  (${turns} calls, ${data.duration_ms}ms)`);
    }
  }
  console.log(`\nDev-mode: ${isDevMode() ? "\x1b[32mENABLED\x1b[0m" : "\x1b[31mDISABLED\x1b[0m"}`);
  process.exit(0);
}

if (arg === "last") {
  const count = parseInt(arg2 || "1");
  const traces = listTraces().slice(0, count);
  if (traces.length === 0) {
    console.log("No traces found.");
    process.exit(0);
  }
  for (const f of traces.reverse()) {
    console.log(formatTrace(loadTrace(f)));
  }
  process.exit(0);
}

// Default: show latest or specific trace
const traces = listTraces();
if (traces.length === 0) {
  console.log("No traces found. Traces are saved automatically on each prompt.");
  process.exit(0);
}

let filename: string;
if (arg) {
  const match = traces.find((f) => f.includes(arg));
  if (!match) {
    console.error(`No trace matching "${arg}"`);
    process.exit(1);
  }
  filename = match;
} else {
  filename = traces[0]; // latest
}

console.log(formatTrace(loadTrace(filename)));
