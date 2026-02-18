/**
 * Seeds the local memory DB with test data — a realistic content marketing business.
 *
 * Usage: bun pa-test-1/seed.ts
 *
 * Models a business (WOBS) with:
 * - 6 people (writers, editors, managers)
 * - 4 clients/projects
 * - 6 tools (Airtable, WordPress, Surfer SEO, Originality.ai, GSC, Slack)
 * - Detailed processes (content workflow, Airtable lookups, publishing)
 * - Business rules and instructions
 * - Recent events and incidents
 */
import { getDb } from "../src/memory/db-core";
import { createNode as _createNode, createEdge as _createEdge } from "../src/memory/db-crud";
import { storeEmbedding as _storeEmbedding } from "../src/memory/vectors";
import { embed } from "../src/memory/voyage";

const db = getDb();

// Bind db to CRUD functions so callers don't need to pass it
const createNode = (node: Parameters<typeof _createNode>[1]) => _createNode(db, node);
const createEdge = (edge: Parameters<typeof _createEdge>[1]) => _createEdge(db, edge);
const storeEmbedding = (nodeId: string, nodeType: string, vec: number[]) => _storeEmbedding(db, nodeId, nodeType, vec);

console.log("Seeding test data...\n");

// ── Entities: People ─────────────────────────────────────────────────

const peterId = createNode({
  node_type: "entity", subtype: "person",
  content: "Peter — senior content writer at WOBS. Writes articles for client orders. Very reliable, produces ~8 articles per week. Specializes in tech and SaaS content.",
  salience: 1.3, confidence: 1.0, source: "user",
  attributes: { aliases: ["Pete"], role: "senior content writer", rate: "8 articles/week", specialty: "tech/SaaS" },
});

const daveId = createNode({
  node_type: "entity", subtype: "person",
  content: "Dave — junior content writer at WOBS. Slower than Peter, produces about 4 articles per week. Good at health and wellness topics. Started 3 months ago.",
  salience: 1.0, confidence: 1.0, source: "user",
  attributes: { aliases: [], role: "junior content writer", rate: "4 articles/week", specialty: "health/wellness" },
});

const sarahId = createNode({
  node_type: "entity", subtype: "person",
  content: "Sarah — editor and QA lead at WOBS. Reviews all articles before publishing. Also manages the Surfer SEO optimization process.",
  salience: 1.1, confidence: 1.0, source: "user",
  attributes: { aliases: [], role: "editor / QA lead" },
});

const marcusId = createNode({
  node_type: "entity", subtype: "person",
  content: "Marcus — co-founder and operations manager at WOBS. Handles client relationships, pricing, and overall business strategy. The user's business partner.",
  salience: 1.3, confidence: 1.0, source: "user",
  attributes: { aliases: ["Marc"], role: "co-founder / ops manager" },
});

const lisaId = createNode({
  node_type: "entity", subtype: "person",
  content: "Lisa — client account manager at WOBS. Handles day-to-day client communication, manages the Airtable order tracker, and coordinates deadlines.",
  salience: 1.0, confidence: 1.0, source: "user",
  attributes: { aliases: [], role: "account manager" },
});

const jamesId = createNode({
  node_type: "entity", subtype: "person",
  content: "James — freelance link builder contracted by WOBS. Works remotely from Portugal. Handles outreach and guest post placements for all clients.",
  salience: 1.0, confidence: 1.0, source: "user",
  attributes: { aliases: ["Jim"], role: "freelance link builder", location: "Portugal" },
});

console.log("Created 6 people: Peter, Dave, Sarah, Marcus, Lisa, James");

// ── Entities: Organization ───────────────────────────────────────────

const wobsId = createNode({
  node_type: "entity", subtype: "org",
  content: "WOBS (Wolf of Blog Street) — a content marketing agency that does link building and content marketing for clients. Founded by Marcus and the user. Team of 6 people. Based in London but mostly remote.",
  salience: 1.3, confidence: 1.0, source: "user",
  attributes: { aliases: ["Wolf of Blog Street"], industry: "content marketing", location: "London (remote)" },
});

