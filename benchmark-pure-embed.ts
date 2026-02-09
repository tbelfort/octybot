/**
 * Pure-embedding benchmark — same queries as benchmark.ts but uses
 * only Voyage 4 embeddings + OSS-120B filtering (no graph, no tools).
 *
 * Architecture:
 *   Store:    embed(text) → flat vector DB
 *   Retrieve: embed(query) → top-10 cosine → send to OSS-120B → model selects context
 *
 * Usage:
 *   bun pa-test-1/benchmark-pure-embed.ts
 */
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { embed } from "./memory/voyage";
import { VOYAGE_MODEL } from "./memory/config";
import { getUsage, resetUsage, calculateCosts, trackTokens } from "./memory/usage-tracker";
import { saveRun, closeResultsDb } from "./memory/results-db";
import type { QueryRecord } from "./memory/results-db";
import { initStore, storeItem, searchItems, closeStore } from "./pure-embed/store";
import { getOpenRouterKey } from "./memory/config";

const TOP_K = 10;
const L2_MODEL = "openai/gpt-oss-120b";
const STORE_DB_PATH = join(process.env.HOME || "~", ".octybot", "test", "pure-embed.db");

// ── Normalize for scoring ────────────────────────────────────────────

const normalize = (s: string) =>
  s.toLowerCase()
    .replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, "-")
    .replace(/[-\s]+/g, " ")
    .trim();

// ── LLM filter call ─────────────────────────────────────────────────

async function filterWithLLM(query: string, candidates: Array<{ content: string; score: number }>): Promise<string> {
  const candidateList = candidates
    .map((c, i) => `${i + 1}. [score: ${c.score.toFixed(3)}] ${c.content}`)
    .join("\n");

  const systemPrompt = `You are a memory retrieval assistant. Given a user's query and a ranked list of memory entries, select the ones that are relevant to answering the query and assemble them into useful context.

Rules:
- Include ALL entries that are relevant, even partially
- Preserve exact numbers, names, prices, dates from the entries
- If no entries are relevant, return empty string
- Output ONLY the assembled context text, no explanation or preamble
- Include specific details — do not summarize or abstract away information`;

  const userContent = `Query: "${query}"

Memory entries (ranked by similarity):
${candidateList}

Select relevant entries and assemble context:`;

  const key = getOpenRouterKey();
  const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: L2_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
      max_tokens: 2048,
      temperature: 0.1,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`OpenRouter error ${resp.status}: ${text}`);
  }

  const data = await resp.json() as any;
  const usage = data.usage;
  if (usage) {
    trackTokens("l2", usage.prompt_tokens || 0, usage.completion_tokens || 0);
  }

  return data.choices?.[0]?.message?.content || "";
}

// ── Test queries (same as benchmark.ts) ──────────────────────────────

