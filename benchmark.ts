/**
 * Model benchmark harness — runs a fixed set of queries, saves all results.
 *
 * Usage:
 *   bun pa-test-1/benchmark.ts                                     # defaults
 *   LAYER1=@cf/qwen/qwen3-30b-a3b-fp8 LAYER2=@cf/openai/gpt-oss-120b bun pa-test-1/benchmark.ts
 *   LAYER2=@cf/meta/llama-4-scout-17b-16e-instruct bun pa-test-1/benchmark.ts
 *
 * Output: ~/.octybot/test/benchmarks/<timestamp>-<models>.json
 */
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { classify } from "./memory/layer1";
import { agenticLoop } from "./memory/layer2";
import { getDb, closeDb } from "./memory/db";
import { DB_PATH, LAYER1_MODEL, LAYER2_MODEL, VOYAGE_MODEL } from "./memory/config";
import type { Layer1Result, ToolTurn } from "./memory/types";
import { getUsage, resetUsage, calculateCosts } from "./memory/usage-tracker";
import { saveRun, closeResultsDb } from "./memory/results-db";
import type { QueryRecord } from "./memory/results-db";

// ── Normalize for scoring ────────────────────────────────────────────

const normalize = (s: string) =>
  s.toLowerCase()
    .replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, "-")
    .replace(/[-\s]+/g, " ")
    .trim();

// ── Test queries ─────────────────────────────────────────────────────

// Phase 1: Retrieval-only queries (test against seeded data)
const RETRIEVAL_QUERIES = [
  // ── Simple entity lookups ──
  {
    id: "R01-person-peter",
    prompt: "Who is Peter?",
    description: "Simple person lookup",
    expectedInContext: ["content writer", "WOBS"],
  },
  {
    id: "R02-person-dave",
    prompt: "Tell me about Dave",
    description: "Person lookup with performance context",
    expectedInContext: ["junior", "writer", "health"],
  },
  {
    id: "R03-person-sarah",
    prompt: "What does Sarah do?",
    description: "Person role lookup",
    expectedInContext: ["editor", "review"],
  },
  {
    id: "R04-person-marcus",
    prompt: "Who is Marcus?",
    description: "Co-founder lookup",
    expectedInContext: ["co-founder", "operations"],
  },
  {
    id: "R05-person-james",
    prompt: "Who handles link building?",
    description: "Role-based person lookup (no name given)",
    expectedInContext: ["James", "guest post"],
  },
  {
    id: "R06-org",
    prompt: "What does WOBS do?",
    description: "Organization info query",
    expectedInContext: ["link building", "content marketing"],
  },

  // ── Client/project lookups ──
  {
    id: "R07-client-anderson",
    prompt: "What's the Anderson account?",
    description: "Client details",
    expectedInContext: ["SaaS", "Peter", "20 article"],
  },
  {
    id: "R08-client-brightwell",
    prompt: "Tell me about the Brightwell project",
    description: "Client with issues",
    expectedInContext: ["health", "Dave", "12"],
  },
  {
    id: "R09-client-meridian",
    prompt: "What's special about Meridian Health?",
    description: "Client with extra requirements",
    expectedInContext: ["medical", "review", "hospital"],
  },
  {
    id: "R10-client-canopy",
    prompt: "What do I need to know about the Canopy Digital client?",
    description: "Newest client with white-label",
    expectedInContext: ["white-label", "newest"],
  },

  // ── Tool/process queries ──
  {
    id: "R11-tool-airtable-lookup",
    prompt: "How do I look up an order in Airtable?",
    description: "Tool usage — Airtable lookup process",
    expectedInContext: ["Active Orders", "filter", "client"],
  },
  {
    id: "R12-tool-airtable-create",
    prompt: "How do I create a new article assignment?",
    description: "Tool usage — Airtable create record",
    expectedInContext: ["Airtable", "Add record", "Keyword"],
  },
  {
    id: "R13-tool-wordpress",
    prompt: "How do I publish an article to a client site?",
    description: "Tool usage — WordPress publishing",
    expectedInContext: ["WordPress", "Yoast", "permalink"],
  },
  {
    id: "R14-tool-surfer",
    prompt: "How do I check the SEO score of an article?",
    description: "Tool usage — Surfer SEO",
    expectedInContext: ["Surfer", "Content Editor", "75"],
  },
  {
    id: "R15-tool-originality",
    prompt: "How do I check if content is AI-generated?",
    description: "Tool usage — Originality.ai",
    expectedInContext: ["Originality", "80%"],
  },
  {
    id: "R16-tool-gsc",
    prompt: "How do I pull a monthly SEO report?",
    description: "Tool usage — GSC reports",
    expectedInContext: ["Google Search Console", "CSV", "clicks"],
  },

  // ── Workflow/process queries ──
  {
    id: "R17-workflow",
    prompt: "What's the content creation workflow?",
    description: "Multi-step process retrieval",
    expectedInContext: ["Lisa", "Airtable", "Sarah", "WordPress"],
  },
  {
    id: "R18-complaint-process",
    prompt: "A client is complaining about an article. What should I do?",
    description: "Complaint handling process",
    expectedInContext: ["Lisa", "2 hours", "Marcus"],
  },
  {
    id: "R19-onboarding",
    prompt: "We're about to sign a new client. What's the onboarding process?",
    description: "Client onboarding steps",
    expectedInContext: ["Marcus", "contract", "Airtable", "WordPress"],
  },

  // ── Event/status queries ──
  {
    id: "R20-status-anderson",
    prompt: "How's the Anderson order going?",
    description: "Status with events",
    expectedInContext: ["8 articles", "Tuesday"],
  },
  {
    id: "R21-status-brightwell",
    prompt: "Any issues with Brightwell?",
    description: "Issue-focused status query",
    expectedInContext: ["missed", "deadline", "factual error"],
  },
  {
    id: "R22-status-dave",
    prompt: "Has Dave been having any problems lately?",
    description: "Person-focused incident query",
    expectedInContext: ["missed", "Brightwell", "medical inaccuracy"],
  },
  {
    id: "R23-recent-wins",
    prompt: "Any good news recently?",
    description: "Positive events query",
    expectedInContext: ["viral", "LinkedIn"],
  },

  // ── Instruction retrieval ──
  {
    id: "R24-rules-content",
    prompt: "What are the rules for submitting content?",
    description: "Content submission rules",
    expectedInContext: ["Originality", "Surfer", "Sarah"],
  },
  {
    id: "R25-rules-meridian",
    prompt: "What extra steps do Meridian Health articles need?",
    description: "Client-specific rules",
    expectedInContext: ["medical", "review", "sign-off"],
  },
  {
    id: "R26-rules-whitelabel",
    prompt: "What should I remember about white-label content?",
    description: "White-label rules",
    expectedInContext: ["branding", "Canopy"],
  },
  {
    id: "R27-rules-deadline",
    prompt: "What happens when a writer misses a deadline?",
    description: "Deadline policy",
    expectedInContext: ["Lisa", "24 hours"],
  },
  {
    id: "R28-rules-reports",
    prompt: "When are GSC reports due?",
    description: "Reporting deadline rule",
    expectedInContext: ["5th", "Marcus"],
  },

  // ── Comparison / analytical queries ──
  {
    id: "R29-comparison-writers",
    prompt: "Is Peter faster than Dave?",
    description: "Writer comparison",
    expectedInContext: ["8 article", "4 article"],
  },
  {
    id: "R30-comparison-quality",
    prompt: "Who writes better content, Peter or Dave?",
    description: "Quality comparison",
    expectedInContext: ["Peter", "Dave", "Surfer"],
  },
  {
    id: "R31-revenue",
    prompt: "How much revenue do we make?",
    description: "Business metrics",
    expectedInContext: ["12,600"],
  },
  {
    id: "R32-pricing",
    prompt: "What do we charge per article?",
    description: "Pricing info",
    expectedInContext: ["200", "400"],
  },

  // ── Multi-hop reasoning ──
  {
    id: "R33-multihop-who-reviews",
    prompt: "Who reviews the articles that Peter writes for Anderson?",
    description: "Multi-hop: Peter → Anderson → reviewer",
    expectedInContext: ["Sarah"],
  },
  {
    id: "R34-multihop-who-manages-client",
    prompt: "Who should I talk to about Anderson's day-to-day needs?",
    description: "Multi-hop: client communication rules",
    expectedInContext: ["Lisa"],
  },
  {
    id: "R35-multihop-tool-for-task",
    prompt: "Dave submitted an article. What tools does Sarah need to use to check it?",
    description: "Multi-hop: review process → tools",
    expectedInContext: ["Surfer", "Originality"],
  },

  // ── Edge cases ──
  {
    id: "R36-unknown-entity",
    prompt: "Who is Rachel?",
    description: "Non-existent entity — should return empty or minimal",
    expectedInContext: [],
  },
  {
    id: "R37-trivial",
    prompt: "ok thanks",
    description: "Trivial message — should skip pipeline",
    expectedInContext: [],
  },
  {
    id: "R38-ambiguous",
    prompt: "What's the status?",
    description: "Ambiguous query — no entity specified",
    expectedInContext: [],
  },
  {
    id: "R39-opinion",
    prompt: "What do I think about Dave?",
    description: "Opinion retrieval",
    expectedInContext: ["training", "Meridian"],
  },
  {
    id: "R40-brightwell-renewal",
    prompt: "Is anything coming up with Brightwell?",
    description: "Upcoming conditional fact",
    expectedInContext: ["renewal", "20 articles"],
  },
];

