import { mkdirSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { DEBUG_DIR } from "./config";
import type { Layer1Result, ToolTurn, PipelineTrace } from "./types";

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
      lines.push(`Timing: L1=${t.layer1_ms}ms, L1.5=${t.layer1_5_ms ?? "n/a"}ms, L2=${t.layer2_ms}ms`);
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

    // Layer 1.5
    if (this.data.layer1_5_plan) {
      lines.push(`── Layer 1.5: Search Plan ──`);
      lines.push(this.data.layer1_5_plan);
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
  const flagPath = join(DEBUG_DIR, ".dev-mode");
  return existsSync(flagPath);
}

/** Toggle dev-mode */
export function toggleDevMode(): boolean {
  const flagPath = join(DEBUG_DIR, ".dev-mode");
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