const RETRIEVAL_QUERIES = [
  { id: "R01-person-peter", prompt: "Who is Peter?", expectedInContext: ["content writer", "WOBS"] },
  { id: "R02-person-dave", prompt: "Tell me about Dave", expectedInContext: ["junior", "writer", "health"] },
  { id: "R03-person-sarah", prompt: "What does Sarah do?", expectedInContext: ["editor", "review"] },
  { id: "R04-person-marcus", prompt: "Who is Marcus?", expectedInContext: ["co-founder", "operations"] },
  { id: "R05-person-james", prompt: "Who handles link building?", expectedInContext: ["James", "guest post"] },
  { id: "R06-org", prompt: "What does WOBS do?", expectedInContext: ["link building", "content marketing"] },
  { id: "R07-client-anderson", prompt: "What's the Anderson account?", expectedInContext: ["SaaS", "Peter", "20 article"] },
  { id: "R08-client-brightwell", prompt: "Tell me about the Brightwell project", expectedInContext: ["health", "Dave", "12"] },
  { id: "R09-client-meridian", prompt: "What's special about Meridian Health?", expectedInContext: ["medical", "review", "hospital"] },
  { id: "R10-client-canopy", prompt: "What do I need to know about the Canopy Digital client?", expectedInContext: ["white-label", "newest"] },
  { id: "R11-tool-airtable-lookup", prompt: "How do I look up an order in Airtable?", expectedInContext: ["Active Orders", "filter", "client"] },
  { id: "R12-tool-airtable-create", prompt: "How do I create a new article assignment?", expectedInContext: ["Airtable", "Add record", "Keyword"] },
  { id: "R13-tool-wordpress", prompt: "How do I publish an article to a client site?", expectedInContext: ["WordPress", "Yoast", "permalink"] },
  { id: "R14-tool-surfer", prompt: "How do I check the SEO score of an article?", expectedInContext: ["Surfer", "Content Editor", "75"] },
  { id: "R15-tool-originality", prompt: "How do I check if content is AI-generated?", expectedInContext: ["Originality", "80%"] },
  { id: "R16-tool-gsc", prompt: "How do I pull a monthly SEO report?", expectedInContext: ["Google Search Console", "CSV", "clicks"] },
  { id: "R17-workflow", prompt: "What's the content creation workflow?", expectedInContext: ["Lisa", "Airtable", "Sarah", "WordPress"] },
  { id: "R18-complaint-process", prompt: "A client is complaining about an article. What should I do?", expectedInContext: ["Lisa", "2 hours", "Marcus"] },
  { id: "R19-onboarding", prompt: "We're about to sign a new client. What's the onboarding process?", expectedInContext: ["Marcus", "contract", "Airtable", "WordPress"] },
  { id: "R20-status-anderson", prompt: "How's the Anderson order going?", expectedInContext: ["8 articles", "Tuesday"] },
  { id: "R21-status-brightwell", prompt: "Any issues with Brightwell?", expectedInContext: ["missed", "deadline", "factual error"] },
  { id: "R22-status-dave", prompt: "Has Dave been having any problems lately?", expectedInContext: ["missed", "Brightwell", "medical inaccuracy"] },
  { id: "R23-recent-wins", prompt: "Any good news recently?", expectedInContext: ["viral", "LinkedIn"] },
  { id: "R24-rules-content", prompt: "What are the rules for submitting content?", expectedInContext: ["Originality", "Surfer", "Sarah"] },
  { id: "R25-rules-meridian", prompt: "What extra steps do Meridian Health articles need?", expectedInContext: ["medical", "review", "sign-off"] },
  { id: "R26-rules-whitelabel", prompt: "What should I remember about white-label content?", expectedInContext: ["branding", "Canopy"] },
  { id: "R27-rules-deadline", prompt: "What happens when a writer misses a deadline?", expectedInContext: ["Lisa", "24 hours"] },
  { id: "R28-rules-reports", prompt: "When are GSC reports due?", expectedInContext: ["5th", "Marcus"] },
  { id: "R29-comparison-writers", prompt: "Is Peter faster than Dave?", expectedInContext: ["8 article", "4 article"] },
  { id: "R30-comparison-quality", prompt: "Who writes better content, Peter or Dave?", expectedInContext: ["Peter", "Dave", "Surfer"] },
  { id: "R31-revenue", prompt: "How much revenue do we make?", expectedInContext: ["12,600"] },
  { id: "R32-pricing", prompt: "What do we charge per article?", expectedInContext: ["200", "400"] },
  { id: "R33-multihop-who-reviews", prompt: "Who reviews the articles that Peter writes for Anderson?", expectedInContext: ["Sarah"] },
  { id: "R34-multihop-who-manages-client", prompt: "Who should I talk to about Anderson's day-to-day needs?", expectedInContext: ["Lisa"] },
  { id: "R35-multihop-tool-for-task", prompt: "Dave submitted an article. What tools does Sarah need to use to check it?", expectedInContext: ["Surfer", "Originality"] },
  { id: "R36-unknown-entity", prompt: "Who is Rachel?", expectedInContext: [] },
  { id: "R37-trivial", prompt: "ok thanks", expectedInContext: [] },
  { id: "R38-ambiguous", prompt: "What's the status?", expectedInContext: [] },
  { id: "R39-opinion", prompt: "What do I think about Dave?", expectedInContext: ["training", "Meridian"] },
  { id: "R40-brightwell-renewal", prompt: "Is anything coming up with Brightwell?", expectedInContext: ["renewal", "20 articles"] },
];