console.log("Created org: WOBS");

// ── Entities: Clients/Projects ───────────────────────────────────────

const andersonId = createNode({
  node_type: "entity", subtype: "project",
  content: "Anderson — a client project at WOBS. Mid-size SaaS company. Order involves 20 articles per month on cloud infrastructure topics. Peter is the primary writer. Monthly retainer: £4,000.",
  salience: 1.1, confidence: 1.0, source: "user",
  attributes: { type: "client order", niche: "cloud/SaaS", articles_per_month: 20, retainer: "£4,000/month" },
});

const brightwellId = createNode({
  node_type: "entity", subtype: "project",
  content: "Brightwell — a client project at WOBS. Health supplement company. Order involves 12 articles per month on wellness topics. Dave is the primary writer. Monthly retainer: £2,400.",
  salience: 1.0, confidence: 1.0, source: "user",
  attributes: { type: "client order", niche: "health/wellness", articles_per_month: 12, retainer: "£2,400/month" },
});

const meridianId = createNode({
  node_type: "entity", subtype: "project",
  content: "Meridian Health — a client project at WOBS. Private hospital chain. Sensitive content requiring medical accuracy review. 8 articles per month. Peter and Dave split the writing. Monthly retainer: £3,200.",
  salience: 1.1, confidence: 1.0, source: "user",
  attributes: { type: "client order", niche: "healthcare", articles_per_month: 8, retainer: "£3,200/month" },
});

const canopyId = createNode({
  node_type: "entity", subtype: "project",
  content: "Canopy Digital — newest client at WOBS. Digital marketing agency that wants white-label content. 15 articles per month across various niches. Started 2 weeks ago. Monthly retainer: £3,000.",
  salience: 1.0, confidence: 1.0, source: "user",
  attributes: { type: "client order", niche: "mixed/white-label", articles_per_month: 15, retainer: "£3,000/month" },
});

console.log("Created 4 clients: Anderson, Brightwell, Meridian Health, Canopy Digital");

// ── Entities: Tools ──────────────────────────────────────────────────

const airtableId = createNode({
  node_type: "entity", subtype: "tool",
  content: "Airtable — the main order tracking and project management tool at WOBS. Contains all client orders, article assignments, deadlines, and status tracking. Lisa manages the base. URL: https://airtable.com/wobs-orders",
  salience: 1.5, confidence: 1.0, source: "user",
  attributes: { type: "project management", url: "https://airtable.com/wobs-orders" },
});

const wordpressId = createNode({
  node_type: "entity", subtype: "tool",
  content: "WordPress — the CMS used for publishing articles to client sites. Each client has their own WordPress instance. WOBS team has editor-level access to all client sites.",
  salience: 1.5, confidence: 1.0, source: "user",
  attributes: { type: "CMS" },
});

const surferId = createNode({
  node_type: "entity", subtype: "tool",
  content: "Surfer SEO — content optimization tool used at WOBS. Every article must score at least 75/100 on Surfer before publishing. Sarah runs the Surfer checks.",
  salience: 1.5, confidence: 1.0, source: "user",
  attributes: { type: "SEO optimization", threshold: 75 },
});

const originalityId = createNode({
  node_type: "entity", subtype: "tool",
  content: "Originality.ai — AI detection tool used at WOBS. All content must score above 80% original (i.e., below 20% AI-detected) before client delivery. This is the AI detector tool.",
  salience: 1.5, confidence: 1.0, source: "user",
  attributes: { type: "AI detection", threshold: "80% original" },
});

const gscId = createNode({
  node_type: "entity", subtype: "tool",
  content: "Google Search Console (GSC) — used to monitor SEO performance of published articles. Monthly reports pulled from GSC for each client. Marcus reviews the reports.",
  salience: 1.5, confidence: 1.0, source: "user",
  attributes: { aliases: ["GSC"], type: "SEO monitoring" },
});

