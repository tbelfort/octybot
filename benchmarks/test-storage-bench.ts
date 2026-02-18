/**
 * Storage Benchmark — 30 queries testing the full memory pipeline's storage decisions.
 * Tests that the system correctly stores new info and correctly ignores questions/small talk.
 *
 * Usage:
 *   bun test-storage-bench.ts
 *   bun test-storage-bench.ts --only S01,S05,S22
 */
import { classify } from "../src/memory/layer1";
import { agenticLoop } from "../src/memory/layer2";
import { getDb } from "../src/memory/db-core";
import { resetUsage, getUsage } from "../src/memory/usage-tracker";
import { scoreStorageResult, parseOnlyFlag } from "./bench-utils";
import Database from "bun:sqlite";

const DB_PATH = process.env.DB_PATH || `${process.env.HOME}/.octybot/test/memory.db`;
process.env.DB_PATH = DB_PATH;

// ── Query definitions ──────────────────────────────────────────────────

interface StorageQuery {
  id: string;
  prompt: string;
  should_store: boolean;
  // For store=true: what types of nodes we expect to see created
  expected_types?: string[];  // e.g. ["event", "instruction", "entity"]
  // Keywords that MUST appear across the stored content
  expected_keywords?: string[];
  // Description of what should happen
  description: string;
}