const STORE_THEN_RETRIEVE = [
  { id: "S01-new-instruction", store: "From now on, always format dates as DD/MM/YYYY", retrieve: "What date format should I use?", expectedInContext: ["DD/MM/YYYY"] },
  { id: "S02-new-person", store: "We just hired Tom as a junior content writer. He'll focus on fintech articles and starts next Monday.", retrieve: "Who is Tom?", expectedInContext: ["Tom", "fintech"] },
  { id: "S03-event-cancel", store: "We just lost the Anderson client. They cancelled the contract.", retrieve: "What happened with Anderson?", expectedInContext: ["cancel"] },
  { id: "S04-correction", store: "Actually, Peter moved to the marketing team. He no longer works on Anderson.", retrieve: "What team is Peter on now?", expectedInContext: ["marketing"] },
  { id: "S05-new-tool", store: "We're now using Grammarly for proofreading. Every article must pass a Grammarly check before going to Sarah.", retrieve: "Do we use Grammarly?", expectedInContext: ["Grammarly", "proofreading"] },
  { id: "S06-new-process", store: "To request time off, send a message in #general on Slack at least 5 days in advance and tag Marcus.", retrieve: "How do I request time off?", expectedInContext: ["Slack", "5 days", "Marcus"] },
  { id: "S07-new-client", store: "Nexus Fintech signed up yesterday. They want 10 articles per month about cryptocurrency regulation. Monthly retainer is £2,500.", retrieve: "Tell me about the Nexus Fintech account", expectedInContext: ["Nexus", "cryptocurrency", "2,500"] },
  { id: "S08-opinion", store: "I think we should stop using Surfer SEO. It's too expensive and the scores don't correlate with actual rankings.", retrieve: "What do I think about Surfer SEO?", expectedInContext: ["expensive", "ranking"] },
  { id: "S09-incident", store: "Dave accidentally published an unfinished draft to the Brightwell WordPress site this morning. Sarah caught it and took it down within 10 minutes.", retrieve: "What happened with the Brightwell site today?", expectedInContext: ["unfinished draft", "Sarah"] },
  { id: "S10-pricing-update", store: "We're raising our standard article price from £200 to £250 starting next month.", retrieve: "What's our article pricing?", expectedInContext: ["250"] },
];

// ── Seed data (same content as benchmark.ts) ─────────────────────────