const slackId = createNode({
  node_type: "entity", subtype: "tool",
  content: "Slack — team communication tool at WOBS. Channels: #general, #orders, #content-review, #client-updates. All urgent issues go to #orders.",
  salience: 1.0, confidence: 1.0, source: "user",
  attributes: { type: "communication", channels: ["#general", "#orders", "#content-review", "#client-updates"] },
});

console.log("Created 6 tools: Airtable, WordPress, Surfer SEO, Originality.ai, GSC, Slack");

// ── Facts ────────────────────────────────────────────────────────────

const facts: Array<{ content: string; subtype: string; salience: number; links: Array<{ target: string; edge: string }> }> = [
  // Team structure
  { content: "Peter writes content for WOBS clients, primarily Anderson and Meridian Health", subtype: "definitional", salience: 0.9,
    links: [{ target: peterId, edge: "about" }, { target: wobsId, edge: "about" }] },
  { content: "Dave writes content for WOBS clients, primarily Brightwell and some Meridian Health articles", subtype: "definitional", salience: 0.9,
    links: [{ target: daveId, edge: "about" }, { target: wobsId, edge: "about" }] },
  { content: "Sarah reviews and edits all articles before they go to clients. She is the final quality gate.", subtype: "definitional", salience: 0.9,
    links: [{ target: sarahId, edge: "about" }] },
  { content: "Lisa manages the Airtable order tracker and is the primary contact for day-to-day client requests", subtype: "definitional", salience: 0.9,
    links: [{ target: lisaId, edge: "about" }, { target: airtableId, edge: "about" }] },
  { content: "Marcus handles pricing negotiations and big-picture client strategy. He reviews monthly GSC reports.", subtype: "definitional", salience: 0.9,
    links: [{ target: marcusId, edge: "about" }] },
  { content: "James does all link building outreach. He places about 30 guest posts per month across all clients.", subtype: "definitional", salience: 0.9,
    links: [{ target: jamesId, edge: "about" }] },

  // Business facts
  { content: "WOBS total monthly revenue is approximately £12,600 across all four clients", subtype: "definitional", salience: 1.0,
    links: [{ target: wobsId, edge: "about" }] },
  { content: "WOBS charges £200 per article for standard content and £400 per article for medical/healthcare content", subtype: "definitional", salience: 1.0,
    links: [{ target: wobsId, edge: "about" }] },
  { content: "Meridian Health articles require an additional medical accuracy review step that other clients don't need", subtype: "conditional", salience: 0.9,
    links: [{ target: meridianId, edge: "about" }] },
  { content: "Canopy Digital is a white-label client, meaning WOBS content is published under Canopy's brand without WOBS attribution", subtype: "definitional", salience: 0.9,
    links: [{ target: canopyId, edge: "about" }] },
  { content: "Peter's articles consistently score above 85 on Surfer SEO and above 90% original on Originality.ai", subtype: "comparative", salience: 0.9,
    links: [{ target: peterId, edge: "about" }, { target: surferId, edge: "about" }] },
  { content: "Dave's articles sometimes need revision — his Surfer scores average around 70, which is below the 75 threshold", subtype: "comparative", salience: 0.9,
    links: [{ target: daveId, edge: "about" }, { target: surferId, edge: "about" }] },
  { content: "Link building costs WOBS about £50 per placement. James invoices monthly.", subtype: "definitional", salience: 0.9,
    links: [{ target: jamesId, edge: "about" }, { target: wobsId, edge: "about" }] },
  { content: "Anderson is the longest-standing client, been with WOBS for 14 months", subtype: "definitional", salience: 0.9,
    links: [{ target: andersonId, edge: "about" }] },
  { content: "Brightwell's contract is up for renewal next month. They've hinted they might increase to 20 articles per month.", subtype: "conditional", salience: 0.9,
    links: [{ target: brightwellId, edge: "about" }] },
];

const factIds: string[] = [];
for (const f of facts) {
  const id = createNode({
    node_type: "fact", subtype: f.subtype, content: f.content,
    salience: f.salience, confidence: 1.0, source: "user", attributes: {},
  });
  factIds.push(id);
  for (const link of f.links) {
    createEdge({ source_id: id, target_id: link.target, edge_type: link.edge });
  }
}
console.log(`Created ${facts.length} facts`);

