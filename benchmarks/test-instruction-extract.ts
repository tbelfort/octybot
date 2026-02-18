/**
 * Test the dedicated instruction extraction layer on the 10 messages
 * that were previously misclassified by the store filter.
 *
 * Usage:
 *   bun test-instruction-extract.ts
 */
import { extractInstructions } from "../src/memory/store";
import { resetUsage, getUsage } from "../src/memory/usage-tracker";

// The 10 messages that were misclassified (excluding #46 and #50 which were correct)
const MESSAGES = [
  { id: 3,  msg: "The Airtable board is where we track all client deliverables", expected: "instruction/tool_usage", difficulty: "tool usage as fact" },
  { id: 8,  msg: "The WordPress login credentials are in the shared 1Password vault", expected: "instruction/tool_usage", difficulty: "location instruction" },
  { id: 10, msg: "We bill Anderson quarterly, not monthly like the others", expected: "instruction/rule", difficulty: "exception rule" },
  { id: 23, msg: "Lisa is responsible for chasing late payments from clients", expected: "instruction/rule", difficulty: "role as instruction" },
  { id: 25, msg: "Peter is the go-to person for any Anderson technical questions", expected: "instruction/rule", difficulty: "role as fact" },
  { id: 26, msg: "I prefer that we never publish articles on Fridays — clients don't read them over the weekend", expected: "instruction/rule", difficulty: "preference as rule" },
  { id: 32, msg: "No wait, the Surfer minimum is 80 now, not 75 — we raised it last week", expected: "instruction/rule", difficulty: "threshold update" },
  { id: 34, msg: "I was wrong earlier, Canopy Digital wants fortnightly delivery not weekly", expected: "instruction/rule", difficulty: "schedule correction" },
  { id: 39, msg: "New article onboarding: check Originality.ai, run through Surfer, get Sarah's sign-off, then schedule in WordPress for next Tuesday 9am", expected: "instruction/process", difficulty: "multi-tool process" },
  { id: 40, msg: "Quarterly reporting for each client: pull analytics from GSC, compare against KPIs in Airtable, write summary, send to Lisa for client distribution", expected: "instruction/process", difficulty: "reporting process" },
];

console.log(`\n═══ Instruction Extraction Layer Test ═══`);
console.log(`Testing ${MESSAGES.length} previously misclassified messages\n`);

resetUsage();
const startTime = Date.now();
let hits = 0;

for (const { id, msg, expected, difficulty } of MESSAGES) {
  process.stderr.write(`  [#${id}] ${msg.slice(0, 55)}...`);

  const result = await extractInstructions(msg);

  const gotInstruction = result.instructions.length > 0;
  const marker = gotInstruction ? "HIT" : "MISS";
  if (gotInstruction) hits++;

  console.log();
  console.log(`  [#${id}] [${marker}] ${difficulty}`);
  console.log(`    Message:  "${msg.slice(0, 80)}${msg.length > 80 ? "..." : ""}"`);
  console.log(`    Expected: ${expected}`);
  if (gotInstruction) {
    for (const instr of result.instructions) {
      console.log(`    Got:      instruction/${instr.subtype} (scope: ${instr.scope})`);
      console.log(`    Content:  "${instr.content}"`);
      console.log(`    Reason:   ${instr.reason}`);
    }
  } else {
    console.log(`    Got:      (nothing extracted)`);
    if (result.raw) console.log(`    Raw:      ${result.raw.slice(0, 150)}`);
  }
  console.log();
}

const duration = Date.now() - startTime;
const usage = getUsage();

console.log(`═══ Results ═══`);
console.log(`Hit rate: ${hits}/${MESSAGES.length} (${(hits / MESSAGES.length * 100).toFixed(0)}%)`);
console.log(`Duration: ${(duration / 1000).toFixed(1)}s`);
console.log(`Tokens: input=${usage.l1_input} output=${usage.l1_output}`);

const cost = (usage.l1_input * 0.08 + usage.l1_output * 0.36) / 1_000_000;
console.log(`Cost: $${cost.toFixed(4)} ($${(cost / MESSAGES.length).toFixed(5)}/msg)`);
console.log();