const SEED_DATA = [
  // Entities
  "Peter — senior content writer at WOBS. Writes articles for client orders. Very reliable, produces ~8 articles per week. Specializes in tech and SaaS content.",
  "Dave — junior content writer at WOBS. Slower than Peter, produces about 4 articles per week. Good at health and wellness topics. Started 3 months ago.",
  "Sarah — editor and QA lead at WOBS. Reviews all articles before publishing. Also manages the Surfer SEO optimization process.",
  "Marcus — co-founder and operations manager at WOBS. Handles client relationships, pricing, and overall business strategy. The user's business partner.",
  "Lisa — client account manager at WOBS. Handles day-to-day client communication, manages the Airtable order tracker, and coordinates deadlines.",
  "James — freelance link builder contracted by WOBS. Works remotely from Portugal. Handles outreach and guest post placements for all clients.",
  "WOBS (Wolf of Blog Street) — a content marketing agency that does link building and content marketing for clients. Founded by Marcus and the user. Team of 6 people. Based in London but mostly remote.",
  "Anderson — a client project at WOBS. Mid-size SaaS company. Order involves 20 articles per month on cloud infrastructure topics. Peter is the primary writer. Monthly retainer: £4,000.",
  "Brightwell — a client project at WOBS. Health supplement company. Order involves 12 articles per month on wellness topics. Dave is the primary writer. Monthly retainer: £2,400.",
  "Meridian Health — a client project at WOBS. Private hospital chain. Sensitive content requiring medical accuracy review. 8 articles per month. Peter and Dave split the writing. Monthly retainer: £3,200.",
  "Canopy Digital — newest client at WOBS. Digital marketing agency that wants white-label content. 15 articles per month across various niches. Started 2 weeks ago. Monthly retainer: £3,000.",
  "Airtable — the main order tracking and project management tool at WOBS. Contains all client orders, article assignments, deadlines, and status tracking. Lisa manages the base.",
  "WordPress — the CMS used for publishing articles to client sites. Each client has their own WordPress instance. WOBS team has editor-level access.",
  "Surfer SEO — content optimization tool used at WOBS. Every article must score at least 75/100 on Surfer before publishing. Sarah runs the Surfer checks.",
  "Originality.ai — AI detection tool used at WOBS. All content must score above 80% original before client delivery.",
  "Google Search Console (GSC) — used to monitor SEO performance of published articles. Monthly reports pulled from GSC for each client. Marcus reviews the reports.",
  "Slack — team communication tool at WOBS. Channels: #general, #orders, #content-review, #client-updates. All urgent issues go to #orders.",
  // Facts
  "Peter writes content for WOBS clients, primarily Anderson and Meridian Health",
  "Dave writes content for WOBS clients, primarily Brightwell and some Meridian Health articles",
  "Sarah reviews and edits all articles before they go to clients. She is the final quality gate.",
  "Lisa manages the Airtable order tracker and is the primary contact for day-to-day client requests",
  "Marcus handles pricing negotiations and big-picture client strategy. He reviews monthly GSC reports.",
  "James does all link building outreach. He places about 30 guest posts per month across all clients.",
  "WOBS total monthly revenue is approximately £12,600 across all four clients",
  "WOBS charges £200 per article for standard content and £400 per article for medical/healthcare content",
  "Meridian Health articles require an additional medical accuracy review step that other clients don't need",
  "Canopy Digital is a white-label client, meaning WOBS content is published under Canopy's brand without WOBS attribution",
  "Peter's articles consistently score above 85 on Surfer SEO and above 90% original on Originality.ai",
  "Dave's articles sometimes need revision — his Surfer scores average around 70, which is below the 75 threshold",
  "Link building costs WOBS about £50 per placement. James invoices monthly.",
  "Anderson is the longest-standing client, been with WOBS for 14 months",
  "Brightwell's contract is up for renewal next month. They've hinted they might increase to 20 articles per month.",
  // Events
  "Peter submitted 8 articles for the Anderson order on Tuesday",
  "Dave missed the Brightwell deadline last Friday — 3 articles were late by 2 days",
  "Sarah flagged 2 of Dave's Meridian Health articles for medical inaccuracy on Monday",
  "Marcus had a call with Anderson's CEO on Wednesday — they're happy with content quality and want to explore video content too",
  "Canopy Digital onboarded last week. Lisa set up their Airtable workspace and WordPress access.",
  "James placed 12 guest posts for Anderson last month, which is above the target of 10",
  "One of Peter's Anderson articles went viral on LinkedIn last week — got 2,000+ shares",
  "Brightwell complained about a factual error in a published article on Wednesday. Dave wrote the article.",
  // Instructions
  "Always check AI detection using Originality.ai before submitting content to clients. Score must be above 80% original.",
  "Every article must score at least 75/100 on Surfer SEO before publishing. If it's below 75, send it back to the writer for optimization.",
  "Never publish an article without Sarah's approval. She must sign off on every piece before it goes live.",
  "Meridian Health articles require an additional step: after Sarah's review, send the article to Meridian's in-house medical reviewer for accuracy sign-off before publishing.",
  "All client communication should go through Lisa unless it's a strategic/pricing discussion, which Marcus handles.",
  "When a writer misses a deadline, immediately notify the client through Lisa and offer expedited delivery within 24 hours.",
  "Monthly GSC reports must be sent to clients by the 5th of each month. Marcus reviews them before they go out.",
  "For white-label clients like Canopy Digital, never include any WOBS branding, watermarks, or attribution in the content.",
  // Processes
  "To look up an order in Airtable: Open the WOBS Orders base → go to the 'Active Orders' view → filter by client name. Each row shows: client, article title, assigned writer, deadline, status (Draft/Review/Published). You can also filter by writer name to see their assignments.",
  "To create a new article assignment in Airtable: In the 'Active Orders' view → click '+ Add record' → fill in: Client (dropdown), Article Title, Target Keyword, Assigned Writer (dropdown), Deadline, Word Count Target. Status will default to 'Draft'.",
  "To update an order status in Airtable: Find the article row → change the Status dropdown from 'Draft' to 'Review' when submitted, 'Review' to 'Published' when live. Add the live URL to the 'Published URL' field.",
  "To publish an article on WordPress: Log into the client's WP admin → Posts → Add New → paste the content → set the category and tags → add the featured image → set the SEO meta title and description in Yoast → click 'Publish'. Make sure the permalink slug matches the target keyword.",
  "To run a Surfer SEO check: Open Surfer → Content Editor → paste the target keyword → paste the article text → check the Content Score. Must be 75+ to pass. If below 75, Surfer will suggest missing terms and topics to add. Send suggestions back to the writer.",
  "To check AI detection with Originality.ai: Go to Originality.ai → Scan → paste the full article text → click 'Scan'. Check the 'Original' percentage. Must be above 80%. If below 80%, the article needs to be rewritten by the writer — do NOT attempt to manually edit it to pass.",
  "To pull a GSC report: Open Google Search Console → select the client's property → Performance → set date range to last 30 days → export as CSV. Key metrics: total clicks, impressions, average CTR, average position. Compare to previous month.",
  "Content creation workflow at WOBS: 1) Lisa creates the assignment in Airtable with keyword and deadline. 2) Writer drafts the article. 3) Writer submits to Sarah for review (status → Review). 4) Sarah checks quality, Surfer score, and Originality score. 5) If passes, Sarah approves and publishes to WordPress. 6) Lisa updates Airtable status to Published.",
  "When dealing with a client complaint: 1) Lisa acknowledges within 2 hours. 2) Lisa investigates — checks the article, who wrote it, what went wrong. 3) Lisa coordinates fix with the writer. 4) If it's a factual error, escalate to Marcus. 5) Fixed article goes through Sarah's review again before re-publishing.",
  "To onboard a new client: 1) Marcus signs the contract and sets up billing. 2) Lisa creates the Airtable workspace for the client. 3) Lisa gets WordPress admin credentials from the client. 4) Lisa creates the first month's article assignments in Airtable. 5) Writers start on articles within 3 days of onboarding.",
  // Opinions
  "I think Dave needs more training before handling Meridian Health articles — the medical inaccuracy issues are concerning",
  "Peter is the best writer we have. If we lose him, we're in trouble.",
  "Canopy Digital might be more trouble than they're worth — the white-label requirement adds complexity and they're paying standard rates",
  "We should probably raise prices for healthcare content. The medical review step makes it much more expensive to produce.",
];

