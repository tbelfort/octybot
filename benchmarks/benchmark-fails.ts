/**
 * Focused benchmark — only the failing/flaky queries from the full benchmark.
 * Use this to iterate quickly on fixes.
 *
 * Usage: bun pa-test-1/benchmark-fails.ts
 */
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { classify } from "../src/memory/layer1";
import { agenticLoop } from "../src/memory/layer2";
import { getDb, closeDb } from "../src/memory/db-core";
import { createNode as _createNode, createEdge as _createEdge } from "../src/memory/db-crud";
import { storeEmbedding as _storeEmbedding } from "../src/memory/vectors";
import { embed } from "../src/memory/voyage";

// Bind db to CRUD functions (db is initialized in seedDb)
const createNode = (node: Parameters<typeof _createNode>[1]) => _createNode(getDb(), node);
const createEdge = (edge: Parameters<typeof _createEdge>[1]) => _createEdge(getDb(), edge);
const storeEmbedding = (nodeId: string, nodeType: string, vec: number[]) => _storeEmbedding(getDb(), nodeId, nodeType, vec);
import { DB_PATH, LAYER1_MODEL, LAYER2_MODEL } from "../src/memory/config";
import type { Layer1Result, ToolTurn } from "../src/memory/types";
import { normalize } from "./bench-utils";

// ── Failing queries from 20K run (#11) ───────────────────────────────
// Pattern A: L2 returns 0 tool calls (model answers without searching)
// Pattern B: Detail loss (model finds info but drops specifics in done())
// Pattern C: L1 JSON parse error (OSS-120B truncates output)

const RETRIEVAL_FAILS = [
  // Pattern A: no_tool_calls
  {
    id: "R01-person-peter",
    prompt: "Who is Peter?",
    description: "Pattern A: L2 returned 1 call, no_tool_calls — missed 'content writer'",
    expectedInContext: ["Peter", "content writer"],
  },
  {
    id: "R28-rules-reports",
    prompt: "When are GSC reports due?",
    description: "Pattern A: L2 returned 0 calls — missed '5th' and 'Marcus'",
    expectedInContext: ["5th", "Marcus"],
  },
  {
    id: "R32-pricing",
    prompt: "What do we charge per article?",
    description: "Pattern A: L2 returned 1 call, no_tool_calls — missed '400'",
    expectedInContext: ["200", "400"],
  },
  {
    id: "R34-multihop-who-manages-client",
    prompt: "Who should I talk to about Anderson's day-to-day needs?",
    description: "Pattern A: L2 returned 0 calls — missed 'Lisa'",
    expectedInContext: ["Lisa"],
  },
  // Pattern B: detail loss
  {
    id: "R27-rules-deadline",
    prompt: "What happens when a writer misses a deadline?",
    description: "Pattern B: 7 calls, done_tool but missed '24 hours' detail",
    expectedInContext: ["notify", "24 hours"],
  },
];

const STORE_RETRIEVE_FAILS = [
  // Pattern B: detail loss on retrieve
  {
    id: "S06-new-process",
    store: "To request time off, send a message in #general on Slack at least 5 days in advance and tag Marcus.",
    retrieve: "How do I request time off?",
    description: "Pattern B: stored OK, retrieve missed '5 days'",
    expectedInContext: ["Slack", "5 days", "Marcus"],
  },
  {
    id: "S07-new-client",
    store: "Nexus Fintech signed up yesterday. They want 10 articles per month about cryptocurrency regulation. Monthly retainer is £2,500.",
    retrieve: "Tell me about the Nexus Fintech account",
    description: "Pattern B: stored OK, retrieve missed 'cryptocurrency' and '2,500'",
    expectedInContext: ["Nexus", "cryptocurrency", "2,500"],
  },
  // Pattern C: L1 parse error
  {
    id: "S09-incident",
    store: "Dave accidentally published an unfinished draft to the Brightwell WordPress site. Sarah caught it and took it down within an hour.",
    retrieve: "What happened with the Brightwell site today?",
    description: "Pattern C: L1 parse error on retrieve — model output truncated",
    expectedInContext: ["unfinished draft", "Sarah"],
  },
  // Pattern A: no_tool_calls on retrieve
  {
    id: "S10-pricing-update",
    store: "We're raising our standard article price from £200 to £250 starting next month.",
    retrieve: "What's our article pricing?",
    description: "Pattern A: stored OK, but retrieve returned 0 calls — missed '250'",
    expectedInContext: ["250"],
  },
];