// Phase 2: Store-then-retrieve (tests full round-trip)
const STORE_THEN_RETRIEVE = [
  {
    id: "S01-new-instruction",
    store: "From now on, always format dates as DD/MM/YYYY",
    retrieve: "What date format should I use?",
    description: "Store instruction, retrieve it",
    expectedInContext: ["DD/MM/YYYY"],
  },
  {
    id: "S02-new-person",
    store: "We just hired Tom as a junior content writer. He'll focus on fintech articles and starts next Monday.",
    retrieve: "Who is Tom?",
    description: "Store new person, retrieve them",
    expectedInContext: ["Tom", "fintech"],
  },
  {
    id: "S03-event-cancel",
    store: "We just lost the Anderson client. They cancelled the contract.",
    retrieve: "What happened with Anderson?",
    description: "Store event, retrieve it",
    expectedInContext: ["cancel"],
  },
  {
    id: "S04-correction",
    store: "Actually, Peter moved to the marketing team. He no longer works on Anderson.",
    retrieve: "What team is Peter on now?",
    description: "Correction — update existing knowledge",
    expectedInContext: ["marketing"],
  },
  {
    id: "S05-new-tool",
    store: "We're now using Grammarly for proofreading. Every article must pass a Grammarly check before going to Sarah.",
    retrieve: "Do we use Grammarly?",
    description: "Store new tool info, retrieve it",
    expectedInContext: ["Grammarly", "proofreading"],
  },
  {
    id: "S06-new-process",
    store: "To request time off, send a message in #general on Slack at least 5 days in advance and tag Marcus.",
    retrieve: "How do I request time off?",
    description: "Store new process, retrieve it",
    expectedInContext: ["Slack", "5 days", "Marcus"],
  },
  {
    id: "S07-new-client",
    store: "Nexus Fintech signed up yesterday. They want 10 articles per month about cryptocurrency regulation. Monthly retainer is £2,500.",
    retrieve: "Tell me about the Nexus Fintech account",
    description: "Store new client, retrieve details",
    expectedInContext: ["Nexus", "cryptocurrency", "2,500"],
  },
  {
    id: "S08-opinion",
    store: "I think we should stop using Surfer SEO. It's too expensive and the scores don't correlate with actual rankings.",
    retrieve: "What do I think about Surfer SEO?",
    description: "Store opinion, retrieve it",
    expectedInContext: ["expensive", "ranking"],
  },
  {
    id: "S09-incident",
    store: "Dave accidentally published an unfinished draft to the Brightwell WordPress site this morning. Sarah caught it and took it down within 10 minutes.",
    retrieve: "What happened with the Brightwell site today?",
    description: "Store incident, retrieve it",
    expectedInContext: ["unfinished draft", "Sarah"],
  },
  {
    id: "S10-pricing-update",
    store: "We're raising our standard article price from £200 to £250 starting next month.",
    retrieve: "What's our article pricing?",
    description: "Store fact update, retrieve it",
    expectedInContext: ["250"],
  },
];

