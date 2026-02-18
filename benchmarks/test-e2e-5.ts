/**
 * End-to-end pipeline test — 5 complex, multi-part messages.
 * Traces every stage: L1 classify → instruction extract → store filter → store → retrieve.
 *
 * Usage:
 *   bun test-e2e-5.ts
 */
import { classify } from "../src/memory/layer1";
import { extractInstructions, filterForStorage, storeLoop } from "../src/memory/store";
import { retrieveLoop } from "../src/memory/retrieve";
import { getDb } from "../src/memory/db-core";
import { resetUsage, getUsage } from "../src/memory/usage-tracker";
import type { Layer1Result, StoreItem } from "../src/memory/types";

const db = getDb();

const QUERIES = [
  `Dave just submitted his resignation effective March 15th. Sarah will be taking over his client accounts, and going forward all content reviews need to go through her before publishing. Oh and the Anderson contract got renewed for another year at £5,500 per month.`,

  `Had a rough morning — the staging server crashed at 3am and took the whole test suite down with it. We've moved all automated testing to the backup cluster for now. Also, reminder that nobody should be running load tests against staging without checking with DevOps first.`,

  `Quick update: we signed Meridian Corp as a new client yesterday. They're an enterprise tier account so they get dedicated infrastructure and 99.99% SLA. Tom is their primary point of contact on our side, and they want fortnightly reports delivered every other Monday.`,

  `I think the new dashboard redesign is fantastic, really clean work from the design team. By the way, we need to update the deployment process — from now on every release needs a changelog entry in Notion before it goes to production. The last three releases went out without proper documentation and it caused a lot of confusion with the support team.`,

  `Just got off a call with the legal team. They confirmed that all contractor agreements must include the updated IP clause starting next month. Also, we lost the Pinnacle account — they churned last week over the pricing increase. Lisa from finance needs to adjust the Q2 revenue forecast accordingly. For any future pricing changes, we now need sign-off from both sales and finance before sending to the client.`,
];