// ── Runner ───────────────────────────────────────────────────────────

interface Result {
  id: string;
  prompt: string;
  description: string;
  layer1: Layer1Result;
  turns: ToolTurn[];
  context: string;
  duration_ms: number;
  hits: string[];
  misses: string[];
  terminated_by: string;
}

async function runQuery(
  id: string, prompt: string, description: string, expected: string[]
): Promise<Result> {
  const start = Date.now();
  const l1c = await classify(prompt);
  const l1 = l1c.result;

  let context = "";
  let turns: ToolTurn[] = [];
  let terminated_by = "skipped";

  if (l1.operations.retrieve || l1.operations.store) {
    const result = await agenticLoop(getDb(), prompt, l1);
    context = result.context;
    turns = result.turns;
    const last = turns[turns.length - 1];
    terminated_by = last?.tool_call.name === "done" ? "done_tool"
      : turns.length >= 8 ? "max_turns" : "no_tool_calls";
  }

  const cn = normalize(context);
  const hits = expected.filter((s) => cn.includes(normalize(s)));
  const misses = expected.filter((s) => !cn.includes(normalize(s)));

  return { id, prompt, description, layer1: l1, turns, context, duration_ms: Date.now() - start, hits, misses, terminated_by };
}

function printResult(r: Result, expected: string[]) {
  const pct = expected.length > 0 ? Math.round((r.hits.length / expected.length) * 100) : 100;
  const icon = pct === 100 ? "\x1b[32m✓\x1b[0m" : pct > 0 ? "\x1b[33m~\x1b[0m" : "\x1b[31m✗\x1b[0m";
  console.log(`  ${icon} ${r.id}: ${pct}% (${r.hits.length}/${expected.length}), ${r.turns.length} calls, ${r.terminated_by}, ${r.duration_ms}ms`);
  if (r.misses.length > 0) console.log(`    \x1b[31mmisses: ${r.misses.join(", ")}\x1b[0m`);

  // Show L1 classification
  console.log(`    L1: intents=${JSON.stringify(r.layer1.intents)} ops=${JSON.stringify(r.layer1.operations)}`);
  console.log(`    L1 entities: ${r.layer1.entities.map(e => e.name).join(", ") || "(none)"}`);

  // Show tool calls
  for (const t of r.turns) {
    const args = JSON.stringify(t.tool_call.arguments);
    const res = typeof t.result.result === "string" ? t.result.result.slice(0, 120) : String(t.result.result);
    const pipeline = (t as any)._pipeline ? `[${(t as any)._pipeline}]` : "";
    console.log(`    ${pipeline} ${t.tool_call.name}(${args.slice(0, 80)}) → ${res}`);
  }

  // Show final context (truncated)
  if (r.context) {
    console.log(`    context: "${r.context.slice(0, 200)}${r.context.length > 200 ? "..." : ""}"`);
  }
  console.log();
}

// ── Seed (same as full benchmark) ────────────────────────────────────