// ── Helpers ──────────────────────────────────────────────────────────

interface QueryResult {
  id: string;
  prompt: string;
  expected: string[];
  hits: string[];
  misses: string[];
  context: string;
  duration_ms: number;
  top_k_count: number;
}

async function runRetrievalQuery(id: string, prompt: string, expected: string[]): Promise<QueryResult> {
  const start = Date.now();

  // Embed query
  const queryVec = (await embed([prompt], "query"))[0];

  // Search top-k
  const candidates = searchItems(queryVec, TOP_K);

  let context = "";
  if (candidates.length > 0 && candidates[0].score > 0.3) {
    // Send to OSS-120B for filtering
    context = await filterWithLLM(prompt, candidates);
  }

  const duration_ms = Date.now() - start;
  const contextNorm = normalize(context);
  const hits = expected.filter((s) => contextNorm.includes(normalize(s)));
  const misses = expected.filter((s) => !contextNorm.includes(normalize(s)));

  return { id, prompt, expected, hits, misses, context, duration_ms, top_k_count: candidates.length };
}

// ── Main ─────────────────────────────────────────────────────────────

resetUsage();

console.log(`\n╔══════════════════════════════════════════════════════════╗`);
console.log(`║      Pure Embedding Benchmark (Voyage 4 + OSS-120B)    ║`);
console.log(`╚══════════════════════════════════════════════════════════╝`);
console.log(`Embeddings: ${VOYAGE_MODEL}`);
console.log(`Filter model: ${L2_MODEL}`);
console.log(`Top-K: ${TOP_K}`);
console.log(`Retrieval queries: ${RETRIEVAL_QUERIES.length}`);
console.log(`Store-retrieve queries: ${STORE_THEN_RETRIEVE.length}`);
console.log(`Total test cases: ${RETRIEVAL_QUERIES.length + STORE_THEN_RETRIEVE.length}`);