// ── Events ───────────────────────────────────────────────────────────

const events: Array<{ content: string; subtype: string; salience: number; links: Array<{ target: string; edge: string }> }> = [
  { content: "Peter submitted 8 articles for the Anderson order on Tuesday", subtype: "action", salience: 0.6,
    links: [{ target: peterId, edge: "about" }, { target: andersonId, edge: "about" }] },
  { content: "Dave missed the Brightwell deadline last Friday — 3 articles were late by 2 days", subtype: "incident", salience: 1.0,
    links: [{ target: daveId, edge: "about" }, { target: brightwellId, edge: "about" }] },
  { content: "Sarah flagged 2 of Dave's Meridian Health articles for medical inaccuracy on Monday", subtype: "incident", salience: 1.0,
    links: [{ target: sarahId, edge: "about" }, { target: daveId, edge: "about" }, { target: meridianId, edge: "about" }] },
  { content: "Marcus had a call with Anderson's CEO on Wednesday — they're happy with content quality and want to explore video content too", subtype: "conversation", salience: 0.6,
    links: [{ target: marcusId, edge: "about" }, { target: andersonId, edge: "about" }] },
  { content: "Canopy Digital onboarded last week. Lisa set up their Airtable workspace and WordPress access.", subtype: "action", salience: 0.6,
    links: [{ target: canopyId, edge: "about" }, { target: lisaId, edge: "about" }] },
  { content: "James placed 12 guest posts for Anderson last month, which is above the target of 10", subtype: "outcome", salience: 0.6,
    links: [{ target: jamesId, edge: "about" }, { target: andersonId, edge: "about" }] },
  { content: "One of Peter's Anderson articles went viral on LinkedIn last week — got 2,000+ shares", subtype: "outcome", salience: 1.0,
    links: [{ target: peterId, edge: "about" }, { target: andersonId, edge: "about" }] },
  { content: "Brightwell complained about a factual error in a published article on Wednesday. Dave wrote the article.", subtype: "incident", salience: 1.0,
    links: [{ target: brightwellId, edge: "about" }, { target: daveId, edge: "about" }] },
];

const eventIds: string[] = [];
for (const e of events) {
  const id = createNode({
    node_type: "event", subtype: e.subtype, content: e.content,
    salience: e.salience, confidence: 1.0, source: "user", attributes: {},
  });
  eventIds.push(id);
  for (const link of e.links) {
    createEdge({ source_id: id, target_id: link.target, edge_type: link.edge });
  }
}
console.log(`Created ${events.length} events`);

// ── Instructions ─────────────────────────────────────────────────────

const instructions: Array<{ content: string; subtype: string; salience: number; scope: number; links: Array<{ target: string; edge: string }> }> = [
  { content: "Always check AI detection using Originality.ai before submitting content to clients. Score must be above 80% original.", subtype: "instruction", salience: 2.5, scope: 1.0,
    links: [{ target: originalityId, edge: "about" }, { target: wobsId, edge: "about" }] },
  { content: "Every article must score at least 75/100 on Surfer SEO before publishing. If it's below 75, send it back to the writer for optimization.", subtype: "instruction", salience: 2.5, scope: 1.0,
    links: [{ target: surferId, edge: "about" }] },
  { content: "Never publish an article without Sarah's approval. She must sign off on every piece before it goes live.", subtype: "instruction", salience: 2.5, scope: 1.0,
    links: [{ target: sarahId, edge: "about" }] },
  { content: "Meridian Health articles require an additional step: after Sarah's review, send the article to Meridian's in-house medical reviewer for accuracy sign-off before publishing.", subtype: "instruction", salience: 2.0, scope: 0.3,
    links: [{ target: meridianId, edge: "about" }] },
  { content: "All client communication should go through Lisa unless it's a strategic/pricing discussion, which Marcus handles.", subtype: "instruction", salience: 2.0, scope: 0.9,
    links: [{ target: lisaId, edge: "about" }, { target: marcusId, edge: "about" }] },
  { content: "When a writer misses a deadline, immediately notify the client through Lisa and offer expedited delivery within 24 hours.", subtype: "instruction", salience: 2.0, scope: 0.9,
    links: [{ target: lisaId, edge: "about" }] },
  { content: "Monthly GSC reports must be sent to clients by the 5th of each month. Marcus reviews them before they go out.", subtype: "instruction", salience: 2.0, scope: 0.8,
    links: [{ target: gscId, edge: "about" }, { target: marcusId, edge: "about" }] },
  { content: "For white-label clients like Canopy Digital, never include any WOBS branding, watermarks, or attribution in the content.", subtype: "instruction", salience: 2.0, scope: 0.3,
    links: [{ target: canopyId, edge: "about" }] },
];