async function seedDb() {
  getDb();

  const peterId = createNode({ node_type: "entity", subtype: "person", content: "Peter — senior content writer at WOBS. Writes articles for client orders. Very reliable, produces ~8 articles per week. Specializes in tech and SaaS content.", salience: 1.3, confidence: 1.0, source: "user", attributes: { aliases: ["Pete"] } });
  const daveId = createNode({ node_type: "entity", subtype: "person", content: "Dave — junior content writer at WOBS. Slower than Peter, produces about 4 articles per week. Good at health and wellness topics. Started 3 months ago.", salience: 1.0, confidence: 1.0, source: "user", attributes: {} });
  const sarahId = createNode({ node_type: "entity", subtype: "person", content: "Sarah — editor and QA lead at WOBS. Reviews all articles before publishing. Also manages the Surfer SEO optimization process.", salience: 1.1, confidence: 1.0, source: "user", attributes: {} });
  const marcusId = createNode({ node_type: "entity", subtype: "person", content: "Marcus — co-founder and operations manager at WOBS. Handles client relationships, pricing, and overall business strategy. The user's business partner.", salience: 1.3, confidence: 1.0, source: "user", attributes: { aliases: ["Marc"] } });
  const lisaId = createNode({ node_type: "entity", subtype: "person", content: "Lisa — client account manager at WOBS. Handles day-to-day client communication, manages the Airtable order tracker, and coordinates deadlines.", salience: 1.0, confidence: 1.0, source: "user", attributes: {} });
  const jamesId = createNode({ node_type: "entity", subtype: "person", content: "James — freelance link builder contracted by WOBS. Works remotely from Portugal. Handles outreach and guest post placements for all clients.", salience: 1.0, confidence: 1.0, source: "user", attributes: { aliases: ["Jim"] } });
  const wobsId = createNode({ node_type: "entity", subtype: "org", content: "WOBS (Wolf of Blog Street) — a content marketing agency that does link building and content marketing for clients. Founded by Marcus and the user. Team of 6 people. Based in London but mostly remote.", salience: 1.3, confidence: 1.0, source: "user", attributes: { aliases: ["Wolf of Blog Street"] } });
  const andersonId = createNode({ node_type: "entity", subtype: "project", content: "Anderson — a client project at WOBS. Mid-size SaaS company. Order involves 20 articles per month on cloud infrastructure topics. Peter is the primary writer. Monthly retainer: £4,000.", salience: 1.1, confidence: 1.0, source: "user", attributes: {} });
  const brightwellId = createNode({ node_type: "entity", subtype: "project", content: "Brightwell — a client project at WOBS. Health supplement company. Order involves 12 articles per month on wellness topics. Dave is the primary writer. Monthly retainer: £2,400.", salience: 1.0, confidence: 1.0, source: "user", attributes: {} });
  const meridianId = createNode({ node_type: "entity", subtype: "project", content: "Meridian Health — a client project at WOBS. Private hospital chain. Sensitive content requiring medical accuracy review. 8 articles per month. Peter and Dave split the writing. Monthly retainer: £3,200.", salience: 1.1, confidence: 1.0, source: "user", attributes: {} });
  const canopyId = createNode({ node_type: "entity", subtype: "project", content: "Canopy Digital — newest client at WOBS. Digital marketing agency that wants white-label content. 15 articles per month across various niches. Started 2 weeks ago. Monthly retainer: £3,000.", salience: 1.0, confidence: 1.0, source: "user", attributes: {} });
  const airtableId = createNode({ node_type: "entity", subtype: "tool", content: "Airtable — the main order tracking and project management tool at WOBS. Contains all client orders, article assignments, deadlines, and status tracking. Lisa manages the base.", salience: 1.5, confidence: 1.0, source: "user", attributes: {} });
  const wordpressId = createNode({ node_type: "entity", subtype: "tool", content: "WordPress — the CMS used for publishing articles to client sites. Each client has their own WordPress instance. WOBS team has editor-level access.", salience: 1.5, confidence: 1.0, source: "user", attributes: {} });
  const surferId = createNode({ node_type: "entity", subtype: "tool", content: "Surfer SEO — content optimization tool used at WOBS. Every article must score at least 75/100 on Surfer before publishing. Sarah runs the Surfer checks.", salience: 1.5, confidence: 1.0, source: "user", attributes: {} });
  const originalityId = createNode({ node_type: "entity", subtype: "tool", content: "Originality.ai — AI detection tool used at WOBS. All content must score above 80% original before client delivery.", salience: 1.5, confidence: 1.0, source: "user", attributes: {} });
  const gscId = createNode({ node_type: "entity", subtype: "tool", content: "Google Search Console (GSC) — used to monitor SEO performance of published articles. Monthly reports pulled from GSC for each client. Marcus reviews the reports.", salience: 1.5, confidence: 1.0, source: "user", attributes: { aliases: ["GSC"] } });
  const slackId = createNode({ node_type: "entity", subtype: "tool", content: "Slack — team communication tool at WOBS. Channels: #general, #orders, #content-review, #client-updates. All urgent issues go to #orders.", salience: 1.0, confidence: 1.0, source: "user", attributes: {} });

  // Facts
  const factsData = [
    { c: "Peter writes content for WOBS clients, primarily Anderson and Meridian Health", sub: "definitional", sal: 0.9, links: [{ t: peterId, e: "about" }, { t: wobsId, e: "about" }] },
    { c: "Dave writes content for WOBS clients, primarily Brightwell and some Meridian Health articles", sub: "definitional", sal: 0.9, links: [{ t: daveId, e: "about" }, { t: wobsId, e: "about" }] },
    { c: "Sarah reviews and edits all articles before they go to clients. She is the final quality gate.", sub: "definitional", sal: 0.9, links: [{ t: sarahId, e: "about" }] },
    { c: "Lisa manages the Airtable order tracker and is the primary contact for day-to-day client requests", sub: "definitional", sal: 0.9, links: [{ t: lisaId, e: "about" }, { t: airtableId, e: "about" }] },
    { c: "Marcus handles pricing negotiations and big-picture client strategy. He reviews monthly GSC reports.", sub: "definitional", sal: 0.9, links: [{ t: marcusId, e: "about" }] },
    { c: "James does all link building outreach. He places about 30 guest posts per month across all clients.", sub: "definitional", sal: 0.9, links: [{ t: jamesId, e: "about" }] },
    { c: "WOBS total monthly revenue is approximately £12,600 across all four clients", sub: "definitional", sal: 1.2, links: [{ t: wobsId, e: "about" }] },
    { c: "WOBS charges £200 per article for standard content and £400 per article for medical/healthcare content", sub: "definitional", sal: 1.2, links: [{ t: wobsId, e: "about" }] },
    { c: "Meridian Health articles require an additional medical accuracy review step that other clients don't need", sub: "conditional", sal: 0.9, links: [{ t: meridianId, e: "about" }] },
    { c: "Canopy Digital is a white-label client, meaning WOBS content is published under Canopy's brand without WOBS attribution", sub: "definitional", sal: 0.9, links: [{ t: canopyId, e: "about" }] },
    { c: "Peter's articles consistently score above 85 on Surfer SEO and above 90% original on Originality.ai", sub: "comparative", sal: 0.9, links: [{ t: peterId, e: "about" }, { t: surferId, e: "about" }] },
    { c: "Dave's articles sometimes need revision — his Surfer scores average around 70, which is below the 75 threshold", sub: "comparative", sal: 0.9, links: [{ t: daveId, e: "about" }, { t: surferId, e: "about" }] },
    { c: "Link building costs WOBS about £50 per placement. James invoices monthly.", sub: "definitional", sal: 0.9, links: [{ t: jamesId, e: "about" }, { t: wobsId, e: "about" }] },
    { c: "Anderson is the longest-standing client, been with WOBS for 14 months", sub: "definitional", sal: 0.9, links: [{ t: andersonId, e: "about" }] },
    { c: "Brightwell's contract is up for renewal next month. They've hinted they might increase to 20 articles per month.", sub: "conditional", sal: 0.9, links: [{ t: brightwellId, e: "about" }] },
  ];
  const factIds: string[] = [];
  for (const f of factsData) {
    const id = createNode({ node_type: "fact", subtype: f.sub, content: f.c, salience: f.sal, confidence: 1.0, source: "user", attributes: {} });
    factIds.push(id);
    for (const l of f.links) createEdge({ source_id: id, target_id: l.t, edge_type: l.e });
  }

  // Events
  const eventsData = [
    { c: "Peter submitted 8 articles for the Anderson order on Tuesday", sub: "action", sal: 0.6, links: [{ t: peterId, e: "about" }, { t: andersonId, e: "about" }] },
    { c: "Dave missed the Brightwell deadline last Friday — 3 articles were late by 2 days", sub: "incident", sal: 1.0, links: [{ t: daveId, e: "about" }, { t: brightwellId, e: "about" }] },
    { c: "Sarah flagged 2 of Dave's Meridian Health articles for medical inaccuracy on Monday", sub: "incident", sal: 1.0, links: [{ t: sarahId, e: "about" }, { t: daveId, e: "about" }, { t: meridianId, e: "about" }] },
    { c: "Marcus had a call with Anderson's CEO on Wednesday — they're happy with content quality and want to explore video content too", sub: "conversation", sal: 0.6, links: [{ t: marcusId, e: "about" }, { t: andersonId, e: "about" }] },
    { c: "Canopy Digital onboarded last week. Lisa set up their Airtable workspace and WordPress access.", sub: "action", sal: 0.6, links: [{ t: canopyId, e: "about" }, { t: lisaId, e: "about" }] },
    { c: "James placed 12 guest posts for Anderson last month, which is above the target of 10", sub: "outcome", sal: 0.6, links: [{ t: jamesId, e: "about" }, { t: andersonId, e: "about" }] },
    { c: "One of Peter's Anderson articles went viral on LinkedIn last week — got 2,000+ shares", sub: "outcome", sal: 1.0, links: [{ t: peterId, e: "about" }, { t: andersonId, e: "about" }] },
    { c: "Brightwell complained about a factual error in a published article on Wednesday. Dave wrote the article.", sub: "incident", sal: 1.0, links: [{ t: brightwellId, e: "about" }, { t: daveId, e: "about" }] },
  ];
  const eventIds: string[] = [];
  for (const e of eventsData) {
    const id = createNode({ node_type: "event", subtype: e.sub, content: e.c, salience: e.sal, confidence: 1.0, source: "user", attributes: {} });
    eventIds.push(id);
    for (const l of e.links) createEdge({ source_id: id, target_id: l.t, edge_type: l.e });
  }

  // Instructions
  const instrData = [
    { c: "Always check AI detection using Originality.ai before submitting content to clients. Score must be above 80% original.", sal: 2.5, scope: 1.0, links: [{ t: originalityId, e: "about" }, { t: wobsId, e: "about" }] },
    { c: "Every article must score at least 75/100 on Surfer SEO before publishing. If it's below 75, send it back to the writer for optimization.", sal: 2.5, scope: 1.0, links: [{ t: surferId, e: "about" }] },
    { c: "Never publish an article without Sarah's approval. She must sign off on every piece before it goes live.", sal: 2.5, scope: 1.0, links: [{ t: sarahId, e: "about" }] },
    { c: "Meridian Health articles require an additional step: after Sarah's review, send the article to Meridian's in-house medical reviewer for accuracy sign-off before publishing.", sal: 2.0, scope: 0.3, links: [{ t: meridianId, e: "about" }] },
    { c: "All client communication should go through Lisa unless it's a strategic/pricing discussion, which Marcus handles.", sal: 2.0, scope: 0.9, links: [{ t: lisaId, e: "about" }, { t: marcusId, e: "about" }] },
    { c: "When a writer misses a deadline, immediately notify the client through Lisa and offer expedited delivery within 24 hours.", sal: 2.0, scope: 0.9, links: [{ t: lisaId, e: "about" }] },
    { c: "Monthly GSC reports must be sent to clients by the 5th of each month. Marcus reviews them before they go out.", sal: 2.0, scope: 0.8, links: [{ t: gscId, e: "about" }, { t: marcusId, e: "about" }] },
    { c: "For white-label clients like Canopy Digital, never include any WOBS branding, watermarks, or attribution in the content.", sal: 2.0, scope: 0.3, links: [{ t: canopyId, e: "about" }] },
  ];
  for (const i of instrData) {
    const id = createNode({ node_type: "instruction", subtype: "instruction", content: i.c, salience: i.sal, confidence: 1.0, source: "user", attributes: {}, scope: i.scope });
    for (const l of i.links) createEdge({ source_id: id, target_id: l.t, edge_type: l.e });
  }

  // Processes
  const procData = [
    { c: "To look up an order in Airtable: Open the WOBS Orders base → go to the 'Active Orders' view → filter by client name.", sal: 1.8, scope: 0.5, links: [{ t: airtableId, e: "about" }] },
    { c: "Content creation workflow at WOBS: 1) Lisa creates the assignment in Airtable with keyword and deadline. 2) Writer drafts the article. 3) Writer submits to Sarah for review. 4) Sarah checks quality, Surfer score, and Originality score. 5) If passes, Sarah publishes to WordPress. 6) Lisa updates Airtable status.", sal: 1.8, scope: 0.7, links: [{ t: wobsId, e: "about" }, { t: airtableId, e: "about" }, { t: wordpressId, e: "about" }] },
  ];
  for (const p of procData) {
    const id = createNode({ node_type: "instruction", subtype: "tool_usage", content: p.c, salience: p.sal, confidence: 1.0, source: "user", attributes: {}, scope: p.scope });
    for (const l of p.links) createEdge({ source_id: id, target_id: l.t, edge_type: l.e });
  }

  // Opinions
  const opinData = [
    { c: "I think Dave needs more training before handling Meridian Health articles — the medical inaccuracy issues are concerning", sal: 1.0, links: [{ t: daveId, e: "about" }, { t: meridianId, e: "about" }] },
    { c: "Canopy Digital might be more trouble than they're worth — the white-label requirement adds complexity and they're paying standard rates", sal: 1.0, links: [{ t: canopyId, e: "about" }] },
  ];
  for (const o of opinData) {
    const id = createNode({ node_type: "opinion", subtype: "user_opinion", content: o.c, salience: o.sal, confidence: 1.0, source: "user", attributes: {} });
    for (const l of o.links) createEdge({ source_id: id, target_id: l.t, edge_type: l.e });
  }

  // Structural edges
  const se = [
    { s: peterId, t: wobsId, e: "works_for" }, { s: daveId, t: wobsId, e: "works_for" },
    { s: sarahId, t: wobsId, e: "works_for" }, { s: marcusId, t: wobsId, e: "co_founder_of" },
    { s: lisaId, t: wobsId, e: "works_for" }, { s: jamesId, t: wobsId, e: "contracted_by" },
    { s: peterId, t: andersonId, e: "writes_for" }, { s: peterId, t: meridianId, e: "writes_for" },
    { s: daveId, t: brightwellId, e: "writes_for" }, { s: daveId, t: meridianId, e: "writes_for" },
    { s: sarahId, t: andersonId, e: "reviews_for" }, { s: sarahId, t: brightwellId, e: "reviews_for" },
    { s: sarahId, t: meridianId, e: "reviews_for" }, { s: sarahId, t: canopyId, e: "reviews_for" },
    { s: lisaId, t: andersonId, e: "manages" }, { s: lisaId, t: brightwellId, e: "manages" },
    { s: lisaId, t: meridianId, e: "manages" }, { s: lisaId, t: canopyId, e: "manages" },
    { s: andersonId, t: wobsId, e: "client_of" }, { s: brightwellId, t: wobsId, e: "client_of" },
    { s: meridianId, t: wobsId, e: "client_of" }, { s: canopyId, t: wobsId, e: "client_of" },
    { s: airtableId, t: wobsId, e: "used_by" }, { s: surferId, t: wobsId, e: "used_by" },
    { s: originalityId, t: wobsId, e: "used_by" }, { s: slackId, t: wobsId, e: "used_by" },
    { s: lisaId, t: airtableId, e: "manages" }, { s: sarahId, t: surferId, e: "manages" },
  ];
  for (const e of se) createEdge({ source_id: e.s, target_id: e.t, edge_type: e.e });

  // Embeddings
  const allNodes = [
    { id: peterId, type: "entity", text: "Peter — senior content writer at WOBS, tech/SaaS, 8 articles/week" },
    { id: daveId, type: "entity", text: "Dave — junior content writer at WOBS, health/wellness, 4 articles/week" },
    { id: sarahId, type: "entity", text: "Sarah — editor and QA lead at WOBS, reviews articles, Surfer SEO" },
    { id: marcusId, type: "entity", text: "Marcus — co-founder and ops manager at WOBS, clients and strategy" },
    { id: lisaId, type: "entity", text: "Lisa — account manager at WOBS, Airtable orders, client communication" },
    { id: jamesId, type: "entity", text: "James — freelance link builder for WOBS, Portugal, guest posts" },
    { id: wobsId, type: "entity", text: "WOBS Wolf of Blog Street — content marketing agency, link building" },
    { id: andersonId, type: "entity", text: "Anderson — SaaS client at WOBS, 20 articles/month, Peter writes" },
    { id: brightwellId, type: "entity", text: "Brightwell — health supplement client at WOBS, 12 articles/month, Dave writes" },
    { id: meridianId, type: "entity", text: "Meridian Health — hospital client at WOBS, 8 articles/month, medical review" },
    { id: canopyId, type: "entity", text: "Canopy Digital — white-label content client at WOBS, 15 articles/month, newest" },
    { id: airtableId, type: "entity", text: "Airtable — order tracking, project management, assignments, deadlines" },
    { id: surferId, type: "entity", text: "Surfer SEO — content optimization, score 75+ to pass" },
    { id: originalityId, type: "entity", text: "Originality.ai — AI detection, 80% original threshold" },
    { id: gscId, type: "entity", text: "Google Search Console GSC — SEO monitoring, monthly reports" },
    { id: slackId, type: "entity", text: "Slack — team communication, #general, #orders, #content-review" },
  ];
  for (const f of factsData) allNodes.push({ id: factIds[allNodes.length - 16], type: "fact", text: f.c });
  // Re-index properly
  const factNodeStart = 16;
  for (let i = 0; i < factsData.length; i++) allNodes[factNodeStart + i] = { id: factIds[i], type: "fact", text: factsData[i].c };
  for (let i = 0; i < eventsData.length; i++) allNodes.push({ id: eventIds[i], type: "event", text: eventsData[i].c });

  const texts = allNodes.map(n => n.text);
  const vectors = await embed(texts);
  for (let i = 0; i < allNodes.length; i++) {
    storeEmbedding(allNodes[i].id, allNodes[i].type, vectors[i]);
  }

  return allNodes.length;
}