// ── Types ────────────────────────────────────────────────────────────

interface QueryResult {
  id: string;
  prompt: string;
  description: string;
  layer1: Layer1Result;
  layer2_turns: ToolTurn[];
  final_context: string;
  duration_ms: number;
  skipped: boolean;
  terminated_by: "done_tool" | "max_turns" | "no_tool_calls" | "timeout" | "skipped";
  expected_in_context: string[];
  context_hits: string[];
  context_misses: string[];
}

interface StoreRetrieveResult {
  id: string;
  description: string;
  store: QueryResult;
  retrieve: QueryResult;
}

interface BenchmarkResult {
  timestamp: string;
  models: { layer1: string; layer2: string };
  seed_data: string;
  retrieval_queries: QueryResult[];
  store_retrieve_queries: StoreRetrieveResult[];
  summary: {
    total_queries: number;
    total_duration_ms: number;
    avg_duration_ms: number;
    context_hit_rate: number;
    done_tool_rate: number;
    avg_tool_calls: number;
    retrieval_hit_rate: number;
    store_retrieve_hit_rate: number;
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

async function runQuery(
  id: string,
  prompt: string,
  description: string,
  expectedInContext: string[]
): Promise<QueryResult> {
  const start = Date.now();

  const l1c = await classify(prompt);
  const l1 = l1c.result;

  const hasContent =
    l1.entities.length > 0 ||
    l1.implied_facts.length > 0 ||
    l1.events.length > 0 ||
    l1.plans.length > 0 ||
    l1.opinions.length > 0 ||
    l1.concepts.length > 0 ||
    l1.implied_processes.length > 0;

  if (!hasContent) {
    return {
      id, prompt, description,
      layer1: l1, layer2_turns: [], final_context: "",
      duration_ms: Date.now() - start, skipped: true, terminated_by: "skipped",
      expected_in_context: expectedInContext, context_hits: [], context_misses: expectedInContext,
    };
  }

  let context = "";
  let turns: ToolTurn[] = [];
  let terminated_by: QueryResult["terminated_by"] = "skipped";

  if (l1.operations.retrieve || l1.operations.store) {
    const result = await agenticLoop(prompt, l1);
    context = result.context;
    turns = result.turns;

    const lastTurn = turns[turns.length - 1];
    if (lastTurn?.tool_call.name === "done") {
      terminated_by = "done_tool";
    } else if (turns.length >= 8) {
      terminated_by = "max_turns";
    } else {
      terminated_by = "no_tool_calls";
    }
  }

  const duration_ms = Date.now() - start;

  const contextNorm = normalize(context);
  const context_hits = expectedInContext.filter((s) => contextNorm.includes(normalize(s)));
  const context_misses = expectedInContext.filter((s) => !contextNorm.includes(normalize(s)));

  return {
    id, prompt, description,
    layer1: l1, layer2_turns: turns, final_context: context,
    duration_ms, skipped: false, terminated_by,
    expected_in_context: expectedInContext, context_hits, context_misses,
  };
}

function resetDb() {
  closeDb();
  try { rmSync(DB_PATH); } catch {}
}

async function seedDb() {
  const { createNode, createEdge } = await import("./memory/db");
  const { storeEmbedding } = await import("./memory/vectors");
  const { embed } = await import("./memory/voyage");

  getDb(); // init schema

  // ── People ──
  const peterId = createNode({ node_type: "entity", subtype: "person",
    content: "Peter — senior content writer at WOBS. Writes articles for client orders. Very reliable, produces ~8 articles per week. Specializes in tech and SaaS content.",
    salience: 1.3, confidence: 1.0, source: "user",
    attributes: { aliases: ["Pete"], role: "senior content writer", rate: "8 articles/week", specialty: "tech/SaaS" } });
  const daveId = createNode({ node_type: "entity", subtype: "person",
    content: "Dave — junior content writer at WOBS. Slower than Peter, produces about 4 articles per week. Good at health and wellness topics. Started 3 months ago.",
    salience: 1.0, confidence: 1.0, source: "user",
    attributes: { role: "junior content writer", rate: "4 articles/week", specialty: "health/wellness" } });
  const sarahId = createNode({ node_type: "entity", subtype: "person",
    content: "Sarah — editor and QA lead at WOBS. Reviews all articles before publishing. Also manages the Surfer SEO optimization process.",
    salience: 1.1, confidence: 1.0, source: "user", attributes: { role: "editor / QA lead" } });
  const marcusId = createNode({ node_type: "entity", subtype: "person",
    content: "Marcus — co-founder and operations manager at WOBS. Handles client relationships, pricing, and overall business strategy. The user's business partner.",
    salience: 1.3, confidence: 1.0, source: "user", attributes: { aliases: ["Marc"], role: "co-founder / ops manager" } });
  const lisaId = createNode({ node_type: "entity", subtype: "person",
    content: "Lisa — client account manager at WOBS. Handles day-to-day client communication, manages the Airtable order tracker, and coordinates deadlines.",
    salience: 1.0, confidence: 1.0, source: "user", attributes: { role: "account manager" } });
  const jamesId = createNode({ node_type: "entity", subtype: "person",
    content: "James — freelance link builder contracted by WOBS. Works remotely from Portugal. Handles outreach and guest post placements for all clients.",
    salience: 1.0, confidence: 1.0, source: "user", attributes: { aliases: ["Jim"], role: "freelance link builder", location: "Portugal" } });

  // ── Org ──
  const wobsId = createNode({ node_type: "entity", subtype: "org",
    content: "WOBS (Wolf of Blog Street) — a content marketing agency that does link building and content marketing for clients. Founded by Marcus and the user. Team of 6 people. Based in London but mostly remote.",
    salience: 1.3, confidence: 1.0, source: "user",
    attributes: { aliases: ["Wolf of Blog Street"], industry: "content marketing", location: "London (remote)" } });

  // ── Clients ──
  const andersonId = createNode({ node_type: "entity", subtype: "project",
    content: "Anderson — a client project at WOBS. Mid-size SaaS company. Order involves 20 articles per month on cloud infrastructure topics. Peter is the primary writer. Monthly retainer: £4,000.",
    salience: 1.1, confidence: 1.0, source: "user",
    attributes: { niche: "cloud/SaaS", articles_per_month: 20, retainer: "£4,000/month" } });
  const brightwellId = createNode({ node_type: "entity", subtype: "project",
    content: "Brightwell — a client project at WOBS. Health supplement company. Order involves 12 articles per month on wellness topics. Dave is the primary writer. Monthly retainer: £2,400.",
    salience: 1.0, confidence: 1.0, source: "user",
    attributes: { niche: "health/wellness", articles_per_month: 12, retainer: "£2,400/month" } });
  const meridianId = createNode({ node_type: "entity", subtype: "project",
    content: "Meridian Health — a client project at WOBS. Private hospital chain. Sensitive content requiring medical accuracy review. 8 articles per month. Peter and Dave split the writing. Monthly retainer: £3,200.",
    salience: 1.1, confidence: 1.0, source: "user",
    attributes: { niche: "healthcare", articles_per_month: 8, retainer: "£3,200/month" } });
  const canopyId = createNode({ node_type: "entity", subtype: "project",
    content: "Canopy Digital — newest client at WOBS. Digital marketing agency that wants white-label content. 15 articles per month across various niches. Started 2 weeks ago. Monthly retainer: £3,000.",
    salience: 1.0, confidence: 1.0, source: "user",
    attributes: { niche: "mixed/white-label", articles_per_month: 15, retainer: "£3,000/month" } });

  // ── Tools ──
  const airtableId = createNode({ node_type: "entity", subtype: "tool",
    content: "Airtable — the main order tracking and project management tool at WOBS. Contains all client orders, article assignments, deadlines, and status tracking. Lisa manages the base.",
    salience: 1.5, confidence: 1.0, source: "user", attributes: { type: "project management" } });
  const wordpressId = createNode({ node_type: "entity", subtype: "tool",
    content: "WordPress — the CMS used for publishing articles to client sites. Each client has their own WordPress instance. WOBS team has editor-level access.",
    salience: 1.5, confidence: 1.0, source: "user", attributes: { type: "CMS" } });
  const surferId = createNode({ node_type: "entity", subtype: "tool",
    content: "Surfer SEO — content optimization tool used at WOBS. Every article must score at least 75/100 on Surfer before publishing. Sarah runs the Surfer checks.",
    salience: 1.5, confidence: 1.0, source: "user", attributes: { type: "SEO optimization", threshold: 75 } });
  const originalityId = createNode({ node_type: "entity", subtype: "tool",
    content: "Originality.ai — AI detection tool used at WOBS. All content must score above 80% original before client delivery.",
    salience: 1.5, confidence: 1.0, source: "user", attributes: { type: "AI detection", threshold: "80% original" } });
  const gscId = createNode({ node_type: "entity", subtype: "tool",
    content: "Google Search Console (GSC) — used to monitor SEO performance of published articles. Monthly reports pulled from GSC for each client. Marcus reviews the reports.",
    salience: 1.5, confidence: 1.0, source: "user", attributes: { aliases: ["GSC"], type: "SEO monitoring" } });
  const slackId = createNode({ node_type: "entity", subtype: "tool",
    content: "Slack — team communication tool at WOBS. Channels: #general, #orders, #content-review, #client-updates. All urgent issues go to #orders.",
    salience: 1.0, confidence: 1.0, source: "user", attributes: { type: "communication" } });

  // ── Facts ──
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
    for (const link of f.links) createEdge({ source_id: id, target_id: link.t, edge_type: link.e });
  }

  // ── Events ──
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
    for (const link of e.links) createEdge({ source_id: id, target_id: link.t, edge_type: link.e });
  }

