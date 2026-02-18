/**
 * Storage simulation — runs a message through the full memory pipeline
 * (L1 classify → L1.5 filter → L2 retrieve+store) as if it were a real chat.
 *
 * Usage:
 *   bun test-storage.ts "Your message here"
 *   DB_PATH=~/.octybot/test/memory.db bun test-storage.ts "message"
 */
import { classify } from "../src/memory/layer1";
import { agenticLoop } from "../src/memory/layer2";
import { getDb } from "../src/memory/db-core";
import { getUsage, resetUsage } from "../src/memory/usage-tracker";
import Database from "bun:sqlite";

const DB_PATH = process.env.DB_PATH || `${process.env.HOME}/.octybot/test/memory.db`;
// Force DB_PATH so the memory system uses our target DB
process.env.DB_PATH = DB_PATH;

const message = process.argv[2];
if (!message) {
  console.error("Usage: bun test-storage.ts \"Your message here\"");
  process.exit(1);
}

// Count nodes before
const dbBefore = new Database(DB_PATH, { readonly: true });
const countBefore = (dbBefore.query("SELECT COUNT(*) as c FROM nodes").get() as any).c;
dbBefore.close();

console.log(`\n📨 Message: "${message}"`);
console.log(`📁 DB: ${DB_PATH} (${countBefore} nodes)\n`);

resetUsage();

// Step 1: Layer 1 Classification
console.log("── Layer 1: Classify ──────────────────────────────────────");
const l1c = await classify(message);
const l1 = l1c.result;
console.log(`  Entities:  ${l1.entities.map((e: any) => e.name).join(", ") || "(none)"}`);
console.log(`  Facts:     ${l1.implied_facts.length > 0 ? l1.implied_facts.join("; ") : "(none)"}`);
console.log(`  Events:    ${l1.events.length > 0 ? l1.events.join("; ") : "(none)"}`);
console.log(`  Plans:     ${l1.plans.length > 0 ? l1.plans.join("; ") : "(none)"}`);
console.log(`  Opinions:  ${l1.opinions.length > 0 ? l1.opinions.join("; ") : "(none)"}`);
console.log(`  Intents:   ${l1.intents.join(", ")}`);
console.log(`  Ops:       retrieve=${l1.operations.retrieve} store=${l1.operations.store}`);

// Step 2: Agentic Loop (retrieve + store in parallel)
console.log("\n── Layer 2: Agentic Loop ──────────────────────────────────");
const db = getDb();
const result = await agenticLoop(db, message, l1);

// Show retrieval results
if (result.curatedContext) {
  console.log("\n── Retrieved Context ──────────────────────────────────────");
  console.log(result.curatedContext);
}

// Show store filter results
if (result.storeFilter) {
  console.log("\n── Store Filter ──────────────────────────────────────────");
  if (result.storeFilter.storeItems.length === 0) {
    console.log(`  Nothing to store. Reason: ${result.storeFilter.skipReason || "filter returned empty"}`);
  } else {
    for (const item of result.storeFilter.storeItems) {
      console.log(`  STORE [${item.type}/${item.subtype}]: "${item.content}"`);
      if (item.reason) console.log(`         reason: ${item.reason}`);
    }
  }
}

// Show what the store loop actually did
const storeTurns = result.turns.filter((t: any) => t._pipeline === "store");
if (storeTurns.length > 0) {
  console.log("\n── Store Actions ─────────────────────────────────────────");
  for (const turn of storeTurns) {
    const tc = turn.tool_call;
    if (tc.name === "store_memory") {
      const args = typeof tc.arguments === "string" ? JSON.parse(tc.arguments) : tc.arguments;
      console.log(`  ✅ store_memory [${args.type}/${args.subtype || "—"}]`);
      console.log(`     "${args.content}"`);
      if (args.entity_ids?.length) console.log(`     linked to: ${args.entity_ids.join(", ")}`);
      if (args.scope != null) console.log(`     scope: ${args.scope}`);
      console.log(`     → ${turn.result?.result || "(no result)"}`);
    } else if (tc.name === "search_entity" || tc.name === "search_facts") {
      const args = typeof tc.arguments === "string" ? JSON.parse(tc.arguments) : tc.arguments;
      console.log(`  🔍 ${tc.name}("${args.query || args.name || ""}")`);
    } else if (tc.name === "supersede_memory") {
      const args = typeof tc.arguments === "string" ? JSON.parse(tc.arguments) : tc.arguments;
      console.log(`  ♻️  supersede_memory: ${args.old_node_id} → new [${args.type}/${args.subtype || "—"}]`);
      console.log(`     "${args.content}"`);
    } else if (tc.name === "done") {
      console.log(`  ✓ done`);
    }
  }
}

// Show reconciliation results
const reconcileTurns = result.turns.filter((t: any) => t._pipeline === "reconcile");
if (reconcileTurns.length > 0 || result.contradictions?.length) {
  console.log("\n── Reconciliation ────────────────────────────────────────");
  for (const turn of reconcileTurns) {
    console.log(`  SUPERSEDED: ${turn.result?.result}`);
    const args = turn.tool_call.arguments as any;
    if (args.reason) console.log(`     reason: ${args.reason}`);
  }
  if (result.contradictions?.length) {
    for (const c of result.contradictions) {
      console.log(`  CONTRADICTION detected:`);
      console.log(`     New: "${c.newContent}"`);
      console.log(`     Old: "${c.oldContent}"`);
      console.log(`     Q:   ${c.question}`);
    }
  }
}

// Count nodes after
const dbAfter = new Database(DB_PATH, { readonly: true });
const countAfter = (dbAfter.query("SELECT COUNT(*) as c FROM nodes").get() as any).c;
dbAfter.close();

// Timing & costs
const usage = getUsage();
console.log("\n── Summary ───────────────────────────────────────────────");
console.log(`  Nodes: ${countBefore} → ${countAfter} (${countAfter - countBefore > 0 ? "+" : ""}${countAfter - countBefore})`);
console.log(`  Timing: plan=${result.timing?.plan_ms || 0}ms search=${result.timing?.search_ms || 0}ms curate=${result.timing?.curate_ms || 0}ms filter=${result.timing?.filter_ms || 0}ms store=${result.timing?.store_ms || 0}ms reconcile=${result.timing?.reconcile_ms || 0}ms`);
console.log(`  Tokens: L1=${usage.l1_input || 0}/${usage.l1_output || 0} L2=${usage.l2_input || 0}/${usage.l2_output || 0} Curate=${usage.curate_input || 0}/${usage.curate_output || 0} Reconcile=${usage.reconcile_input || 0}/${usage.reconcile_output || 0}`);
console.log();