const instrIds: string[] = [];
for (const instr of instructions) {
  const id = createNode({
    node_type: "instruction", subtype: instr.subtype, content: instr.content,
    salience: instr.salience, confidence: 1.0, source: "user", attributes: {},
    scope: instr.scope,
  });
  instrIds.push(id);
  for (const link of instr.links) {
    createEdge({ source_id: id, target_id: link.target, edge_type: link.edge });
  }
}
console.log(`Created ${instructions.length} instructions`);

// ── Tool Usage / Processes ───────────────────────────────────────────

const processes: Array<{ content: string; salience: number; scope: number; links: Array<{ target: string; edge: string }> }> = [
  { content: "To look up an order in Airtable: Open the WOBS Orders base → go to the 'Active Orders' view → filter by client name. Each row shows: client, article title, assigned writer, deadline, status (Draft/Review/Published). You can also filter by writer name to see their assignments.", salience: 1.8, scope: 0.5,
    links: [{ target: airtableId, edge: "about" }] },
  { content: "To create a new article assignment in Airtable: In the 'Active Orders' view → click '+ Add record' → fill in: Client (dropdown), Article Title, Target Keyword, Assigned Writer (dropdown), Deadline, Word Count Target. Status will default to 'Draft'.", salience: 1.5, scope: 0.5,
    links: [{ target: airtableId, edge: "about" }] },
  { content: "To update an order status in Airtable: Find the article row → change the Status dropdown from 'Draft' to 'Review' when submitted, 'Review' to 'Published' when live. Add the live URL to the 'Published URL' field.", salience: 1.5, scope: 0.5,
    links: [{ target: airtableId, edge: "about" }] },
  { content: "To publish an article on WordPress: Log into the client's WP admin → Posts → Add New → paste the content → set the category and tags → add the featured image → set the SEO meta title and description in Yoast → click 'Publish'. Make sure the permalink slug matches the target keyword.", salience: 1.5, scope: 0.5,
    links: [{ target: wordpressId, edge: "about" }] },
  { content: "To run a Surfer SEO check: Open Surfer → Content Editor → paste the target keyword → paste the article text → check the Content Score. Must be 75+ to pass. If below 75, Surfer will suggest missing terms and topics to add. Send suggestions back to the writer.", salience: 1.8, scope: 0.5,
    links: [{ target: surferId, edge: "about" }] },
  { content: "To check AI detection with Originality.ai: Go to Originality.ai → Scan → paste the full article text → click 'Scan'. Check the 'Original' percentage. Must be above 80%. If below 80%, the article needs to be rewritten by the writer — do NOT attempt to manually edit it to pass.", salience: 1.8, scope: 0.5,
    links: [{ target: originalityId, edge: "about" }] },
  { content: "To pull a GSC report: Open Google Search Console → select the client's property → Performance → set date range to last 30 days → export as CSV. Key metrics: total clicks, impressions, average CTR, average position. Compare to previous month.", salience: 1.5, scope: 0.5,
    links: [{ target: gscId, edge: "about" }] },
  { content: "Content creation workflow at WOBS: 1) Lisa creates the assignment in Airtable with keyword and deadline. 2) Writer drafts the article. 3) Writer submits to Sarah for review (status → Review). 4) Sarah checks quality, Surfer score, and Originality score. 5) If passes, Sarah approves and publishes to WordPress. 6) Lisa updates Airtable status to Published.", salience: 1.8, scope: 0.7,
    links: [{ target: wobsId, edge: "about" }, { target: airtableId, edge: "about" }, { target: wordpressId, edge: "about" }] },
  { content: "When dealing with a client complaint: 1) Lisa acknowledges within 2 hours. 2) Lisa investigates — checks the article, who wrote it, what went wrong. 3) Lisa coordinates fix with the writer. 4) If it's a factual error, escalate to Marcus. 5) Fixed article goes through Sarah's review again before re-publishing.", salience: 1.8, scope: 0.7,
    links: [{ target: lisaId, edge: "about" }, { target: marcusId, edge: "about" }] },
  { content: "To onboard a new client: 1) Marcus signs the contract and sets up billing. 2) Lisa creates the Airtable workspace for the client. 3) Lisa gets WordPress admin credentials from the client. 4) Lisa creates the first month's article assignments in Airtable. 5) Writers start on articles within 3 days of onboarding.", salience: 1.8, scope: 0.7,
    links: [{ target: marcusId, edge: "about" }, { target: lisaId, edge: "about" }, { target: airtableId, edge: "about" }] },
];