  // ── Instructions ──
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

  const instrIds: string[] = [];
  for (const i of instrData) {
    const id = createNode({ node_type: "instruction", subtype: "instruction", content: i.c, salience: i.sal, confidence: 1.0, source: "user", attributes: {}, scope: i.scope });
    instrIds.push(id);
    for (const link of i.links) createEdge({ source_id: id, target_id: link.t, edge_type: link.e });
  }

  // ── Processes / Tool usage ──
  const procData = [
    { c: "To look up an order in Airtable: Open the WOBS Orders base → go to the 'Active Orders' view → filter by client name. Each row shows: client, article title, assigned writer, deadline, status (Draft/Review/Published). You can also filter by writer name to see their assignments.", sal: 1.8, scope: 0.5, links: [{ t: airtableId, e: "about" }] },
    { c: "To create a new article assignment in Airtable: In the 'Active Orders' view → click '+ Add record' → fill in: Client (dropdown), Article Title, Target Keyword, Assigned Writer (dropdown), Deadline, Word Count Target. Status will default to 'Draft'.", sal: 1.5, scope: 0.5, links: [{ t: airtableId, e: "about" }] },
    { c: "To update an order status in Airtable: Find the article row → change the Status dropdown from 'Draft' to 'Review' when submitted, 'Review' to 'Published' when live. Add the live URL to the 'Published URL' field.", sal: 1.5, scope: 0.5, links: [{ t: airtableId, e: "about" }] },
    { c: "To publish an article on WordPress: Log into the client's WP admin → Posts → Add New → paste the content → set the category and tags → add the featured image → set the SEO meta title and description in Yoast → click 'Publish'. Make sure the permalink slug matches the target keyword.", sal: 1.5, scope: 0.5, links: [{ t: wordpressId, e: "about" }] },
    { c: "To run a Surfer SEO check: Open Surfer → Content Editor → paste the target keyword → paste the article text → check the Content Score. Must be 75+ to pass. If below 75, Surfer will suggest missing terms and topics to add. Send suggestions back to the writer.", sal: 1.8, scope: 0.5, links: [{ t: surferId, e: "about" }] },
    { c: "To check AI detection with Originality.ai: Go to Originality.ai → Scan → paste the full article text → click 'Scan'. Check the 'Original' percentage. Must be above 80%. If below 80%, the article needs to be rewritten by the writer — do NOT attempt to manually edit it to pass.", sal: 1.8, scope: 0.5, links: [{ t: originalityId, e: "about" }] },
    { c: "To pull a GSC report: Open Google Search Console → select the client's property → Performance → set date range to last 30 days → export as CSV. Key metrics: total clicks, impressions, average CTR, average position. Compare to previous month.", sal: 1.5, scope: 0.5, links: [{ t: gscId, e: "about" }] },
    { c: "Content creation workflow at WOBS: 1) Lisa creates the assignment in Airtable with keyword and deadline. 2) Writer drafts the article. 3) Writer submits to Sarah for review (status → Review). 4) Sarah checks quality, Surfer score, and Originality score. 5) If passes, Sarah approves and publishes to WordPress. 6) Lisa updates Airtable status to Published.", sal: 1.8, scope: 0.7, links: [{ t: wobsId, e: "about" }, { t: airtableId, e: "about" }, { t: wordpressId, e: "about" }] },
    { c: "When dealing with a client complaint: 1) Lisa acknowledges within 2 hours. 2) Lisa investigates — checks the article, who wrote it, what went wrong. 3) Lisa coordinates fix with the writer. 4) If it's a factual error, escalate to Marcus. 5) Fixed article goes through Sarah's review again before re-publishing.", sal: 1.8, scope: 0.7, links: [{ t: lisaId, e: "about" }, { t: marcusId, e: "about" }] },
    { c: "To onboard a new client: 1) Marcus signs the contract and sets up billing. 2) Lisa creates the Airtable workspace for the client. 3) Lisa gets WordPress admin credentials from the client. 4) Lisa creates the first month's article assignments in Airtable. 5) Writers start on articles within 3 days of onboarding.", sal: 1.8, scope: 0.7, links: [{ t: marcusId, e: "about" }, { t: lisaId, e: "about" }, { t: airtableId, e: "about" }] },
  ];

