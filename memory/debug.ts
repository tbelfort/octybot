import { mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { DEBUG_DIR } from "./config";
import type { Layer1Result, ToolTurn, PipelineTrace, StoreItem } from "./types";

export class Trace {
  private data: PipelineTrace;
  private startTime: number;

  constructor(prompt: string) {
    this.startTime = Date.now();
    this.data = {
      timestamp: new Date().toISOString(),
      prompt,
      layer1: {
        entities: [],
        implied_facts: [],
        events: [],
        opinions: [],
        concepts: [],
        implied_processes: [],
        intents: [],
        operations: { retrieve: false, store: false },
      },
      layer2_turns: [],
      final_context: "",
      duration_ms: 0,
    };
  }

  addLayer1(result: Layer1Result) {
    this.data.layer1 = result;
  }

  addLayer1Raw(raw: string) {
    this.data.layer1_raw = raw;
  }

  addSearchPlan(plan: string) {
    this.data.layer1_5_plan = plan;
  }

  addStoreFilter(filter: { storeItems: StoreItem[]; skipReason: string; duration_ms: number }) {
    this.data.store_filter = {
      store_items: filter.storeItems,
      skip_reason: filter.skipReason,
      duration_ms: filter.duration_ms,
    };
  }

  addTiming(timing: PipelineTrace["timing"]) {
    this.data.timing = timing;
  }

  addToolCall(turn: ToolTurn) {
    this.data.layer2_turns.push(turn);
  }

  finish(context: string): PipelineTrace {
    this.data.final_context = context;
    this.data.duration_ms = Date.now() - this.startTime;

    // Always save traces to disk
    this.save();

    return this.data;
  }

  private save() {
    mkdirSync(DEBUG_DIR, { recursive: true });
    const filename = `${this.data.timestamp.replace(/[:.]/g, "-")}.json`;
    const filepath = join(DEBUG_DIR, filename);
    writeFileSync(filepath, JSON.stringify(this.data, null, 2));
  }

  /** Full human-readable trace for dev-mode display */
  format(): string {
    const lines: string[] = [];
    lines.push(`\n═══ Memory Pipeline Trace ═══`);
    lines.push(`Prompt: "${this.data.prompt}"`);
    lines.push(`Duration: ${this.data.duration_ms}ms`);
    if (this.data.timing) {
      const t = this.data.timing;
      const parts = [`L1=${t.layer1_ms}ms`];
      if (t.layer1_5_ms != null) parts.push(`L1.5 plan=${t.layer1_5_ms}ms`);
      if (t.layer1_5_filter_ms != null) parts.push(`L1.5 filter=${t.layer1_5_filter_ms}ms`);
      parts.push(`L2=${t.layer2_ms}ms`);
      if (t.curate_ms != null) parts.push(`curate=${t.curate_ms}ms`);
      if (t.layer2_store_ms != null) parts.push(`L2 store=${t.layer2_store_ms}ms`);
      lines.push(`Timing: ${parts.join(", ")}`);
    }
    lines.push(``);

    // Layer 1
    lines.push(`── Layer 1: Classification ──`);
    if (this.data.layer1_raw) {
      lines.push(`Raw response: ${this.data.layer1_raw}`);
      lines.push(``);
    }
    lines.push(`Entities: ${this.data.layer1.entities.map(e => `${e.name} (${e.type}${e.ambiguous ? ", ambiguous" : ""})`).join(", ") || "(none)"}`);
    lines.push(`Implied facts: ${this.data.layer1.implied_facts.join("; ") || "(none)"}`);
    lines.push(`Events: ${this.data.layer1.events.join("; ") || "(none)"}`);
    lines.push(`Opinions: ${this.data.layer1.opinions.join("; ") || "(none)"}`);
    lines.push(`Concepts: ${this.data.layer1.concepts.join(", ") || "(none)"}`);
    lines.push(`Implied processes: ${this.data.layer1.implied_processes.join("; ") || "(none)"}`);
    lines.push(`Intents: ${this.data.layer1.intents.join(", ")}`);
    lines.push(`Operations: retrieve=${this.data.layer1.operations.retrieve}, store=${this.data.layer1.operations.store}`);
    lines.push(``);

    // Layer 1.5: Search Plan
    if (this.data.layer1_5_plan) {
      lines.push(`── Layer 1.5: Search Plan ──`);
      lines.push(this.data.layer1_5_plan);
      lines.push(``);
    }

    // Layer 1.5: Store Filter
    if (this.data.store_filter) {
      lines.push(`── Layer 1.5: Store Filter (${this.data.store_filter.duration_ms}ms) ──`);
      const sf = this.data.store_filter;
      if (sf.store_items.length > 0) {
        lines.push(`Decision: STORE ${sf.store_items.length} item(s)`);
        for (const item of sf.store_items) {
          lines.push(`  + [${item.type}${item.subtype ? '/' + item.subtype : ''}] "${item.content}" — ${item.reason || 'no reason given'}`);
        }
      } else {
        lines.push(`Decision: SKIP (nothing worth storing)`);
      }
      if (sf.skip_reason) {
        lines.push(`Skip reason: ${sf.skip_reason}`);
      }
      lines.push(``);
    }

    // Layer 2
    const retrieveTurns = this.data.layer2_turns.filter(t => !t._pipeline || t._pipeline === "retrieve");
    const storeTurns = this.data.layer2_turns.filter(t => t._pipeline === "store");

    if (retrieveTurns.length > 0) {
      lines.push(`── Layer 2: Retrieve (${retrieveTurns.length} calls) ──`);
      for (let i = 0; i < retrieveTurns.length; i++) {
        const turn = retrieveTurns[i];
        // Show reasoning if present and different from previous
        if (turn.reasoning && (i === 0 || turn.reasoning !== retrieveTurns[i - 1]?.reasoning)) {
          lines.push(`  Thinking: "${turn.reasoning.slice(0, 300)}${turn.reasoning.length > 300 ? "..." : ""}"`);
        }
        lines.push(`  ${i + 1}. ${turn.tool_call.name}(${JSON.stringify(turn.tool_call.arguments)})`);
        const resultStr = typeof turn.result.result === "string" ? turn.result.result : JSON.stringify(turn.result.result);
        const display = resultStr.length > 300 ? resultStr.slice(0, 300) + "..." : resultStr;
        lines.push(`     → ${display}`);
      }
      lines.push(``);
    }

    if (storeTurns.length > 0) {
      lines.push(`── Layer 2: Store (${storeTurns.length} calls) ──`);
      for (let i = 0; i < storeTurns.length; i++) {
        const turn = storeTurns[i];
        if (turn.reasoning && (i === 0 || turn.reasoning !== storeTurns[i - 1]?.reasoning)) {
          lines.push(`  Thinking: "${turn.reasoning.slice(0, 300)}${turn.reasoning.length > 300 ? "..." : ""}"`);
        }
        lines.push(`  ${i + 1}. ${turn.tool_call.name}(${JSON.stringify(turn.tool_call.arguments)})`);
        const resultStr = typeof turn.result.result === "string" ? turn.result.result : JSON.stringify(turn.result.result);
        const display = resultStr.length > 200 ? resultStr.slice(0, 200) + "..." : resultStr;
        lines.push(`     → ${display}`);
      }
      lines.push(``);
    }

    // No pipeline label (old-style or single pipeline)
    if (retrieveTurns.length === 0 && storeTurns.length === 0 && this.data.layer2_turns.length > 0) {
      lines.push(`── Layer 2: Tool Calls (${this.data.layer2_turns.length}) ──`);
      for (let i = 0; i < this.data.layer2_turns.length; i++) {
        const turn = this.data.layer2_turns[i];
        if (turn.reasoning && (i === 0 || turn.reasoning !== this.data.layer2_turns[i - 1]?.reasoning)) {
          lines.push(`  Thinking: "${turn.reasoning.slice(0, 300)}${turn.reasoning.length > 300 ? "..." : ""}"`);
        }
        lines.push(`  ${i + 1}. ${turn.tool_call.name}(${JSON.stringify(turn.tool_call.arguments)})`);
        const resultStr = typeof turn.result.result === "string" ? turn.result.result : JSON.stringify(turn.result.result);
        const display = resultStr.length > 300 ? resultStr.slice(0, 300) + "..." : resultStr;
        lines.push(`     → ${display}`);
      }
      lines.push(``);
    }

    // Context
    lines.push(`── Assembled Context ──`);
    lines.push(this.data.final_context || "(empty)");
    lines.push(`═══════════════════════════\n`);

    return lines.join("\n");
  }
}

export function createTrace(prompt: string): Trace {
  return new Trace(prompt);
}

/** Check if dev-mode is enabled */
export function isDevMode(): boolean {
  return getDevModeFile() !== null;
}

/** Get the dev-mode trace output file path (null if disabled) */
export function getDevModeFile(): string | null {
  const flagPath = join(DEBUG_DIR, ".dev-mode");
  try {
    const content = readFileSync(flagPath, "utf-8").trim();
    return content || join(DEBUG_DIR, "dev-trace.log");
  } catch {
    return null;
  }
}

/** Check if verbose-mode is enabled */
export function isVerboseMode(): boolean {
  const flagPath = join(DEBUG_DIR, ".verbose-mode");
  return existsSync(flagPath);
}

/** Toggle verbose-mode */
export function toggleVerboseMode(): boolean {
  const flagPath = join(DEBUG_DIR, ".verbose-mode");
  mkdirSync(DEBUG_DIR, { recursive: true });
  if (existsSync(flagPath)) {
    const { unlinkSync } = require("fs");
    unlinkSync(flagPath);
    return false;
  } else {
    writeFileSync(flagPath, new Date().toISOString());
    return true;
  }
}

/** Stored memory manifest — written by stop hook, read by prompt hook */
export interface StoredMemoryEntry {
  sessionId: number;
  nodeId: string;
  type: string;
  subtype?: string;
  content: string;
}

const MANIFEST_PATH = join(DEBUG_DIR, ".stored-manifest.json");

/** Append entries to the manifest (accumulates across session) */
export function appendStoredManifest(entries: StoredMemoryEntry[]) {
  mkdirSync(DEBUG_DIR, { recursive: true });
  const existing = readStoredManifest();
  const combined = [...existing, ...entries];
  writeFileSync(MANIFEST_PATH, JSON.stringify(combined, null, 2));
}

/** Overwrite the manifest (used by delete to write back remaining entries) */
export function writeStoredManifest(entries: StoredMemoryEntry[]) {
  mkdirSync(DEBUG_DIR, { recursive: true });
  writeFileSync(MANIFEST_PATH, JSON.stringify(entries, null, 2));
}

/** Read manifest without clearing it */
export function readStoredManifest(): StoredMemoryEntry[] {
  try {
    const raw = readFileSync(MANIFEST_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

/** Read and clear manifest (used by delete-memory.ts to get-then-rewrite) */
export function readAndClearStoredManifest(): StoredMemoryEntry[] {
  try {
    const raw = readFileSync(MANIFEST_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

/** Get the next session ID (max existing + 1) */
export function getNextSessionId(): number {
  const manifest = readStoredManifest();
  if (manifest.length === 0) return 1;
  return Math.max(...manifest.map(e => e.sessionId)) + 1;
}

/** Clear the manifest (e.g. when toggling verbose mode off) */
export function clearStoredManifest() {
  try {
    const { unlinkSync } = require("fs");
    unlinkSync(MANIFEST_PATH);
  } catch {}
}