const processIds: string[] = [];
for (const p of processes) {
  const id = createNode({
    node_type: "instruction", subtype: "tool_usage", content: p.content,
    salience: p.salience, confidence: 1.0, source: "user", attributes: {},
    scope: p.scope,
  });
  processIds.push(id);
  for (const link of p.links) {
    createEdge({ source_id: id, target_id: link.target, edge_type: link.edge });
  }
}
console.log(`Created ${processes.length} tool usage / processes`);

// ── Opinions ─────────────────────────────────────────────────────────

const opinions: Array<{ content: string; salience: number; links: Array<{ target: string; edge: string }> }> = [
  { content: "I think Dave needs more training before handling Meridian Health articles — the medical inaccuracy issues are concerning", salience: 1.0,
    links: [{ target: daveId, edge: "about" }, { target: meridianId, edge: "about" }] },
  { content: "Peter is the best writer we have. If we lose him, we're in trouble.", salience: 1.0,
    links: [{ target: peterId, edge: "about" }] },
  { content: "Canopy Digital might be more trouble than they're worth — the white-label requirement adds complexity and they're paying standard rates", salience: 1.0,
    links: [{ target: canopyId, edge: "about" }] },
  { content: "We should probably raise prices for healthcare content. The medical review step makes it much more expensive to produce.", salience: 1.0,
    links: [{ target: meridianId, edge: "about" }, { target: wobsId, edge: "about" }] },
];

for (const o of opinions) {
  const id = createNode({
    node_type: "opinion", subtype: "user_opinion", content: o.content,
    salience: o.salience, confidence: 1.0, source: "user", attributes: {},
  });
  for (const link of o.links) {
    createEdge({ source_id: id, target_id: link.target, edge_type: link.edge });
  }
}
console.log(`Created ${opinions.length} opinions`);

// ── Structural Edges (team relationships) ────────────────────────────

