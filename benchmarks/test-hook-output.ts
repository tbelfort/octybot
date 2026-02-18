/**
 * Reproduces EXACTLY what on-prompt.ts sends to Claude Code.
 * Same logic, same code paths — shows the raw additionalContext string.
 */
import { classify } from "../src/memory/layer1";
import { agenticLoop } from "../src/memory/layer2";
import { getDb } from "../src/memory/db-core";
import { createTrace, isDevMode, getDevModeFile } from "../src/memory/debug";

const db = getDb();
import { appendFileSync } from "fs";

const QUERIES = [
  "What does dave do for us?",
  "what happened with brightwell?",
];

for (const prompt of QUERIES) {
  console.log(`\n${"═".repeat(70)}`);
  console.log(`QUERY: "${prompt}"`);
  console.log(`Dev mode: ${isDevMode()} | Dev file: ${getDevModeFile()}`);
  console.log(`${"═".repeat(70)}`);

  // ── Exact hook logic from on-prompt.ts ──

  const devMode = isDevMode();
  const trace = createTrace(prompt);

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
    console.log("L1 extracted nothing — hook would exit(0)");
    if (devMode) {
      trace.finish("");
      const devFile = getDevModeFile();
      if (devFile) appendFileSync(devFile, trace.format() + "\n");
    }
    continue;
  }

  let context = "";
  let contradictions: Awaited<ReturnType<typeof agenticLoop>>["contradictions"];
  if (l1.operations.retrieve || l1.operations.store) {
    const result = await agenticLoop(db, prompt, l1);
    context = result.curatedContext || result.context;
    contradictions = result.contradictions;
    if (result.searchPlan) trace.addSearchPlan(result.searchPlan);
    if (result.timing) trace.addTiming({
      layer1_ms: l1c.duration_ms,
      layer1_5_ms: result.timing.plan_ms,
      layer2_ms: result.timing.search_ms,
    });
    for (const turn of result.turns) {
      trace.addToolCall(turn);
    }

    console.log(`\nRaw context: ${result.context.length} chars`);
    console.log(`Curated context: ${result.curatedContext.length} chars`);
    console.log(`Using: ${result.curatedContext ? "CURATED" : "RAW (fallback)"}`);
  }

  trace.finish(context);

  // Build output — exact same as hook
  let additionalContext = "";
  if (context) {
    additionalContext += `<memory>\n${context}\n</memory>`;
  }
  if (contradictions?.length) {
    for (const c of contradictions) {
      additionalContext += `\n<memory-action-needed>\nA new instruction was stored that may conflict with an existing one:\n- New: "${c.newContent}"\n- Existing: "${c.oldContent}"\nQuestion: ${c.question}\nPlease ask the user to clarify.\n</memory-action-needed>`;
    }
  }
  if (devMode) {
    const devFile = getDevModeFile();
    if (devFile) appendFileSync(devFile, trace.format() + "\n");
    console.log(`\nTrace written to: ${devFile} (NOT injected into context)`);
  }

  if (!additionalContext) {
    console.log("No context to send — hook would exit(0)");
    continue;
  }

  // ── Output exactly what Claude Code receives ──
  console.log(`\n── EXACT additionalContext (${additionalContext.length} chars) ──`);
  console.log(additionalContext);
  console.log(`── END (${additionalContext.length} chars) ──`);

  // Build the full JSON the hook would output
  const hookOutput = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext,
    },
  });
  console.log(`\nFull hook JSON size: ${hookOutput.length} chars`);
}