if (process.env.SKIP_SEED === "1") {
  const customDbPath = process.env.EMBED_DB_PATH || STORE_DB_PATH;
  console.log(`\n── Using pre-seeded DB (SKIP_SEED=1): ${customDbPath}`);
  initStore(customDbPath);
} else {
  console.log(`\n── Resetting DB and seeding...`);
  try { rmSync(STORE_DB_PATH); } catch {}
  initStore(STORE_DB_PATH);

  // Embed and store all seed data in batches
  const batchSize = 50;
  for (let i = 0; i < SEED_DATA.length; i += batchSize) {
    const batch = SEED_DATA.slice(i, i + batchSize);
    const vectors = await embed(batch);
    for (let j = 0; j < vectors.length; j++) {
      storeItem(batch[j], vectors[j]);
    }
  }
  console.log(`   Seeded ${SEED_DATA.length} items.`);
}
console.log();

// Phase 1: Retrieval
console.log(`── Phase 1: Retrieval Queries (${RETRIEVAL_QUERIES.length}) ──\n`);

const retrievalResults: QueryResult[] = [];

for (const q of RETRIEVAL_QUERIES) {
  process.stdout.write(`  ${q.id}: "${q.prompt.slice(0, 55)}${q.prompt.length > 55 ? '...' : ''}" ... `);
  try {
    const result = await runRetrievalQuery(q.id, q.prompt, q.expectedInContext);
    retrievalResults.push(result);

    const hitPct = q.expectedInContext.length > 0
      ? Math.round((result.hits.length / q.expectedInContext.length) * 100)
      : 100;
    const status = hitPct === 100 ? "\x1b[32m✓\x1b[0m" : hitPct > 0 ? "\x1b[33m~\x1b[0m" : "\x1b[31m✗\x1b[0m";
    console.log(`${status} ${hitPct}% (${result.hits.length}/${q.expectedInContext.length}), top-${result.top_k_count}, ${result.duration_ms}ms`);
    if (result.misses.length > 0) {
      console.log(`    \x1b[31mmisses: ${result.misses.join(", ")}\x1b[0m`);
    }
  } catch (err: any) {
    console.log(`\x1b[31mERROR: ${err.message}\x1b[0m`);
    retrievalResults.push({ id: q.id, prompt: q.prompt, expected: q.expectedInContext, hits: [], misses: q.expectedInContext, context: `ERROR: ${err.message}`, duration_ms: 0, top_k_count: 0 });
  }
}

// Phase 2: Store → Retrieve
console.log(`\n── Phase 2: Store → Retrieve (${STORE_THEN_RETRIEVE.length}) ──\n`);

const storeRetrieveResults: QueryResult[] = [];