const structEdges = [
  // People → org
  { source_id: peterId, target_id: wobsId, edge_type: "works_for" },
  { source_id: daveId, target_id: wobsId, edge_type: "works_for" },
  { source_id: sarahId, target_id: wobsId, edge_type: "works_for" },
  { source_id: marcusId, target_id: wobsId, edge_type: "co_founder_of" },
  { source_id: lisaId, target_id: wobsId, edge_type: "works_for" },
  { source_id: jamesId, target_id: wobsId, edge_type: "contracted_by" },

  // People → projects
  { source_id: peterId, target_id: andersonId, edge_type: "writes_for" },
  { source_id: peterId, target_id: meridianId, edge_type: "writes_for" },
  { source_id: daveId, target_id: brightwellId, edge_type: "writes_for" },
  { source_id: daveId, target_id: meridianId, edge_type: "writes_for" },
  { source_id: sarahId, target_id: andersonId, edge_type: "reviews_for" },
  { source_id: sarahId, target_id: brightwellId, edge_type: "reviews_for" },
  { source_id: sarahId, target_id: meridianId, edge_type: "reviews_for" },
  { source_id: sarahId, target_id: canopyId, edge_type: "reviews_for" },
  { source_id: lisaId, target_id: andersonId, edge_type: "manages" },
  { source_id: lisaId, target_id: brightwellId, edge_type: "manages" },
  { source_id: lisaId, target_id: meridianId, edge_type: "manages" },
  { source_id: lisaId, target_id: canopyId, edge_type: "manages" },
  { source_id: jamesId, target_id: andersonId, edge_type: "builds_links_for" },
  { source_id: jamesId, target_id: brightwellId, edge_type: "builds_links_for" },
  { source_id: jamesId, target_id: meridianId, edge_type: "builds_links_for" },

  // Projects → org
  { source_id: andersonId, target_id: wobsId, edge_type: "client_of" },
  { source_id: brightwellId, target_id: wobsId, edge_type: "client_of" },
  { source_id: meridianId, target_id: wobsId, edge_type: "client_of" },
  { source_id: canopyId, target_id: wobsId, edge_type: "client_of" },

  // Tools → org
  { source_id: airtableId, target_id: wobsId, edge_type: "used_by" },
  { source_id: wordpressId, target_id: wobsId, edge_type: "used_by" },
  { source_id: surferId, target_id: wobsId, edge_type: "used_by" },
  { source_id: originalityId, target_id: wobsId, edge_type: "used_by" },
  { source_id: gscId, target_id: wobsId, edge_type: "used_by" },
  { source_id: slackId, target_id: wobsId, edge_type: "used_by" },

  // People → tools
  { source_id: lisaId, target_id: airtableId, edge_type: "manages" },
  { source_id: sarahId, target_id: surferId, edge_type: "manages" },
  { source_id: marcusId, target_id: gscId, edge_type: "reviews" },
];

for (const e of structEdges) {
  createEdge(e);
}
console.log(`Created ${structEdges.length} structural edges`);

// ── Embeddings ───────────────────────────────────────────────────────

console.log("\nGenerating embeddings...");

// Collect ALL nodes that need embeddings
const allNodes: Array<{ id: string; type: string; text: string }> = [
  // Entities
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

// Facts, events, instructions, processes, opinions — use content directly
for (let i = 0; i < facts.length; i++) {
  allNodes.push({ id: factIds[i], type: "fact", text: facts[i].content });
}
for (let i = 0; i < events.length; i++) {
  allNodes.push({ id: eventIds[i], type: "event", text: events[i].content });
}
for (let i = 0; i < instructions.length; i++) {
  allNodes.push({ id: instrIds[i], type: "instruction", text: instructions[i].content });
}
for (let i = 0; i < processes.length; i++) {
  allNodes.push({ id: processIds[i], type: "instruction", text: processes[i].content });
}

// Batch embed (API supports up to 128 texts)
const texts = allNodes.map((n) => n.text);
const batchSize = 50;
for (let start = 0; start < texts.length; start += batchSize) {
  const batch = texts.slice(start, start + batchSize);
  const vectors = await embed(batch);
  for (let j = 0; j < vectors.length; j++) {
    storeEmbedding(allNodes[start + j].id, allNodes[start + j].type, vectors[j]);
  }
  console.log(`  Embedded batch ${Math.floor(start / batchSize) + 1} (${start + vectors.length}/${texts.length})`);
}

const totalEdges = structEdges.length + facts.reduce((s, f) => s + f.links.length, 0) + events.reduce((s, e) => s + e.links.length, 0) + instructions.reduce((s, i) => s + i.links.length, 0) + processes.reduce((s, p) => s + p.links.length, 0) + opinions.reduce((s, o) => s + o.links.length, 0);
console.log(`\nDone! Seeded ${allNodes.length} nodes, ${totalEdges} edges, ${allNodes.length} embeddings.`);