// ── Main ─────────────────────────────────────────────────────────────

console.log(`\n── Fails-only Benchmark ──`);
console.log(`L1: ${LAYER1_MODEL.split("/").pop()} | L2: ${LAYER2_MODEL.split("/").pop()}\n`);

closeDb();
try { rmSync(DB_PATH); } catch {}
const count = await seedDb();
console.log(`Seeded ${count} nodes\n`);

// Run all retrieval queries in parallel
console.log(`── Retrieval (${RETRIEVAL_FAILS.length}) ──\n`);
const retrievalResults = await Promise.all(
  RETRIEVAL_FAILS.map(async (q) => {
    try {
      return { q, r: await runQuery(q.id, q.prompt, q.description, q.expectedInContext), err: null };
    } catch (err: any) {
      return { q, r: null, err };
    }
  })
);
for (const { q, r, err } of retrievalResults) {
  if (r) printResult(r, q.expectedInContext);
  else console.log(`  \x1b[31m✗ ${q.id}: ERROR: ${err.message}\x1b[0m\n`);
}

// Store → Retrieve: store phase in parallel, then retrieve phase in parallel
console.log(`── Store → Retrieve (${STORE_RETRIEVE_FAILS.length}) ──\n`);

// Phase 1: all stores in parallel
const storeResults = await Promise.all(
  STORE_RETRIEVE_FAILS.map(async (q) => {
    try {
      return { q, sr: await runQuery(`${q.id}-store`, q.store, `Store`, []), err: null };
    } catch (err: any) {
      return { q, sr: null, err };
    }
  })
);