  const procIds: string[] = [];
  for (const p of procData) {
    const id = createNode({ node_type: "instruction", subtype: "tool_usage", content: p.c, salience: p.sal, confidence: 1.0, source: "user", attributes: {}, scope: p.scope });
    procIds.push(id);
    for (const link of p.links) createEdge({ source_id: id, target_id: link.t, edge_type: link.e });
  }

  // ── Opinions ──
  const opinData = [
    { c: "I think Dave needs more training before handling Meridian Health articles — the medical inaccuracy issues are concerning", sal: 1.0, links: [{ t: daveId, e: "about" }, { t: meridianId, e: "about" }] },
    { c: "Peter is the best writer we have. If we lose him, we're in trouble.", sal: 1.0, links: [{ t: peterId, e: "about" }] },
    { c: "Canopy Digital might be more trouble than they're worth — the white-label requirement adds complexity and they're paying standard rates", sal: 1.0, links: [{ t: canopyId, e: "about" }] },
    { c: "We should probably raise prices for healthcare content. The medical review step makes it much more expensive to produce.", sal: 1.0, links: [{ t: meridianId, e: "about" }, { t: wobsId, e: "about" }] },
  ];

  for (const o of opinData) {
    const id = createNode({ node_type: "opinion", subtype: "user_opinion", content: o.c, salience: o.sal, confidence: 1.0, source: "user", attributes: {} });
    for (const link of o.links) createEdge({ source_id: id, target_id: link.t, edge_type: link.e });
  }

  // ── Structural edges ──
  const structEdges = [
    { s: peterId, t: wobsId, e: "works_for" }, { s: daveId, t: wobsId, e: "works_for" },
    { s: sarahId, t: wobsId, e: "works_for" }, { s: marcusId, t: wobsId, e: "co_founder_of" },
    { s: lisaId, t: wobsId, e: "works_for" }, { s: jamesId, t: wobsId, e: "contracted_by" },
    { s: peterId, t: andersonId, e: "writes_for" }, { s: peterId, t: meridianId, e: "writes_for" },
    { s: daveId, t: brightwellId, e: "writes_for" }, { s: daveId, t: meridianId, e: "writes_for" },
    { s: sarahId, t: andersonId, e: "reviews_for" }, { s: sarahId, t: brightwellId, e: "reviews_for" },
    { s: sarahId, t: meridianId, e: "reviews_for" }, { s: sarahId, t: canopyId, e: "reviews_for" },
    { s: lisaId, t: andersonId, e: "manages" }, { s: lisaId, t: brightwellId, e: "manages" },
    { s: lisaId, t: meridianId, e: "manages" }, { s: lisaId, t: canopyId, e: "manages" },
    { s: jamesId, t: andersonId, e: "builds_links_for" }, { s: jamesId, t: brightwellId, e: "builds_links_for" },
    { s: jamesId, t: meridianId, e: "builds_links_for" },
    { s: andersonId, t: wobsId, e: "client_of" }, { s: brightwellId, t: wobsId, e: "client_of" },
    { s: meridianId, t: wobsId, e: "client_of" }, { s: canopyId, t: wobsId, e: "client_of" },
    { s: airtableId, t: wobsId, e: "used_by" }, { s: wordpressId, t: wobsId, e: "used_by" },
    { s: surferId, t: wobsId, e: "used_by" }, { s: originalityId, t: wobsId, e: "used_by" },
    { s: gscId, t: wobsId, e: "used_by" }, { s: slackId, t: wobsId, e: "used_by" },
    { s: lisaId, t: airtableId, e: "manages" }, { s: sarahId, t: surferId, e: "manages" },
    { s: marcusId, t: gscId, e: "reviews" },
  ];
  for (const e of structEdges) createEdge({ source_id: e.s, target_id: e.t, edge_type: e.e });