const ALL_QUERIES: StorageQuery[] = [
  // ── Should STORE (S01–S15) ──────────────────────────────────────────

  { id: "S01",
    prompt: "Peter just finished 3 articles for Anderson ahead of schedule",
    should_store: true,
    expected_types: ["event"],
    expected_keywords: ["Peter", "Anderson", "3 articles"],
    description: "Concrete event — Peter completed work early",
  },
  { id: "S02",
    prompt: "From now on, all articles need to be at least 1500 words minimum",
    should_store: true,
    expected_types: ["instruction"],
    expected_keywords: ["1500"],
    description: "New global rule — minimum word count",
  },
  { id: "S03",
    prompt: "Dave is going on holiday on the 3rd of March, Peter will cover his Brightwell articles",
    should_store: true,
    expected_types: ["event"],
    expected_keywords: ["Dave", "Peter", "Brightwell"],
    description: "Upcoming event with specific date — coverage change",
  },
  { id: "S04",
    prompt: "I think Sarah is doing an amazing job managing quality control this quarter",
    should_store: true,
    expected_types: ["opinion"],
    expected_keywords: ["Sarah"],
    description: "User opinion about Sarah's performance",
  },
  { id: "S05",
    prompt: "We've decided to use Grammarly as an additional editing tool for all writers",
    should_store: true,
    expected_types: ["instruction", "entity"],
    expected_keywords: ["Grammarly"],
    description: "New tool adoption — entity + instruction",
  },
  { id: "S06",
    prompt: "Marcus just signed a new client called TechForge — they want 10 articles per month on cybersecurity topics at £200 per article",
    should_store: true,
    expected_types: ["entity", "fact"],
    expected_keywords: ["TechForge", "10 articles", "cybersecurity"],
    description: "New client entity with facts",
  },
  { id: "S07",
    prompt: "The Anderson retainer is increasing to £5,000 starting next month",
    should_store: true,
    expected_types: ["fact"],
    expected_keywords: ["Anderson", "5,000"],
    description: "Factual update — price change for existing client",
  },
  { id: "S08",
    prompt: "Remember, never use stock photos in Meridian Health articles — they require original imagery only",
    should_store: true,
    expected_types: ["instruction"],
    expected_keywords: ["Meridian", "stock photo"],
    description: "Client-specific rule — Meridian imagery requirement",
  },
  { id: "S09",
    prompt: "Lisa created a new Airtable view called 'Overdue' to track late assignments",
    should_store: true,
    expected_types: ["fact"],
    expected_keywords: ["Lisa", "Airtable", "Overdue"],
    description: "Fact — new tool feature exists",
  },
  { id: "S10",
    prompt: "Dave's writing has really improved this quarter — his Surfer scores are now averaging 82",
    should_store: true,
    expected_types: ["opinion", "fact"],
    expected_keywords: ["Dave", "82"],
    description: "Opinion + factual update about Dave's improvement",
  },
  { id: "S11",
    prompt: "We're switching from WordPress to Webflow for Canopy Digital's site",
    should_store: true,
    expected_types: ["fact"],
    expected_keywords: ["Webflow", "Canopy"],
    description: "Tool/platform change for specific client",
  },
  { id: "S12",
    prompt: "All writers must now submit a brief outline to Sarah before starting any article",
    should_store: true,
    expected_types: ["instruction"],
    expected_keywords: ["outline", "Sarah"],
    description: "New process rule — outline requirement",
  },
  { id: "S13",
    prompt: "Peter negotiated a raise to £250 per article, effective immediately",
    should_store: true,
    expected_types: ["fact"],
    expected_keywords: ["Peter", "250"],
    description: "Factual update — Peter's new rate",
  },
  { id: "S14",
    prompt: "Brightwell wants to add video scripts to their content package starting next month",
    should_store: true,
    expected_types: ["fact"],
    expected_keywords: ["Brightwell", "video"],
    description: "Fact — client desire for new content type",
  },
  { id: "S15",
    prompt: "I feel like we're taking on too many clients for our current team size",
    should_store: true,
    expected_types: ["opinion"],
    expected_keywords: ["too many clients"],
    description: "User opinion about capacity",
  },

  // ── Should NOT store (S16–S30) ──────────────────────────────────────

  { id: "S16",
    prompt: "Who writes for Anderson?",
    should_store: false,
    description: "Simple entity question",
  },
  { id: "S17",
    prompt: "What's Dave's average Surfer score?",
    should_store: false,
    description: "Factual question about existing data",
  },
  { id: "S18",
    prompt: "How do I publish an article to a client site?",
    should_store: false,
    description: "Process question — asking, not telling",
  },
  { id: "S19",
    prompt: "Hey, good morning!",
    should_store: false,
    description: "Greeting — no information content",
  },
  { id: "S20",
    prompt: "What clients do we have?",
    should_store: false,
    description: "Entity lookup question",
  },
  { id: "S21",
    prompt: "Can you remind me of Sarah's role?",
    should_store: false,
    description: "Entity question about existing person",
  },
  { id: "S22",
    prompt: "If we hired another writer, who would they report to?",
    should_store: false,
    description: "Hypothetical — not a real event or fact",
  },
  { id: "S23",
    prompt: "What's the content creation workflow?",
    should_store: false,
    description: "Process question",
  },
  { id: "S24",
    prompt: "Tell me about Meridian Health",
    should_store: false,
    description: "Entity lookup — asking for info",
  },
  { id: "S25",
    prompt: "When is the next GSC report due?",
    should_store: false,
    description: "Schedule question",
  },
  { id: "S26",
    prompt: "How many articles does Brightwell get per month?",
    should_store: false,
    description: "Factual question about existing data",
  },
  { id: "S27",
    prompt: "What tools do we use for content checking?",
    should_store: false,
    description: "Entity/tool lookup question",
  },
  { id: "S28",
    prompt: "Is Peter faster than Dave?",
    should_store: false,
    description: "Comparative question",
  },
  { id: "S29",
    prompt: "What would happen if Dave missed another deadline?",
    should_store: false,
    description: "Hypothetical question",
  },
  { id: "S30",
    prompt: "Thanks for the help, that's all for now!",
    should_store: false,
    description: "Small talk / sign-off",
  },
];

// ── Scoring ──────────────────────────────────────────────────────────

interface QueryResult {
  id: string;
  prompt: string;
  should_store: boolean;
  did_store: boolean;
  stored_nodes: { type: string; subtype: string; content: string; scope?: number }[];
  expected_types?: string[];
  expected_keywords?: string[];
  type_hits: string[];
  type_misses: string[];
  keyword_hits: string[];
  keyword_misses: string[];
  pass: boolean;
  failure_reason?: string;
  nodes_before: number;
  nodes_after: number;
  timing: any;
}


// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  const onlyIds = parseOnlyFlag(process.argv);
  const queries = onlyIds ? ALL_QUERIES.filter(q => onlyIds.has(q.id)) : ALL_QUERIES;

  const BATCH_SIZE = 6; // Lower than curation — storage mutates DB, be careful with concurrency
  const FREEZE_NAME = "storage-test-1";

  console.log(`Storage Benchmark — ${queries.length} queries`);
  console.log(`DB: ${DB_PATH}`);
  console.log(`Freeze: ${FREEZE_NAME} (restored before each store query)\n`);

  const results: QueryResult[] = [];
  let totalPass = 0;
  let totalFail = 0;

  for (let i = 0; i < queries.length; i += BATCH_SIZE) {
    const batch = queries.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(batch.map(async (q) => {
      // Restore DB to clean state before each query so they don't affect each other
      const restoreDb = new Database(
        `${process.env.HOME}/.octybot/test/snapshots/small-baseline/${FREEZE_NAME}.db`,
        { readonly: true }
      );
      const activeDb = new Database(DB_PATH);
      activeDb.exec("DELETE FROM nodes");
      activeDb.exec("DELETE FROM edges");
      activeDb.exec("DELETE FROM embeddings");
      // Copy from snapshot
      const nodes = restoreDb.query("SELECT * FROM nodes").all() as any[];
      const edges = restoreDb.query("SELECT * FROM edges").all() as any[];
      const embeddings = restoreDb.query("SELECT * FROM embeddings").all() as any[];

      if (nodes.length > 0) {
        const cols = Object.keys(nodes[0]);
        const placeholders = cols.map(() => "?").join(",");
        const insertNode = activeDb.prepare(`INSERT OR REPLACE INTO nodes (${cols.join(",")}) VALUES (${placeholders})`);
        for (const n of nodes) insertNode.run(...cols.map(c => n[c]));
      }
      if (edges.length > 0) {
        const cols = Object.keys(edges[0]);
        const placeholders = cols.map(() => "?").join(",");
        const insertEdge = activeDb.prepare(`INSERT OR REPLACE INTO edges (${cols.join(",")}) VALUES (${placeholders})`);
        for (const e of edges) insertEdge.run(...cols.map(c => e[c]));
      }
      if (embeddings.length > 0) {
        const cols = Object.keys(embeddings[0]);
        const placeholders = cols.map(() => "?").join(",");
        const insertEmb = activeDb.prepare(`INSERT OR REPLACE INTO embeddings (${cols.join(",")}) VALUES (${placeholders})`);
        for (const e of embeddings) insertEmb.run(...cols.map(c => e[c]));
      }

      const nodesBefore = (activeDb.query("SELECT COUNT(*) as c FROM nodes").get() as any).c;
      restoreDb.close();
      activeDb.close();

      // Run pipeline
      const l1c = await classify(q.prompt);
      const l1 = l1c.result;
      const result = await agenticLoop(getDb(), q.prompt, l1);

      // Collect stored nodes from tool calls
      const stored_nodes: QueryResult["stored_nodes"] = [];
      for (const turn of result.turns) {
        if ((turn as any)._pipeline === "store" && turn.tool_call.name === "store_memory") {
          const args = typeof turn.tool_call.arguments === "string"
            ? JSON.parse(turn.tool_call.arguments)
            : turn.tool_call.arguments;
          stored_nodes.push({
            type: args.type,
            subtype: args.subtype || "",
            content: args.content,
            scope: args.scope,
          });
        }
      }

      const did_store = stored_nodes.length > 0;
      const nodesAfterDb = new Database(DB_PATH, { readonly: true });
      const nodesAfter = (nodesAfterDb.query("SELECT COUNT(*) as c FROM nodes").get() as any).c;
      nodesAfterDb.close();

      const score = scoreStorageResult(q, did_store, stored_nodes);

      return {
        id: q.id,
        prompt: q.prompt,
        should_store: q.should_store,
        did_store,
        stored_nodes,
        expected_types: q.expected_types,
        expected_keywords: q.expected_keywords,
        ...score,
        nodes_before: nodesBefore,
        nodes_after: nodesAfter,
        timing: result.timing,
      } as QueryResult;
    }));

    for (const r of batchResults) {
      results.push(r);
      if (r.pass) totalPass++;
      else totalFail++;

      const icon = r.pass ? "✓" : "✗";
      const storeLabel = r.should_store
        ? (r.did_store ? `stored ${r.stored_nodes.length} nodes` : "MISSED (nothing stored)")
        : (r.did_store ? `LEAKED ${r.stored_nodes.length} nodes` : "correctly skipped");

      const kwInfo = r.keyword_misses.length > 0 ? ` | MISS: ${r.keyword_misses.join(", ")}` : "";
      const typeInfo = r.type_misses.length > 0 ? ` | missing types: ${r.type_misses.join(", ")}` : "";

      console.log(`  ${r.id}: ${icon} ${storeLabel} — "${r.prompt.slice(0, 55)}"${kwInfo}${typeInfo}`);
      if (r.failure_reason && !r.pass) {
        console.log(`       FAIL: ${r.failure_reason}`);
      }
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────
  const storeQueries = results.filter(r => r.should_store);
  const noStoreQueries = results.filter(r => !r.should_store);
  const storeCorrect = storeQueries.filter(r => r.did_store).length;
  const noStoreCorrect = noStoreQueries.filter(r => !r.did_store).length;
  const typeHitTotal = results.reduce((s, r) => s + r.type_hits.length, 0);
  const typeTotalExpected = results.reduce((s, r) => s + (r.expected_types?.length || 0), 0);
  const kwHitTotal = results.reduce((s, r) => s + r.keyword_hits.length, 0);
  const kwTotalExpected = results.reduce((s, r) => s + (r.expected_keywords?.length || 0), 0);

  console.log(`\n${"═".repeat(80)}`);
  console.log(`  STORAGE BENCHMARK SUMMARY (${queries.length} queries)`);
  console.log(`${"═".repeat(80)}`);
  console.log(`  Overall:         ${totalPass}/${queries.length} pass (${Math.round(totalPass / queries.length * 100)}%)`);
  console.log(`  Store decisions:  ${storeCorrect}/${storeQueries.length} correctly stored`);
  console.log(`  Skip decisions:   ${noStoreCorrect}/${noStoreQueries.length} correctly skipped`);
  console.log(`  Type accuracy:    ${typeHitTotal}/${typeTotalExpected} expected types found`);
  console.log(`  Keyword accuracy: ${kwHitTotal}/${kwTotalExpected} expected keywords found`);
  console.log(`${"═".repeat(80)}\n`);

  // Show failures
  const failures = results.filter(r => !r.pass);
  if (failures.length > 0) {
    console.log("  FAILURES:");
    for (const f of failures) {
      console.log(`    ${f.id}: ${f.failure_reason}`);
      if (f.stored_nodes.length > 0) {
        for (const n of f.stored_nodes) {
          console.log(`      → [${n.type}/${n.subtype}] "${n.content.slice(0, 80)}"`);
        }
      }
    }
    console.log();
  }

  // Show stored details for all store queries
  console.log("  STORE DETAILS:");
  for (const r of storeQueries) {
    const icon = r.pass ? "✓" : "✗";
    console.log(`    ${icon} ${r.id}: "${r.prompt.slice(0, 65)}"`);
    for (const n of r.stored_nodes) {
      console.log(`        [${n.type}/${n.subtype}${n.scope != null ? ` scope=${n.scope}` : ""}] "${n.content.slice(0, 90)}"`);
    }
    if (r.stored_nodes.length === 0) console.log(`        (nothing stored)`);
  }

  // Save results
  const usage = getUsage();
  const outDir = `${process.env.HOME}/.octybot/test/storage-benchmarks`;
  const fs = await import("fs");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = `${outDir}/${new Date().toISOString().replace(/[:.]/g, "-")}_storage-bench.json`;
  fs.writeFileSync(outPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    db: DB_PATH,
    total_queries: queries.length,
    pass: totalPass,
    fail: totalFail,
    store_correct: storeCorrect,
    skip_correct: noStoreCorrect,
    type_accuracy: `${typeHitTotal}/${typeTotalExpected}`,
    keyword_accuracy: `${kwHitTotal}/${kwTotalExpected}`,
    queries: results.map(r => ({
      id: r.id, prompt: r.prompt, should_store: r.should_store, did_store: r.did_store,
      pass: r.pass, failure_reason: r.failure_reason,
      stored_nodes: r.stored_nodes, timing: r.timing,
    })),
  }, null, 2));
  console.log(`\nResults saved to: ${outPath}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