// Phase 2: all retrieves in parallel
const retrieveAfterStoreResults = await Promise.all(
  storeResults.map(async ({ q, sr, err: storeErr }) => {
    if (storeErr) return { q, sr: null, rr: null, storeErr, retrieveErr: null };
    try {
      const rr = await runQuery(`${q.id}-retrieve`, q.retrieve, `Retrieve`, q.expectedInContext);
      return { q, sr, rr, storeErr: null, retrieveErr: null };
    } catch (err: any) {
      return { q, sr, rr: null, storeErr: null, retrieveErr: err };
    }
  })
);

// Print store→retrieve results in order
for (const { q, sr, rr, storeErr, retrieveErr } of retrieveAfterStoreResults) {
  console.log(`  ${q.id}: ${q.description}`);
  if (storeErr) {
    console.log(`    \x1b[31mSTORE ERROR: ${storeErr.message}\x1b[0m\n`);
    continue;
  }
  if (sr) {
    console.log(`    store: ${sr.turns.length} calls, ${sr.terminated_by}, ${sr.duration_ms}ms`);
    console.log(`    store L1: intents=${JSON.stringify(sr.layer1.intents)} ops=${JSON.stringify(sr.layer1.operations)}`);
    console.log(`    store L1 opinions: ${JSON.stringify(sr.layer1.opinions)}`);
    console.log(`    store L1 entities: ${sr.layer1.entities.map(e => e.name).join(", ") || "(none)"}`);
    for (const t of sr.turns) {
      const args = JSON.stringify(t.tool_call.arguments);
      const res = typeof t.result.result === "string" ? t.result.result.slice(0, 120) : String(t.result.result);
      const pipeline = (t as any)._pipeline ? `[${(t as any)._pipeline}]` : "";
      console.log(`      ${pipeline} ${t.tool_call.name}(${args.slice(0, 80)}) → ${res}`);
    }
  }
  if (retrieveErr) {
    console.log(`    \x1b[31mRETRIEVE ERROR: ${retrieveErr.message}\x1b[0m\n`);
  } else if (rr) {
    printResult(rr, q.expectedInContext);
  }
}

// Summary
const total = RETRIEVAL_FAILS.length + STORE_RETRIEVE_FAILS.length;
console.log(`\n── Done (${total} test cases) ──\n`);