  // ── Embeddings ──
  const allNodes: Array<{ id: string; type: string; text: string }> = [
    { id: peterId, type: "entity", text: "Peter — senior content writer at WOBS, specializes in tech/SaaS content, writes about 8 articles per week" },
    { id: daveId, type: "entity", text: "Dave — junior content writer at WOBS, specializes in health/wellness, writes about 4 articles per week" },
    { id: sarahId, type: "entity", text: "Sarah — editor and QA lead at WOBS, reviews all articles, manages Surfer SEO checks" },
    { id: marcusId, type: "entity", text: "Marcus — co-founder and ops manager at WOBS, handles clients and strategy" },
    { id: lisaId, type: "entity", text: "Lisa — account manager at WOBS, manages Airtable orders and client communication" },
    { id: jamesId, type: "entity", text: "James — freelance link builder for WOBS, works from Portugal, handles guest post outreach" },
    { id: wobsId, type: "entity", text: "WOBS Wolf of Blog Street — content marketing agency, link building, remote team in London" },
    { id: andersonId, type: "entity", text: "Anderson — SaaS client at WOBS, 20 articles per month, cloud infrastructure, Peter writes" },
    { id: brightwellId, type: "entity", text: "Brightwell — health supplement client at WOBS, 12 articles per month, Dave writes" },
    { id: meridianId, type: "entity", text: "Meridian Health — private hospital client at WOBS, 8 articles per month, medical review required" },
    { id: canopyId, type: "entity", text: "Canopy Digital — white-label content client at WOBS, 15 articles per month, newest client" },
    { id: airtableId, type: "entity", text: "Airtable — order tracking and project management tool, contains assignments and deadlines" },
    { id: wordpressId, type: "entity", text: "WordPress — CMS for publishing articles to client sites" },
    { id: surferId, type: "entity", text: "Surfer SEO — content optimization tool, articles must score 75+ to pass" },
    { id: originalityId, type: "entity", text: "Originality.ai — AI detection tool, content must be above 80% original" },
    { id: gscId, type: "entity", text: "Google Search Console GSC — SEO monitoring, monthly performance reports" },
    { id: slackId, type: "entity", text: "Slack — team communication, channels for orders, reviews, client updates" },
  ];
  for (let i = 0; i < factsData.length; i++) allNodes.push({ id: factIds[i], type: "fact", text: factsData[i].c });
  for (let i = 0; i < eventsData.length; i++) allNodes.push({ id: eventIds[i], type: "event", text: eventsData[i].c });
  for (let i = 0; i < instrData.length; i++) allNodes.push({ id: instrIds[i], type: "instruction", text: instrData[i].c });
  for (let i = 0; i < procData.length; i++) allNodes.push({ id: procIds[i], type: "instruction", text: procData[i].c });

  const texts = allNodes.map((n) => n.text);
  const batchSize = 50;
  for (let start = 0; start < texts.length; start += batchSize) {
    const batch = texts.slice(start, start + batchSize);
    const vectors = await embed(batch);
    for (let j = 0; j < vectors.length; j++) {
      storeEmbedding(allNodes[start + j].id, allNodes[start + j].type, vectors[j]);
    }
  }

  return allNodes.length;
}

// ── Main ─────────────────────────────────────────────────────────────

resetUsage();

console.log(`\n╔══════════════════════════════════════════════════════════╗`);
console.log(`║          Memory System Benchmark Run (v2)               ║`);
console.log(`╚══════════════════════════════════════════════════════════╝`);
console.log(`Layer 1: ${LAYER1_MODEL}`);
console.log(`Layer 2: ${LAYER2_MODEL}`);
console.log(`Embeddings: ${VOYAGE_MODEL}`);
console.log(`Retrieval queries: ${RETRIEVAL_QUERIES.length}`);
console.log(`Store-retrieve queries: ${STORE_THEN_RETRIEVE.length}`);
console.log(`Total test cases: ${RETRIEVAL_QUERIES.length + STORE_THEN_RETRIEVE.length}`);

if (process.env.SKIP_SEED === "1") {
  console.log(`\n── Using pre-seeded DB (SKIP_SEED=1)...`);
  getDb(); // open existing DB
} else {
  console.log(`\n── Resetting DB and seeding...`);
  resetDb();
  const nodeCount = await seedDb();
  console.log(`   Seeded ${nodeCount} nodes.`);
}
console.log();

const allResults: BenchmarkResult = {
  timestamp: new Date().toISOString(),
  models: { layer1: LAYER1_MODEL, layer2: LAYER2_MODEL },
  seed_data: "v2-expanded",
  retrieval_queries: [],
  store_retrieve_queries: [],
  summary: {
    total_queries: 0, total_duration_ms: 0, avg_duration_ms: 0,
    context_hit_rate: 0, done_tool_rate: 0, avg_tool_calls: 0,
    retrieval_hit_rate: 0, store_retrieve_hit_rate: 0,
  },
};

// Helper: run array of promises in batches
async function runBatched<T>(items: T[], batchSize: number, fn: (item: T) => Promise<any>): Promise<any[]> {
  const results: any[] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
  }
  return results;
}

const BATCH_SIZE = 15;

// Phase 1: Retrieval queries (parallel in batches)
console.log(`── Phase 1: Retrieval Queries (${RETRIEVAL_QUERIES.length}) — batch size ${BATCH_SIZE} ──\n`);

const retrievalResults = await runBatched(RETRIEVAL_QUERIES, BATCH_SIZE, async (q) => {
  try {
    return { q, result: await runQuery(q.id, q.prompt, q.description, q.expectedInContext), err: null };
  } catch (err: any) {
    return { q, result: null, err };
  }
});