for (const q of STORE_THEN_RETRIEVE) {
  console.log(`  ${q.id}: ${q.id}`);

  // Store phase: embed and add to DB
  process.stdout.write(`    store: "${q.store.slice(0, 55)}..." ... `);
  const storeStart = Date.now();
  const storeVec = (await embed([q.store]))[0];
  storeItem(q.store, storeVec);
  console.log(`stored, ${Date.now() - storeStart}ms`);

  // Retrieve phase
  process.stdout.write(`    retrieve: "${q.retrieve.slice(0, 55)}${q.retrieve.length > 55 ? '...' : ''}" ... `);
  try {
    const result = await runRetrievalQuery(q.id, q.retrieve, q.expectedInContext);
    storeRetrieveResults.push(result);

    const hitPct = q.expectedInContext.length > 0
      ? Math.round((result.hits.length / q.expectedInContext.length) * 100)
      : 100;
    const status = hitPct === 100 ? "\x1b[32m✓\x1b[0m" : hitPct > 0 ? "\x1b[33m~\x1b[0m" : "\x1b[31m✗\x1b[0m";
    console.log(`${status} ${hitPct}% (${result.hits.length}/${q.expectedInContext.length}), top-${result.top_k_count}, ${result.duration_ms}ms`);
    if (result.misses.length > 0) {
      console.log(`    \x1b[31mmisses: ${result.misses.join(", ")}\x1b[0m`);
    }
  } catch (err: any) {
    console.log(`\x1b[31mERROR: ${err.message}\x1b[0m`);
    storeRetrieveResults.push({ id: q.id, prompt: q.retrieve, expected: q.expectedInContext, hits: [], misses: q.expectedInContext, context: `ERROR: ${err.message}`, duration_ms: 0, top_k_count: 0 });
  }
}

// ── Summary ──────────────────────────────────────────────────────────

const retrievalWithExpected = retrievalResults.filter((q) => q.expected.length > 0);
const rExpected = retrievalWithExpected.reduce((s, q) => s + q.expected.length, 0);
const rHits = retrievalWithExpected.reduce((s, q) => s + q.hits.length, 0);
const sExpected = storeRetrieveResults.reduce((s, q) => s + q.expected.length, 0);
const sHits = storeRetrieveResults.reduce((s, q) => s + q.hits.length, 0);
const totalExpected = rExpected + sExpected;
const totalHits = rHits + sHits;
const fullPassRetrieval = retrievalWithExpected.filter((q) => q.misses.length === 0).length;
const fullPassStore = storeRetrieveResults.filter((q) => q.misses.length === 0).length;
const totalDuration = [...retrievalResults, ...storeRetrieveResults].reduce((s, q) => s + q.duration_ms, 0);
const totalQueries = retrievalResults.length + storeRetrieveResults.length * 2; // store + retrieve calls

const usage = getUsage();
const costs = calculateCosts("openai/gpt-oss-120b", L2_MODEL, VOYAGE_MODEL, usage);
const errorCount = retrievalResults.filter(q => q.context.startsWith("ERROR:")).length;

console.log(`\n══════════════════════════════════════════════════════════`);
console.log(`  SUMMARY — Pure Embedding System`);
console.log(`══════════════════════════════════════════════════════════`);
console.log(`  Filter model: ${L2_MODEL.split("/").pop()}`);
console.log(`  Embed: ${VOYAGE_MODEL}, Top-K: ${TOP_K}`);
console.log(`  ──────────────────────────────────────`);
console.log(`  Retrieval hit rate:      ${rExpected > 0 ? Math.round((rHits / rExpected) * 100) : 100}% (${rHits}/${rExpected} expected strings)`);
console.log(`  Retrieval full-pass:     ${fullPassRetrieval}/${retrievalWithExpected.length} queries`);
console.log(`  Store→Retrieve hit rate: ${sExpected > 0 ? Math.round((sHits / sExpected) * 100) : 100}% (${sHits}/${sExpected} expected strings)`);
console.log(`  Store→Retrieve full-pass:${fullPassStore}/${storeRetrieveResults.length} queries`);
console.log(`  ──────────────────────────────────────`);
console.log(`  Overall hit rate:        ${totalExpected > 0 ? Math.round((totalHits / totalExpected) * 100) : 100}%`);
console.log(`  Avg time/query:          ${Math.round(totalDuration / (retrievalResults.length + storeRetrieveResults.length))}ms`);
console.log(`  Total time:              ${Math.round(totalDuration / 1000)}s`);
if (errorCount > 0) console.log(`  Errors:                  ${errorCount}`);
console.log(`  ──────────────────────────────────────`);
console.log(`  COSTS`);
console.log(`  L1 tokens:    0 (no L1 layer)`);
console.log(`  L2 tokens:    ${usage.l2_input.toLocaleString()} in / ${usage.l2_output.toLocaleString()} out → $${costs.l2_cost.toFixed(4)}`);
console.log(`  Embed tokens: ${usage.embedding_tokens.toLocaleString()} → $${costs.embedding_cost.toFixed(4)}`);
console.log(`  Total cost:   $${costs.total_cost.toFixed(4)}`);
console.log(`══════════════════════════════════════════════════════════\n`);

