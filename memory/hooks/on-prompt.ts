/**
 * UserPromptSubmit hook entry point.
 * Reads JSON from stdin, runs the memory pipeline, outputs JSON to stdout.
 *
 * Also handles /octybot commands:
 *   /octybot dev-mode  — toggle inline trace display
 */
import { classify } from "../layer1";
import { agenticLoop } from "../layer2";
import { createTrace, isDevMode, toggleDevMode } from "../debug";

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

async function main() {
  const raw = await readStdin();
  let input: { prompt?: string; [key: string]: unknown };

  try {
    input = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const prompt = input.prompt;
  if (!prompt || typeof prompt !== "string") {
    process.exit(0);
  }

  // Handle /octybot commands
  const trimmed = prompt.trim().toLowerCase();
  if (trimmed === "/octybot dev-mode" || trimmed === "/octybot devmode") {
    const enabled = toggleDevMode();
    respond(`<system-reminder>Memory dev-mode ${enabled ? "ENABLED" : "DISABLED"}. ${enabled ? "Full pipeline traces will be shown with each memory retrieval." : "Traces will still be saved to disk but not shown inline."}</system-reminder>`);
    return;
  }

  const devMode = isDevMode();
  const trace = createTrace(prompt);

  // Layer 1: classify
  const l1c = await classify(prompt);
  const l1 = l1c.result;
  trace.addLayer1(l1);
  trace.addLayer1Raw(l1c.raw);

  // Skip if nothing extracted
  const hasContent =
    l1.entities.length > 0 ||
    l1.implied_facts.length > 0 ||
    l1.events.length > 0 ||
    l1.opinions.length > 0 ||
    l1.concepts.length > 0 ||
    l1.implied_processes.length > 0;

  if (!hasContent) {
    if (devMode) {
      trace.finish("");
      respond(`<memory-trace>\n${trace.format()}\n</memory-trace>`);
      return;
    }
    process.exit(0);
  }

  // Layer 2: agentic loop
  let context = "";
  if (l1.operations.retrieve || l1.operations.store) {
    const result = await agenticLoop(prompt, l1);
    context = result.context;
    if (result.searchPlan) trace.addSearchPlan(result.searchPlan);
    if (result.timing) trace.addTiming({
      layer1_ms: l1c.duration_ms,
      layer1_5_ms: result.timing.plan_ms,
      layer2_ms: result.timing.search_ms,
    });
    for (const turn of result.turns) {
      trace.addToolCall(turn);
    }
  }

  trace.finish(context);

  // Build output
  let additionalContext = "";

  if (context) {
    additionalContext += `<memory>\n${context}\n</memory>`;
  }

  if (devMode) {
    additionalContext += `\n\n<memory-trace>\n${trace.format()}\n</memory-trace>`;
  }

  if (!additionalContext) {
    process.exit(0);
  }

  respond(additionalContext);
}

main().catch((err) => {
  // Log to stderr so it doesn't interfere with stdout JSON
  process.stderr.write(`on-prompt hook error: ${err?.message || err}\n`);
  process.exit(0); // Don't block Claude on errors
});