for (const { q, result, err } of retrievalResults) {
  if (err) {
    console.log(`  ${q.id}: "${q.prompt.slice(0, 55)}..." \x1b[31mERROR: ${err.message}\x1b[0m`);
    allResults.retrieval_queries.push({
      id: q.id, prompt: q.prompt, description: q.description,
      layer1: { entities: [], implied_facts: [], events: [], opinions: [], concepts: [], implied_processes: [], intents: [], operations: { retrieve: false, store: false } },
      layer2_turns: [], final_context: `ERROR: ${err.message}`, duration_ms: 0,
      skipped: true, terminated_by: "skipped",
      expected_in_context: q.expectedInContext, context_hits: [], context_misses: q.expectedInContext,
    });
    continue;
  }
  allResults.retrieval_queries.push(result);
  const hitPct = q.expectedInContext.length > 0
    ? Math.round((result.context_hits.length / q.expectedInContext.length) * 100)
    : 100;
  if (result.skipped) {
    console.log(`  ${q.id}: "${q.prompt.slice(0, 55)}..." SKIP (${result.duration_ms}ms)`);
  } else {
    const status = hitPct === 100 ? "\x1b[32m✓\x1b[0m" : hitPct > 0 ? "\x1b[33m~\x1b[0m" : "\x1b[31m✗\x1b[0m";
    console.log(
      `  ${q.id}: ${status} ${hitPct}% (${result.context_hits.length}/${q.expectedInContext.length}), ${result.layer2_turns.length} calls, ${result.terminated_by}, ${result.duration_ms}ms`
    );
    if (result.context_misses.length > 0) {
      console.log(`    \x1b[31mmisses: ${result.context_misses.join(", ")}\x1b[0m`);
    }
  }
}

// Phase 2: Store → Retrieve (parallel in batches — each pair is store-then-retrieve internally)
console.log(`\n── Phase 2: Store → Retrieve (${STORE_THEN_RETRIEVE.length}) — batch size ${BATCH_SIZE} ──\n`);

const storeRetrieveResults = await runBatched(STORE_THEN_RETRIEVE, BATCH_SIZE, async (q) => {
  try {
    const storeResult = await runQuery(`${q.id}-store`, q.store, `Store: ${q.description}`, []);
    const retrieveResult = await runQuery(`${q.id}-retrieve`, q.retrieve, `Retrieve: ${q.description}`, q.expectedInContext);
    return { q, storeResult, retrieveResult, err: null };
  } catch (err: any) {
    return { q, storeResult: null, retrieveResult: null, err };
  }
});

for (const { q, storeResult, retrieveResult, err } of storeRetrieveResults) {
  console.log(`  ${q.id}: ${q.description}`);
  if (err) {
    console.log(`    \x1b[31mERROR: ${err.message}\x1b[0m`);
    continue;
  }
  console.log(
    `    store: ${storeResult.layer2_turns.length} calls, ${storeResult.terminated_by}, ${storeResult.duration_ms}ms`
  );
  const hitPct = q.expectedInContext.length > 0
    ? Math.round((retrieveResult.context_hits.length / q.expectedInContext.length) * 100)
    : 100;
  const status = hitPct === 100 ? "\x1b[32m✓\x1b[0m" : hitPct > 0 ? "\x1b[33m~\x1b[0m" : "\x1b[31m✗\x1b[0m";
  console.log(
    `    retrieve: ${status} ${hitPct}% (${retrieveResult.context_hits.length}/${q.expectedInContext.length}), ${retrieveResult.layer2_turns.length} calls, ${retrieveResult.terminated_by}, ${retrieveResult.duration_ms}ms`
  );
  if (retrieveResult.context_misses.length > 0) {
    console.log(`    \x1b[31mmisses: ${retrieveResult.context_misses.join(", ")}\x1b[0m`);
  }
  allResults.store_retrieve_queries.push({
    id: q.id, description: q.description,
    store: storeResult, retrieve: retrieveResult,
  });
}

// ── Summary ──────────────────────────────────────────────────────────

const retrievalWithExpected = allResults.retrieval_queries.filter((q) => q.expected_in_context.length > 0);
const storeRetrieveScored = allResults.store_retrieve_queries.map((sr) => sr.retrieve);
const allScoredQueries = [...retrievalWithExpected, ...storeRetrieveScored];
const allQueries = [
  ...allResults.retrieval_queries,
  ...allResults.store_retrieve_queries.flatMap((sr) => [sr.store, sr.retrieve]),
];
const nonSkipped = allQueries.filter((q) => !q.skipped);
const totalDuration = allQueries.reduce((s, q) => s + q.duration_ms, 0);
const totalExpected = allScoredQueries.reduce((s, q) => s + q.expected_in_context.length, 0);
const totalHits = allScoredQueries.reduce((s, q) => s + q.context_hits.length, 0);
const doneCount = nonSkipped.filter((q) => q.terminated_by === "done_tool").length;
const totalToolCalls = nonSkipped.reduce((s, q) => s + q.layer2_turns.length, 0);

// Per-phase hit rates
const rExpected = retrievalWithExpected.reduce((s, q) => s + q.expected_in_context.length, 0);
const rHits = retrievalWithExpected.reduce((s, q) => s + q.context_hits.length, 0);
const sExpected = storeRetrieveScored.reduce((s, q) => s + q.expected_in_context.length, 0);
const sHits = storeRetrieveScored.reduce((s, q) => s + q.context_hits.length, 0);

allResults.summary = {
  total_queries: allQueries.length,
  total_duration_ms: totalDuration,
  avg_duration_ms: Math.round(totalDuration / allQueries.length),
  context_hit_rate: totalExpected > 0 ? Math.round((totalHits / totalExpected) * 100) : 100,
  done_tool_rate: nonSkipped.length > 0 ? Math.round((doneCount / nonSkipped.length) * 100) : 0,
  avg_tool_calls: nonSkipped.length > 0 ? Math.round((totalToolCalls / nonSkipped.length) * 10) / 10 : 0,
  retrieval_hit_rate: rExpected > 0 ? Math.round((rHits / rExpected) * 100) : 100,
  store_retrieve_hit_rate: sExpected > 0 ? Math.round((sHits / sExpected) * 100) : 100,
};

// Count fully-passed queries
const fullPassRetrieval = retrievalWithExpected.filter((q) => q.context_misses.length === 0).length;
const fullPassStore = storeRetrieveScored.filter((q) => q.context_misses.length === 0).length;

// ── Cost calculation ──────────────────────────────────────────────
const usage = getUsage();
const costs = calculateCosts(LAYER1_MODEL, LAYER2_MODEL, VOYAGE_MODEL, usage);
const errorCount = allResults.retrieval_queries.filter(q => q.final_context.startsWith("ERROR:")).length;