// Save results
const benchDir = join(process.env.HOME || "~", ".octybot", "test", "benchmarks");
mkdirSync(benchDir, { recursive: true });
const filename = `${new Date().toISOString().replace(/[:.]/g, "-")}_PURE-EMBED_${VOYAGE_MODEL}_${L2_MODEL.split("/").pop()}.json`;
const filepath = join(benchDir, filename);
writeFileSync(filepath, JSON.stringify({
  system: "pure-embedding",
  timestamp: new Date().toISOString(),
  models: { filter: L2_MODEL, embedding: VOYAGE_MODEL },
  top_k: TOP_K,
  retrieval_results: retrievalResults,
  store_retrieve_results: storeRetrieveResults,
}, null, 2));
console.log(`Results saved to: ${filepath}`);

// Save to results DB
const queryRecords: QueryRecord[] = [];
for (const q of retrievalResults) {
  queryRecords.push({
    query_id: q.id, phase: "retrieval", prompt: q.prompt,
    expected_count: q.expected.length, hit_count: q.hits.length,
    misses: q.misses, tool_calls: 1, terminated_by: "done_tool",
    duration_ms: q.duration_ms, context_preview: q.context,
  });
}
for (const q of storeRetrieveResults) {
  queryRecords.push({
    query_id: q.id + "-retrieve", phase: "store_retrieve", prompt: q.prompt,
    expected_count: q.expected.length, hit_count: q.hits.length,
    misses: q.misses, tool_calls: 1, terminated_by: "done_tool",
    duration_ms: q.duration_ms, context_preview: q.context,
  });
}

const overallHitRate = totalExpected > 0 ? Math.round((totalHits / totalExpected) * 100) : 100;
const runId = saveRun({
  timestamp: new Date().toISOString(),
  l1_model: "none (pure-embed)", l2_model: L2_MODEL, embedding_model: VOYAGE_MODEL,
  test_suite: "v2",
  total_queries: totalQueries,
  retrieval_queries: RETRIEVAL_QUERIES.length,
  store_queries: STORE_THEN_RETRIEVE.length,
  retrieval_hit_rate: rExpected > 0 ? Math.round((rHits / rExpected) * 100) : 100,
  store_hit_rate: sExpected > 0 ? Math.round((sHits / sExpected) * 100) : 100,
  overall_hit_rate: overallHitRate,
  retrieval_full_pass: fullPassRetrieval,
  retrieval_full_pass_total: retrievalWithExpected.length,
  store_full_pass: fullPassStore,
  store_full_pass_total: storeRetrieveResults.length,
  done_tool_rate: 100,
  avg_tool_calls: 1,
  avg_duration_ms: Math.round(totalDuration / (retrievalResults.length + storeRetrieveResults.length)),
  total_duration_ms: totalDuration,
  l1_input_tokens: 0, l1_output_tokens: 0,
  l2_input_tokens: usage.l2_input, l2_output_tokens: usage.l2_output,
  embedding_tokens: usage.embedding_tokens,
  l1_cost_usd: 0, l2_cost_usd: costs.l2_cost,
  embedding_cost_usd: costs.embedding_cost, total_cost_usd: costs.total_cost,
  errors: errorCount,
  notes: "Pure embedding system — no graph, no tools, no L1. Top-10 cosine + OSS-120B filter.",
}, queryRecords);

closeResultsDb();
closeStore();
console.log(`Results saved to DB (run #${runId})\n`);