async function runQuery(idx: number, prompt: string) {
  console.log(`\n${"═".repeat(80)}`);
  console.log(`QUERY ${idx + 1}: "${prompt.slice(0, 90)}${prompt.length > 90 ? "..." : ""}"`);
  console.log(`${"═".repeat(80)}`);
  console.log(`\nFull message:\n  "${prompt}"\n`);

  const queryStart = Date.now();
  resetUsage();

  // ── Step 1: L1 Classify ──
  const l1start = Date.now();
  const l1c = await classify(prompt);
  const l1 = l1c.result;
  const l1ms = Date.now() - l1start;

  console.log(`── L1 Classification (${l1ms}ms) ──`);
  console.log(`  Entities:  ${l1.entities.map(e => `${e.name} (${e.type})`).join(", ") || "(none)"}`);
  console.log(`  Facts:     ${l1.implied_facts.length ? l1.implied_facts.map(f => `"${f}"`).join("\n             ") : "(none)"}`);
  console.log(`  Events:    ${l1.events.length ? l1.events.map(e => `"${e}"`).join("\n             ") : "(none)"}`);
  console.log(`  Plans:     ${l1.plans.length ? l1.plans.map(p => `"${p}"`).join("\n             ") : "(none)"}`);
  console.log(`  Opinions:  ${l1.opinions.length ? l1.opinions.map(o => `"${o}"`).join("\n             ") : "(none)"}`);
  console.log(`  Intents:   ${l1.intents.join(", ")}`);
  console.log(`  Ops:       retrieve=${l1.operations.retrieve} store=${l1.operations.store}`);

  // ── Step 2: Instruction Extractor ──
  const exStart = Date.now();
  const instrResult = await extractInstructions(prompt);
  const exMs = Date.now() - exStart;

  console.log(`\n── Instruction Extractor (${exMs}ms) ──`);
  if (instrResult.instructions.length === 0) {
    console.log(`  (no instructions found)`);
  } else {
    for (const instr of instrResult.instructions) {
      console.log(`  → instruction/${instr.subtype} (scope ${instr.scope}): "${instr.content}"`);
    }
  }

  // ── Step 3: Store Filter (informed about extracted instructions) ──
  const hasStorable = l1.operations.store ||
    l1.implied_facts.length > 0 || l1.events.length > 0 ||
    l1.plans.length > 0 || l1.opinions.length > 0 ||
    l1.intents.includes("instruction");

  let filterItems: StoreItem[] = [];
  let filterMs = 0;
  if (hasStorable) {
    const fStart = Date.now();
    const filterResult = await filterForStorage(prompt, l1, instrResult.instructions);
    filterMs = Date.now() - fStart;

    console.log(`\n── Store Filter (${filterMs}ms) ──`);
    if (filterResult.storeItems.length === 0) {
      console.log(`  (nothing to store) — ${filterResult.skipReason}`);
    } else {
      for (const item of filterResult.storeItems) {
        const scopeStr = item.scope != null ? ` scope=${item.scope}` : "";
        const salStr = item.salience != null ? ` sal=${item.salience}` : "";
        console.log(`  → ${item.type}/${item.subtype || "?"}${scopeStr}${salStr}: "${item.content}"`);
      }
    }
    console.log(`  Skip reason: ${filterResult.skipReason || "(none)"}`);

    // Check for duplication
    const filterInstructions = filterResult.storeItems.filter(si => si.type === "instruction");
    if (filterInstructions.length > 0 && instrResult.instructions.length > 0) {
      console.log(`  ⚠ DUPLICATION: filter also produced ${filterInstructions.length} instruction(s)`);
    }

    // Combine (same logic as agenticLoop)
    const instructionItems: StoreItem[] = instrResult.instructions.map(ei => ({
      content: ei.content,
      type: "instruction",
      subtype: ei.subtype,
      scope: ei.scope,
    }));
    const filterNonInstructions = filterResult.storeItems.filter(item => item.type !== "instruction");
    filterItems = [...instructionItems, ...filterNonInstructions];
  }

  // ── Step 4: What would be stored ──
  console.log(`\n── Combined Store Items (${filterItems.length}) ──`);
  if (filterItems.length === 0) {
    console.log(`  (nothing)`);
  } else {
    for (const item of filterItems) {
      const scopeStr = item.scope != null ? ` scope=${item.scope}` : "";
      console.log(`  [${item.type}/${item.subtype || "?"}${scopeStr}] "${item.content}"`);
    }
  }

  // ── Step 5: Retrieve (if applicable) ──
  let retrieveMs = 0;
  if (l1.operations.retrieve) {
    const rStart = Date.now();
    const rResult = await retrieveLoop(db, prompt, l1);
    retrieveMs = Date.now() - rStart;

    console.log(`\n── Retrieve (${retrieveMs}ms) ──`);
    console.log(`  Search plan: ${rResult.searchPlan.split("\n").join("\n               ")}`);
    console.log(`  Tool calls: ${rResult.turns.length}`);
    if (rResult.curatedContext) {
      console.log(`  Context (${rResult.curatedContext.length} chars):\n    ${rResult.curatedContext.split("\n").join("\n    ")}`);
    } else {
      console.log(`  Context: (empty — nothing relevant found)`);
    }
  } else {
    console.log(`\n── Retrieve: skipped (store-only message) ──`);
  }

  // ── Timing & Cost ──
  const totalMs = Date.now() - queryStart;
  const usage = getUsage();
  const cost = (
    (usage.l1_input + usage.l2_input) * 0.08 +
    (usage.l1_output + usage.l2_output) * 0.36
  ) / 1_000_000;

  console.log(`\n── Summary ──`);
  console.log(`  Time: ${(totalMs / 1000).toFixed(1)}s (L1: ${l1ms}ms, Extract: ${exMs}ms, Filter: ${filterMs}ms, Retrieve: ${retrieveMs}ms)`);
  console.log(`  Cost: $${cost.toFixed(4)}`);
  console.log(`  Tokens: L1 in=${usage.l1_input} out=${usage.l1_output} | L2 in=${usage.l2_input} out=${usage.l2_output}`);

  return { totalMs, cost };
}

async function main() {
  console.log(`═══ End-to-End Pipeline Test — 5 Complex Queries ═══`);

  let grandTotal = 0;
  let grandCost = 0;

  for (let i = 0; i < QUERIES.length; i++) {
    const { totalMs, cost } = await runQuery(i, QUERIES[i]);
    grandTotal += totalMs;
    grandCost += cost;
  }

  console.log(`\n${"═".repeat(80)}`);
  console.log(`TOTALS: ${(grandTotal / 1000).toFixed(1)}s | $${grandCost.toFixed(4)} | ${(grandCost / QUERIES.length).toFixed(4)}/msg`);
  console.log(`${"═".repeat(80)}\n`);
}

main().catch(console.error);