console.log(`\n══════════════════════════════════════════════════════════`);
console.log(`  SUMMARY`);
console.log(`══════════════════════════════════════════════════════════`);
console.log(`  Models: L1=${LAYER1_MODEL.split("/").pop()}`);
console.log(`          L2=${LAYER2_MODEL.split("/").pop()}`);
console.log(`          Embed=${VOYAGE_MODEL}`);
console.log(`  ──────────────────────────────────────`);
console.log(`  Retrieval hit rate:      ${allResults.summary.retrieval_hit_rate}% (${rHits}/${rExpected} expected strings)`);
console.log(`  Retrieval full-pass:     ${fullPassRetrieval}/${retrievalWithExpected.length} queries`);
console.log(`  Store→Retrieve hit rate: ${allResults.summary.store_retrieve_hit_rate}% (${sHits}/${sExpected} expected strings)`);
console.log(`  Store→Retrieve full-pass:${fullPassStore}/${storeRetrieveScored.length} queries`);
console.log(`  ──────────────────────────────────────`);
console.log(`  Overall hit rate:        ${allResults.summary.context_hit_rate}%`);
console.log(`  "done" tool rate:        ${allResults.summary.done_tool_rate}%`);
console.log(`  Avg tool calls:          ${allResults.summary.avg_tool_calls}`);
console.log(`  Avg time/query:          ${allResults.summary.avg_duration_ms}ms`);
console.log(`  Total time:              ${Math.round(allResults.summary.total_duration_ms / 1000)}s`);
if (errorCount > 0) console.log(`  Errors:                  ${errorCount}`);
console.log(`  ──────────────────────────────────────`);
console.log(`  COSTS`);
console.log(`  L1 tokens:    ${usage.l1_input.toLocaleString()} in / ${usage.l1_output.toLocaleString()} out → $${costs.l1_cost.toFixed(4)}`);
console.log(`  L2 tokens:    ${usage.l2_input.toLocaleString()} in / ${usage.l2_output.toLocaleString()} out → $${costs.l2_cost.toFixed(4)}`);
console.log(`  Curate tkns:  ${usage.curate_input.toLocaleString()} in / ${usage.curate_output.toLocaleString()} out → $${costs.curate_cost.toFixed(4)}`);
console.log(`  Embed tokens: ${usage.embedding_tokens.toLocaleString()} → $${costs.embedding_cost.toFixed(4)}`);
console.log(`  Total cost:   $${costs.total_cost.toFixed(4)}`);
console.log(`══════════════════════════════════════════════════════════\n`);

// Save results to JSON
const benchDir = join(process.env.HOME || "~", ".octybot", "test", "benchmarks");
mkdirSync(benchDir, { recursive: true });
const l1Short = LAYER1_MODEL.split("/").pop() || "unknown";
const l2Short = LAYER2_MODEL.split("/").pop() || "unknown";
const filename = `${new Date().toISOString().replace(/[:.]/g, "-")}_L1-${l1Short}_L2-${l2Short}.json`;
const filepath = join(benchDir, filename);
writeFileSync(filepath, JSON.stringify(allResults, null, 2));
console.log(`Results saved to: ${filepath}`);

// Save to results DB
const queryRecords: QueryRecord[] = [];
for (const q of allResults.retrieval_queries) {
  queryRecords.push({
    query_id: q.id, phase: "retrieval", prompt: q.prompt,
    expected_count: q.expected_in_context.length, hit_count: q.context_hits.length,
    misses: q.context_misses, tool_calls: q.layer2_turns.length,
    terminated_by: q.terminated_by, duration_ms: q.duration_ms,
    context_preview: q.final_context,
  });
}
for (const sr of allResults.store_retrieve_queries) {
  queryRecords.push({
    query_id: sr.id + "-store", phase: "store", prompt: sr.store.prompt,
    expected_count: 0, hit_count: 0, misses: [],
    tool_calls: sr.store.layer2_turns.length, terminated_by: sr.store.terminated_by,
    duration_ms: sr.store.duration_ms, context_preview: sr.store.final_context,
  });
  queryRecords.push({
    query_id: sr.id + "-retrieve", phase: "store_retrieve", prompt: sr.retrieve.prompt,
    expected_count: sr.retrieve.expected_in_context.length, hit_count: sr.retrieve.context_hits.length,
    misses: sr.retrieve.context_misses, tool_calls: sr.retrieve.layer2_turns.length,
    terminated_by: sr.retrieve.terminated_by, duration_ms: sr.retrieve.duration_ms,
    context_preview: sr.retrieve.final_context,
  });
}

const runId = saveRun({
  timestamp: allResults.timestamp,
  l1_model: LAYER1_MODEL, l2_model: LAYER2_MODEL, embedding_model: VOYAGE_MODEL,
  test_suite: "v2",
  total_queries: allQueries.length,
  retrieval_queries: RETRIEVAL_QUERIES.length,
  store_queries: STORE_THEN_RETRIEVE.length,
  retrieval_hit_rate: allResults.summary.retrieval_hit_rate,
  store_hit_rate: allResults.summary.store_retrieve_hit_rate,
  overall_hit_rate: allResults.summary.context_hit_rate,
  retrieval_full_pass: fullPassRetrieval,
  retrieval_full_pass_total: retrievalWithExpected.length,
  store_full_pass: fullPassStore,
  store_full_pass_total: storeRetrieveScored.length,
  done_tool_rate: allResults.summary.done_tool_rate,
  avg_tool_calls: allResults.summary.avg_tool_calls,
  avg_duration_ms: allResults.summary.avg_duration_ms,
  total_duration_ms: allResults.summary.total_duration_ms,
  l1_input_tokens: usage.l1_input, l1_output_tokens: usage.l1_output,
  l2_input_tokens: usage.l2_input, l2_output_tokens: usage.l2_output,
  embedding_tokens: usage.embedding_tokens,
  l1_cost_usd: costs.l1_cost, l2_cost_usd: costs.l2_cost,
  embedding_cost_usd: costs.embedding_cost, total_cost_usd: costs.total_cost,
  errors: errorCount,
}, queryRecords);

closeResultsDb();
console.log(`Results saved to DB (run #${runId})\n`);
