/**
 * E2E test — runs the memory pipeline directly (no hooks).
 *
 * Usage:
 *   bun pa-test-1/test-pipeline.ts "Check if Peter's content is passing as human"
 *   OCTY_DEBUG=1 bun pa-test-1/test-pipeline.ts "What does WOBS do?"
 */
import { classify } from "./memory/layer1";
import { agenticLoop } from "./memory/layer2";
import { createTrace } from "./memory/debug";

const prompt = process.argv[2];
if (!prompt) {
  console.error("Usage: bun pa-test-1/test-pipeline.ts <prompt>");
  process.exit(1);
}

console.log(`\nPrompt: "${prompt}"\n`);

const trace = createTrace(prompt);

// Layer 1
console.log("── Layer 1: Classifying...");
const l1c = await classify(prompt);
const l1 = l1c.result;
trace.addLayer1(l1);
trace.addLayer1Raw(l1c.raw);
console.log(`L1 raw: ${l1c.raw.slice(0, 200)}${l1c.raw.length > 200 ? "..." : ""}`);
console.log(`L1 duration: ${l1c.duration_ms}ms (retried: ${l1c.retried}, fallback: ${l1c.fallback})`);

console.log(`Entities: ${JSON.stringify(l1.entities)}`);
console.log(`Implied facts: ${JSON.stringify(l1.implied_facts)}`);
console.log(`Events: ${JSON.stringify(l1.events)}`);
console.log(`Concepts: ${JSON.stringify(l1.concepts)}`);
console.log(`Implied processes: ${JSON.stringify(l1.implied_processes)}`);
console.log(`Intents: ${JSON.stringify(l1.intents)}`);
console.log(`Operations: retrieve=${l1.operations.retrieve}, store=${l1.operations.store}`);

// Check if anything was extracted
const hasContent =
  l1.entities.length > 0 ||
  l1.implied_facts.length > 0 ||
  l1.events.length > 0 ||
  l1.opinions.length > 0 ||
  l1.concepts.length > 0 ||
  l1.implied_processes.length > 0;

if (!hasContent) {
  console.log("\nNothing extracted — skipping Layer 2.");
  trace.finish("");
  process.exit(0);
}

// Layer 2
if (l1.operations.retrieve || l1.operations.store) {
  console.log("\n── Layer 2: Agentic loop...");
  const result = await agenticLoop(prompt, l1);

  if (result.searchPlan) {
    trace.addSearchPlan(result.searchPlan);
    console.log(`\n── Layer 1.5: Search Plan ──`);
    console.log(result.searchPlan);
  }
  if (result.timing) {
    trace.addTiming({
      layer1_ms: l1c.duration_ms,
      layer1_5_ms: result.timing.plan_ms,
      layer2_ms: result.timing.search_ms,
    });
    console.log(`\nTiming: L1=${l1c.duration_ms}ms, L1.5=${result.timing.plan_ms}ms, L2=${result.timing.search_ms}ms`);
  }

  for (const turn of result.turns) {
    trace.addToolCall(turn);
  }

  console.log(`\nTool calls: ${result.turns.length}`);
  for (let i = 0; i < result.turns.length; i++) {
    const t = result.turns[i];
    if (t.reasoning && (i === 0 || t.reasoning !== result.turns[i - 1]?.reasoning)) {
      console.log(`  Thinking: "${t.reasoning.slice(0, 200)}${t.reasoning.length > 200 ? "..." : ""}"`);
    }
    console.log(`  ${i + 1}. ${t.tool_call.name}(${JSON.stringify(t.tool_call.arguments)})`);
    const resultStr =
      typeof t.result.result === "string" ? t.result.result : JSON.stringify(t.result.result);
    const display = resultStr.length > 150 ? resultStr.slice(0, 150) + "..." : resultStr;
    console.log(`     → ${display}`);
  }

  const traceData = trace.finish(result.context);
  console.log(`\n── Final Context ──`);
  console.log(result.context || "(empty)");
  console.log(`\n── Duration: ${traceData.duration_ms}ms ──`);
} else {
  console.log("\nNo retrieve/store operations needed.");
  trace.finish("");
}
