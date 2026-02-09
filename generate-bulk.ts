/**
 * Deterministic bulk data generator for 20K scale testing.
 *
 * Seeds the graph DB (memory.db) and optionally the flat vector DB (pure-embed.db)
 * with ~20,000 items on top of the original 62 seed items.
 *
 * Usage:
 *   bun pa-test-1/generate-bulk.ts
 *   GRAPH_ONLY=1 bun pa-test-1/generate-bulk.ts
 *   GRAPH_DB_PATH=/custom/path.db bun pa-test-1/generate-bulk.ts
 *
 * Output:
 *   ~/.octybot/test/memory-bulk.db     (graph DB)
 *   ~/.octybot/test/pure-embed-bulk.db (flat vector DB)
 */
import { mkdirSync, rmSync } from "fs";
import { join, dirname } from "path";
import { Database } from "bun:sqlite";
import { embed } from "./memory/voyage";

// ── Config ───────────────────────────────────────────────────────────

const HOME = process.env.HOME || "~";
const GRAPH_DB_PATH =
  process.env.GRAPH_DB_PATH || join(HOME, ".octybot", "test", "memory-bulk.db");
const EMBED_DB_PATH =
  process.env.EMBED_DB_PATH || join(HOME, ".octybot", "test", "pure-embed-bulk.db");
const GRAPH_ONLY = process.env.GRAPH_ONLY === "1";
const SEED = 42;
const EMBED_BATCH_SIZE = 128; // Voyage max batch

// ── Seeded PRNG (mulberry32) ─────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = mulberry32(SEED);

function pick<T>(arr: T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

function pickN<T>(arr: T[], n: number): T[] {
  const shuffled = [...arr];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, n);
}

function randInt(min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

function randDate(startYear: number, startMonth: number, endYear: number, endMonth: number): string {
  const start = new Date(startYear, startMonth - 1, 1).getTime();
  const end = new Date(endYear, endMonth, 0).getTime();
  const ts = start + rng() * (end - start);
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Weight toward recent dates (2025)
function recentWeightedDate(): string {
  // 70% chance of 2025, 30% chance of 2024
  if (rng() < 0.7) {
    return randDate(2025, 1, 2025, 12);
  }
  return randDate(2024, 1, 2024, 12);
}

// ── Data Pools ───────────────────────────────────────────────────────
// Core entities: the ORIGINAL names that test queries target.
// Weighted picks ensure ~60% of generated content references these.

const CORE_WRITERS = ["Peter", "Dave"];
const CORE_SUPPORT = ["Sarah", "Marcus", "Lisa", "James"];
const ALL_CORE_PEOPLE = [...CORE_WRITERS, ...CORE_SUPPORT];
const CORE_CLIENTS = ["Anderson", "Brightwell", "Meridian Health", "Canopy Digital"];
const CORE_TOOLS = ["Airtable", "WordPress", "Surfer SEO", "Originality.ai", "Google Search Console", "Slack"];

// New entities to add diversity (but secondary to the core set)
const NEW_WRITERS = [
  "Alex", "Ben", "Cara", "Diana", "Elena", "Frank", "Grace", "Hasan",
  "Isla", "Jake", "Karen", "Leo", "Maya", "Nate", "Olivia", "Quinn",
  "Rosa", "Sam", "Tina", "Uma", "Vince", "Wendy", "Xavier", "Yuki",
];

const NEW_CLIENTS = [
  "Apex Digital", "BlueStar", "Cascade Tech", "Drift Marketing", "EcoVault",
  "Falcon Media", "Greenline", "Horizon AI", "IronBridge", "JetStream",
  "Keystone Labs", "Luma Health", "Mosaic Group", "NovaCrest", "Olympus Corp",
  "Pinnacle SaaS", "Quantum Edge", "Ridgeline", "Strata Systems", "TerraWave",
  "Uplift Health", "Vertex AI", "Wavelength", "Xpanse", "Zenith Digital",
  "Atlas Cloud", "BrightPath", "Cortex Data", "Dynamo HR", "Elevate",
  "Forge Analytics", "GlowUp", "HiveWorks", "InnoSphere", "Jumpstart",
];

const NEW_TOOLS = [
  "Clearscope", "MarketMuse", "Frase", "Jasper AI", "ContentShake",
  "Ahrefs", "SEMrush", "Moz Pro", "SpyFu", "Mangools",
  "Trello", "Monday.com", "ClickUp", "Basecamp", "Notion",
  "HubSpot", "Mailchimp", "ConvertKit", "ActiveCampaign", "Brevo",
];

const ALL_WRITERS = [...ALL_CORE_PEOPLE, ...NEW_WRITERS]; // for entity generation only
const ALL_CLIENTS = [...CORE_CLIENTS, ...NEW_CLIENTS];
const ALL_TOOLS = [...CORE_TOOLS, ...NEW_TOOLS];

const INDUSTRIES = [
  "fintech", "edtech", "healthtech", "insurtech", "proptech",
  "cybersecurity", "e-commerce", "martech", "legaltech", "agritech",
  "biotech", "cleantech", "logistics", "automotive", "fashion",
  "food & beverage", "gaming", "hospitality", "manufacturing", "energy",
  "telecom", "aerospace", "construction", "mining", "retail",
];

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
const MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

const ARTICLE_TOPICS = [
  "cloud migration strategies", "API security best practices", "data pipeline optimization",
  "remote team management", "B2B lead generation", "conversion rate optimization",
  "email marketing automation", "social media strategy", "content distribution",
  "keyword research methodology", "technical SEO audit", "link building tactics",
  "PPC campaign management", "customer retention strategies", "product launch marketing",
  "brand storytelling", "influencer marketing", "podcast marketing",
  "video content strategy", "community building", "user onboarding flows",
  "A/B testing frameworks", "data-driven marketing", "account-based marketing",
  "thought leadership content", "case study writing", "whitepaper development",
  "webinar promotion", "event marketing", "partner marketing",
];

// ── Weighted pick functions ──────────────────────────────────────────
// These ensure most generated content targets the entities that test queries search for.

/** 50% Peter/Dave, 20% Sarah/Marcus/Lisa/James, 30% new writers */
function pickWriter(): string {
  const r = rng();
  if (r < 0.50) return pick(CORE_WRITERS);
  if (r < 0.70) return pick(CORE_SUPPORT);
  return pick(NEW_WRITERS);
}

/** 60% original 4 clients, 40% new clients */
function pickClient(): string {
  return rng() < 0.60 ? pick(CORE_CLIENTS) : pick(NEW_CLIENTS);
}

/** 55% original tools, 45% new tools */
function pickTool(): string {
  return rng() < 0.55 ? pick(CORE_TOOLS) : pick(NEW_TOOLS);
}

/** Pick any core person (for Sarah-flagged, Marcus-called, Lisa-managed, James-built events) */
function pickCorePerson(): string {
  return pick(ALL_CORE_PEOPLE);
}

// ── Types ────────────────────────────────────────────────────────────

interface GeneratedItem {
  category: "entity" | "fact" | "event" | "instruction" | "opinion" | "process";
  subtype: string;
  content: string;
  salience: number;
  date?: string;
  // For graph DB only
  entitySubtype?: "person" | "project" | "tool" | "org";
  edges?: Array<{ targetName: string; edgeType: string }>;
}

// ── Template Functions ───────────────────────────────────────────────

// 1. Writer entity templates — new writers only (originals already seeded)
function generateWriterEntity(name: string, idx: number): GeneratedItem {
  const specialties = pickN(INDUSTRIES, 2);
  const rate = randInt(2, 10);
  const tenure = randInt(1, 36);
  const qual = pick(["consistently high quality", "needs occasional revision", "very reliable output",
    "improving steadily", "strong technical accuracy", "good storytelling ability",
    "excellent research skills", "tends to miss deadlines", "fast turnaround",
    "meticulous attention to detail", "great at long-form content", "strong with data-driven pieces"]);
  const templates = [
    () => `${name} — content writer at WOBS. Produces about ${rate} articles per week. Specializes in ${specialties[0]} and ${specialties[1]} content. Has been with the team for ${tenure} months.`,
    () => `${name} — freelance writer for WOBS. Focuses on ${specialties[0]} topics, also covers ${specialties[1]}. Output is roughly ${rate} articles weekly. Joined ${tenure} months ago.`,
    () => `${name} — writer at WOBS working across ${specialties[0]} and ${specialties[1]} niches. Averages ${rate} pieces per week. Tenure: ${tenure} months.`,
    () => `${name} — WOBS team writer. ${qual}. Handles ${specialties[0]} and ${specialties[1]} verticals. Writes around ${rate} articles a week.`,
    () => `${name} — content creator at WOBS. Primarily covers ${specialties[0]}. Also writes for ${specialties[1]} clients. Rate: ~${rate}/week. Started ${tenure} months ago.`,
    () => `${name} — senior writer contracted by WOBS. Has deep expertise in ${specialties[0]} and strong knowledge of ${specialties[1]}. Delivers ${rate} articles per week on average.`,
    () => `${name} — writing team member at WOBS. ${qual}. Core niches: ${specialties[0]}, ${specialties[1]}. Weekly output: ${rate} articles.`,
    () => `${name} — WOBS content writer specializing in ${specialties[0]}. Also contributes to ${specialties[1]} accounts. Produces approximately ${rate} articles each week.`,
  ];
  return {
    category: "entity",
    subtype: "person",
    content: templates[idx % templates.length](),
    salience: 0.8 + rng() * 0.4,
    entitySubtype: "person",
    edges: [{ targetName: "WOBS-bulk", edgeType: "works_for" }],
  };
}

// 2. Client entity templates — new clients only
function generateClientEntity(name: string, idx: number): GeneratedItem {
  const industry = pick(INDUSTRIES);
  const articles = randInt(5, 30);
  const retainer = articles * randInt(150, 350);
  const writerName = pickWriter();
  const templates = [
    () => `${name} — a client project at WOBS. ${pick(["Mid-size", "Large", "Growing", "Established", "Startup"])} ${industry} company. Order involves ${articles} articles per month. Primary writer: ${writerName}. Monthly retainer: £${retainer.toLocaleString()}.`,
    () => `${name} — WOBS client in the ${industry} space. Requires ${articles} articles monthly on ${industry} topics. ${writerName} is assigned as the lead writer. Retainer: £${retainer.toLocaleString()}/month.`,
    () => `${name} — client account at WOBS. Industry: ${industry}. Monthly deliverable: ${articles} articles. Writer assignment: ${writerName}. Monthly fee: £${retainer.toLocaleString()}.`,
    () => `${name} — ${industry} client for WOBS. They need ${articles} pieces of content per month covering ${industry} trends and best practices. ${writerName} handles most of the writing. Retainer is £${retainer.toLocaleString()}.`,
    () => `${name} — a ${industry} company that contracts WOBS for content marketing. ${articles} articles per month. Assigned writer: ${writerName}. Monthly retainer: £${retainer.toLocaleString()}.`,
    () => `${name} — WOBS client project. Niche: ${industry}. Content volume: ${articles} articles/month. Lead writer: ${writerName}. Contract value: £${retainer.toLocaleString()} monthly.`,
    () => `${name} — ${pick(["new", "longstanding", "mid-tenure", "recently onboarded"])} client at WOBS. Operates in ${industry}. Orders ${articles} articles per month. ${writerName} writes most of their content.`,
    () => `${name} — client project managed by WOBS. Focuses on ${industry} content. Produces ${articles} articles monthly at £${retainer.toLocaleString()} retainer. ${writerName} is the primary contributor.`,
  ];
  return {
    category: "entity",
    subtype: "project",
    content: templates[idx % templates.length](),
    salience: 0.8 + rng() * 0.4,
    entitySubtype: "project",
    edges: [{ targetName: "WOBS-bulk", edgeType: "client_of" }],
  };
}

// 3. Tool entity templates — new tools only
function generateToolEntity(name: string, idx: number): GeneratedItem {
  const toolTypes = [
    "SEO optimization", "content planning", "project management", "email marketing",
    "analytics", "AI writing", "keyword research", "social scheduling",
    "grammar checking", "plagiarism detection", "content scoring", "link prospecting",
  ];
  const toolType = pick(toolTypes);
  const templates = [
    () => `${name} — ${toolType} tool used by the WOBS team. Integrated into the content workflow for ${pick(["quality assurance", "performance tracking", "productivity", "collaboration"])}.`,
    () => `${name} — a ${toolType} platform that WOBS uses. Helps with ${pick(["content optimization", "team coordination", "client reporting", "campaign management"])}.`,
    () => `${name} — WOBS uses this ${toolType} tool for ${pick(["daily operations", "monthly reporting", "content checks", "workflow automation"])}. ${pickCorePerson()} manages the account.`,
    () => `${name} — ${toolType} tool in the WOBS tech stack. Used by the team for ${pick(["checking content quality", "managing deadlines", "tracking performance", "automating workflows"])}.`,
    () => `${name} — a ${toolType} solution adopted by WOBS. Primarily used for ${pick(["content scoring", "project tracking", "SEO analysis", "outreach management"])}.`,
    () => `${name} — ${toolType} platform. Part of the WOBS toolset. Team uses it for ${pick(["content review", "keyword tracking", "editorial management", "client deliverables"])}.`,
    () => `${name} — ${toolType} tool that WOBS integrates into their workflow. Key use case: ${pick(["article optimization", "deadline tracking", "quality control", "performance monitoring"])}.`,
    () => `${name} — WOBS ${toolType} tool. Helps the team with ${pick(["SEO improvements", "content scheduling", "team collaboration", "client communication"])}.`,
  ];
  return {
    category: "entity",
    subtype: "tool",
    content: templates[idx % templates.length](),
    salience: 0.8 + rng() * 0.4,
    entitySubtype: "tool",
    edges: [{ targetName: "WOBS-bulk", edgeType: "used_by" }],
  };
}

// 4. Fact templates — heavily reference core entities
function generateFact(idx: number): GeneratedItem {
  const writer = pickWriter();
  const client = pickClient();
  const articles = randInt(3, 25);
  const score = randInt(55, 95);
  const price = randInt(100, 500);
  const posts = randInt(5, 40);
  const templates = [
    () => `${writer} writes content for ${client}, delivering about ${articles} articles per month`,
    () => `${client} pays £${price} per article for standard content from WOBS`,
    () => `${writer}'s articles average a Surfer SEO score of ${score}/100`,
    () => `${client} has been a WOBS client for ${randInt(1, 24)} months`,
    () => `${writer} produces approximately ${randInt(2, 10)} articles per week for WOBS clients`,
    () => `WOBS charges ${client} a monthly retainer of £${(articles * price).toLocaleString()}`,
    () => `${client} requires ${articles} articles per month on ${pick(INDUSTRIES)} topics`,
    () => `${writer} specializes in ${pick(INDUSTRIES)} content and also covers ${pick(INDUSTRIES)}`,
    () => `James placed ${posts} guest posts for ${client} last month`,
    () => `${writer}'s Originality.ai scores consistently come back above ${randInt(70, 95)}% original`,
    () => `Sarah reviewed ${randInt(5, 20)} of ${writer}'s articles for ${client} this month — ${pick(["all passed", "most passed", `${randInt(1, 4)} needed revision`, "overall quality was good"])}`,
    () => `${writer} has a ${pick(["98%", "95%", "92%", "88%", "100%"])} on-time delivery rate for ${client}`,
    () => `${client} is ${pick(["expanding their order", "considering reducing", "maintaining", "doubling"])} to ${articles} articles per month`,
    () => `Link building for ${client} costs about £${randInt(30, 80)} per placement. James handles the outreach.`,
    () => `Lisa updated the Airtable tracker for ${client} — ${writer} has ${randInt(2, 8)} articles in Draft status`,
    () => `Marcus negotiated a rate of £${price} per article with ${client} for the upcoming quarter`,
  ];
  const subtypes = ["definitional", "comparative", "conditional", "definitional", "definitional", "definitional",
    "definitional", "definitional", "definitional", "comparative", "comparative", "comparative",
    "conditional", "definitional", "definitional", "definitional"];
  return {
    category: "fact",
    subtype: subtypes[idx % subtypes.length],
    content: templates[idx % templates.length](),
    salience: 0.6 + rng() * 0.5,
  };
}

// 5. Event templates — the core of the "year of activity"
function generateEvent(idx: number): GeneratedItem {
  const writer = pickWriter();
  const client = pickClient();
  const day = pick(DAYS);
  const articles = randInt(1, 12);
  const month = pick(MONTHS);
  const score = randInt(60, 98);

  // 24 templates — dense mix of submissions, reviews, incidents, meetings involving core people
  const templates = [
    // Article submissions (Peter/Dave heavy)
    () => `${writer} submitted ${articles} articles for the ${client} order on ${day}`,
    () => `${writer} completed the ${client} ${month} batch — all ${articles} articles submitted on time`,
    () => `${writer} delivered ${articles} ${client} articles ahead of the ${day} deadline`,
    // Sarah reviews
    () => `Sarah reviewed ${randInt(1, 6)} of ${writer}'s ${client} articles on ${day} — ${pick(["all passed Surfer", `${randInt(1, 3)} failed the 75 threshold`, "quality was solid", "one needed factual correction", "flagged minor formatting issues"])}`,
    () => `Sarah flagged ${randInt(1, 3)} of ${writer}'s ${client} articles for ${pick(["quality issues", "SEO problems", "factual errors", "tone mismatch", "missing citations"])} on ${day}`,
    () => `Sarah approved ${randInt(3, 10)} ${client} articles for publishing on ${day} after Surfer and Originality checks`,
    // Missed deadlines / incidents (Dave-heavy but not exclusive)
    () => `${writer} missed the ${client} deadline on ${day} — ${randInt(1, 5)} articles were late by ${randInt(1, 4)} days`,
    () => `${client} complained about ${pick(["a factual error", "missed deadline", "article tone", "SEO meta tags", "broken links", "outdated statistics"])} on ${day}. ${writer} wrote the article.`,
    () => `${writer}'s ${client} article scored ${score < 75 ? score : randInt(55, 74)} on Surfer on ${day} — sent back for optimization`,
    // Marcus calls / strategy
    () => `Marcus had a call with ${client}'s team on ${day} — discussed ${pick(["content strategy", "contract renewal", "pricing", "performance metrics", "expansion plans", "adding video content"])}`,
    () => `Marcus reviewed the ${month} GSC report for ${client} — organic traffic ${pick(["up", "down", "flat"])} ${randInt(5, 45)}% month-over-month`,
    () => `Marcus presented the ${pick(["Q1", "Q2", "Q3", "Q4"])} performance review to ${client} — ${pick(["they were pleased", "some concerns raised", "discussed increasing volume", "talked about pricing adjustment"])}`,
    // Lisa operations
    () => `Lisa created ${randInt(5, 20)} new article assignments for ${client} in Airtable for ${month}`,
    () => `Lisa resolved a billing discrepancy with ${client} on ${day} — was overcharged by £${randInt(100, 500)}`,
    () => `Lisa set up the ${client} WordPress access and configured ${randInt(2, 5)} author accounts on ${day}`,
    // James link building
    () => `James placed ${randInt(5, 20)} guest posts for ${client} in ${month}`,
    () => `James finished the ${client} link building campaign for ${month} — ${randInt(8, 25)} placements secured`,
    // Tool / score events
    () => `${writer} achieved ${randInt(80, 100)}% Originality score on all ${client} articles this month`,
    () => `${writer}'s article on ${pick(ARTICLE_TOPICS)} for ${client} scored ${score} on Surfer SEO`,
    // Performance / positive events
    () => `${writer}'s ${client} article on ${pick(ARTICLE_TOPICS)} got ${randInt(500, 5000)} views in the first week`,
    () => `${client}'s organic traffic reached ${randInt(10, 100)}K monthly visits after ${randInt(3, 12)} months with WOBS`,
    // Meetings and communications
    () => `${pick(["Quarterly business review", "Content strategy session", "Monthly retainer review", "SEO performance walkthrough", "Editorial calendar planning"])} with ${client} on ${day}`,
    () => `Team standup on ${day}: ${writer} working on ${client} batch, Sarah reviewing ${pickClient()} articles, Lisa updating Airtable`,
    () => `${client} feedback from ${month}: "${pick(["Great work this month", "Quality has been inconsistent", "We'd like more research-heavy pieces", "Can we increase the word count", "The SEO results are impressive", "Happy with the turnaround time"])}"`,
  ];
  const subtypes = [
    "action", "action", "action",
    "action", "incident", "action",
    "incident", "incident", "incident",
    "conversation", "outcome", "conversation",
    "action", "action", "action",
    "action", "outcome",
    "outcome", "outcome",
    "outcome", "outcome",
    "action", "action", "conversation",
  ];
  return {
    category: "event",
    subtype: subtypes[idx % subtypes.length],
    content: templates[idx % templates.length](),
    salience: 0.3 + rng() * 0.5,
    date: recentWeightedDate(),
  };
}

// 6. Instruction templates — reference core tools & clients heavily
function generateInstruction(idx: number): GeneratedItem {
  const client = pickClient();
  const writer = pickWriter();
  const tool = pickTool();
  const score = randInt(70, 90);
  const templates = [
    () => `All ${client} articles must pass a ${tool} check before submission. Minimum score: ${score}/100.`,
    () => `${client} requires all content to be written in ${pick(["British English", "American English", "Australian English"])} — no exceptions.`,
    () => `When writing for ${client}, always include at least ${randInt(3, 8)} internal links to their existing content.`,
    () => `${client} articles must be between ${randInt(800, 1500)} and ${randInt(1500, 3000)} words. Shorter articles will be rejected.`,
    () => `Never mention ${pick(["competitors", "pricing", "lawsuits", "controversies", "negative reviews"])} in ${client} content without prior approval from Marcus.`,
    () => `${client} content must include a meta description under 160 characters and an SEO-optimized title tag. Sarah checks this.`,
    () => `For ${client} articles, ${writer} should focus on ${pick(ARTICLE_TOPICS)} as the primary topic cluster.`,
    () => `All ${client} deliverables must be submitted through Airtable — no email submissions accepted. Lisa monitors the tracker.`,
    () => `${client} has a strict ${pick(["48-hour", "72-hour", "1-week", "5-day"])} review turnaround. Sarah must prioritize their content.`,
    () => `When creating content for ${client}, use their brand voice guide. Tone should be ${pick(["professional", "casual", "authoritative", "friendly", "technical"])}.`,
    () => `${client} requires all images to be ${pick(["royalty-free", "original", "branded", "from their asset library"])}. No stock photos without approval.`,
    () => `For ${client} projects, always run the article through ${tool} before submitting to Sarah for review.`,
    () => `${writer} must check Originality.ai before submitting ${client} articles. Minimum ${randInt(75, 90)}% original.`,
    () => `When ${writer} submits ${client} articles, update the Airtable status to 'Review' and notify Sarah in Slack.`,
    () => `${client} articles need a Surfer SEO score of at least ${score} before Sarah will approve them for publishing.`,
    () => `If ${writer} misses a ${client} deadline, Lisa must notify the client within ${pick(["2 hours", "4 hours", "24 hours"])} and offer expedited delivery.`,
  ];
  return {
    category: "instruction",
    subtype: "instruction",
    content: templates[idx % templates.length](),
    salience: 1.0 + rng() * 1.0,
  };
}

// 7. Opinion templates — centered on core people & clients
function generateOpinion(idx: number): GeneratedItem {
  const writer = pickWriter();
  const client = pickClient();
  const tool = pickTool();
  const templates = [
    () => `I think ${writer} is ${pick(["underperforming", "doing great", "improving", "struggling", "one of our best"])} — their recent ${client} work was ${pick(["impressive", "concerning", "decent", "below expectations", "outstanding"])}`,
    () => `${client} might ${pick(["churn soon", "increase their budget", "become our biggest client", "be more trouble than they're worth", "need more attention from Lisa"])}`,
    () => `We should ${pick(["invest more in", "reconsider", "phase out", "double down on", "evaluate"])} ${tool} — ${pick(["it's not delivering ROI", "it's been really useful", "the team loves it", "it's too expensive", "there are better alternatives"])}`,
    () => `${writer} would be a great fit for the ${client} account — they have strong ${pick(INDUSTRIES)} experience`,
    () => `I'm worried about ${writer}'s workload — they've been handling ${client} and ${pickClient()} simultaneously`,
    () => `${client}'s expectations are ${pick(["reasonable", "unrealistic", "getting harder to meet", "well-aligned with our output", "increasing"])} — Marcus needs to ${pick(["set boundaries", "step up", "renegotiate", "add more writers", "revisit the contract"])}`,
    () => `The quality of ${writer}'s ${client} content has been ${pick(["declining", "improving", "consistent", "variable", "excellent"])} — Sarah has flagged it ${pick(["multiple times", "a few times", "once or twice", "repeatedly"])}`,
    () => `We need to ${pick(["hire", "train", "replace", "promote", "support"])} ${writer} — they're ${pick(["key to our operations", "falling behind", "ready for more responsibility", "burning out", "our top performer on the ${client} account"])}`,
    () => `I think ${client} needs ${pick(["more attention from Lisa", "a dedicated writer", "higher quality content", "better SEO focus", "more frequent updates from Marcus"])}`,
    () => `${writer}'s Surfer scores on ${client} content have been ${pick(["great", "inconsistent", "below threshold", "steadily improving", "declining"])} — ${pick(["might need Surfer training", "Sarah should double-check", "no action needed", "concerning trend"])}`,
  ];
  return {
    category: "opinion",
    subtype: "user_opinion",
    content: templates[idx % templates.length](),
    salience: 0.4 + rng() * 0.4,
  };
}

// 8. Process templates — mirror the real WOBS processes with variations
function generateProcess(idx: number): GeneratedItem {
  const client = pickClient();
  const tool = pickTool();
  const writer = pickWriter();
  const templates = [
    () => `To set up a new writer in ${tool}: 1) Create their account 2) Add them to the WOBS workspace 3) Assign permissions 4) Send onboarding docs 5) Schedule a walkthrough call with Lisa`,
    () => `${client} content review process: 1) ${writer} submits draft in Airtable 2) Sarah checks quality and Surfer SEO score 3) If score < 75, return to ${writer} 4) Run Originality.ai check 5) If all clear, publish to WordPress`,
    () => `Monthly reporting for ${client}: 1) Pull GSC data on the 1st 2) Compile traffic and ranking metrics 3) Add content production stats from Airtable 4) Marcus reviews 5) Send to client by the 5th`,
    () => `Link building process for ${client}: 1) James identifies prospects 2) Send outreach emails 3) Negotiate placements 4) Write guest post content 5) Submit for publication 6) Log in Airtable`,
    () => `Client escalation procedure for ${client}: 1) Lisa receives complaint 2) Investigate within 2 hours 3) Coordinate fix with ${writer} 4) If severe, escalate to Marcus 5) Provide resolution within 24 hours 6) Follow up in 48 hours`,
    () => `New ${pick(INDUSTRIES)} article workflow for ${client}: 1) Lisa assigns in Airtable 2) ${writer} researches keywords in ${tool} 3) Draft article (${randInt(1000, 2500)} words) 4) Sarah reviews 5) Optimize for Surfer SEO 6) Publish to WordPress`,
    () => `To update ${client}'s WordPress: 1) Log into WP admin 2) Go to Posts → Add New 3) Paste content 4) Set categories and tags 5) Add featured image 6) Configure Yoast SEO meta 7) Preview and publish`,
    () => `Quarterly strategy review for ${client}: 1) Pull 3-month performance data from GSC 2) Analyze top-performing content 3) Identify gaps and opportunities 4) Draft recommendations 5) Marcus presents to ${client} 6) Schedule follow-up call`,
    () => `Onboarding ${client}: 1) Marcus signs contract and billing 2) Lisa creates Airtable workspace 3) Lisa gets WordPress credentials 4) Lisa creates first month's assignments 5) ${writer} starts within 3 days`,
    () => `${writer}'s weekly workflow for ${client}: 1) Check Airtable for assignments 2) Research topic 3) Draft article 4) Run through ${tool} 5) Submit for Sarah's review in Airtable 6) Address any revision notes`,
  ];
  return {
    category: "process",
    subtype: "tool_usage",
    content: templates[idx % templates.length](),
    salience: 0.8 + rng() * 0.7,
  };
}

// ── Master Generator ─────────────────────────────────────────────────

function generateAll(): GeneratedItem[] {
  const items: GeneratedItem[] = [];

  // Entities: only NEW names (originals already seeded separately)
  // ~24 writers + 35 clients + 20 tools = ~79 new entities
  for (let i = 0; i < NEW_WRITERS.length; i++) {
    items.push(generateWriterEntity(NEW_WRITERS[i], i));
  }
  for (let i = 0; i < NEW_CLIENTS.length; i++) {
    items.push(generateClientEntity(NEW_CLIENTS[i], i));
  }
  for (let i = 0; i < NEW_TOOLS.length; i++) {
    items.push(generateToolEntity(NEW_TOOLS[i], i));
  }

  // Facts: ~4000 (weighted toward core entities)
  for (let i = 0; i < 4000; i++) {
    items.push(generateFact(i));
  }

  // Events: ~8000 (the bulk — simulates a year of activity)
  for (let i = 0; i < 8000; i++) {
    items.push(generateEvent(i));
  }

  // Instructions: ~3000 (rules for core clients/tools/people)
  for (let i = 0; i < 3000; i++) {
    items.push(generateInstruction(i));
  }

  // Opinions: ~1500 (about core people & clients)
  for (let i = 0; i < 1500; i++) {
    items.push(generateOpinion(i));
  }

  // Processes: ~1000 (mirror the real WOBS workflows)
  for (let i = 0; i < 1000; i++) {
    items.push(generateProcess(i));
  }

  // Misc meeting notes, conversations, observations: ~2350
  for (let i = 0; i < 2350; i++) {
    const writer = pickWriter();
    const client = pickClient();
    const miscTemplates = [
      `Meeting note: Discussed ${client}'s content strategy for Q${randInt(1, 4)} with ${writer} and the team`,
      `Observation: ${writer} has been more productive since switching to ${pickTool()} for research`,
      `Note: ${client} mentioned they're ${pick(["happy with", "concerned about", "neutral on", "excited about"])} the recent content quality`,
      `Conversation with ${writer}: They want to ${pick(["focus more on", "reduce work on", "specialize in", "learn more about"])} ${pick(INDUSTRIES)} content for ${client}`,
      `Team discussion: Should we ${pick(["expand", "restructure", "automate", "outsource", "improve"])} our ${pick(["content process", "review workflow", "client onboarding", "Airtable setup", "Surfer SEO checks"])}?`,
      `${client} feedback from ${pick(MONTHS)}: "${pick(["Great work this month", "Quality has been inconsistent", "We'd like more research-heavy pieces", "Can we increase the word count", "The SEO results are impressive", "Happy with Sarah's editing"])}"`,
      `Reminder: ${writer} is ${pick(["on leave next week", "attending a conference", "moving to part-time", "taking on more ${client} articles", "available for extra assignments"])}`,
      `Note from Marcus: ${client} wants to ${pick(["explore video content", "add social media to the package", "start a newsletter", "commission a whitepaper", "run a content audit", "increase link building with James"])}`,
      `Lisa updated ${client}'s Airtable workspace — ${randInt(5, 15)} articles marked as Published for ${pick(MONTHS)}`,
      `Sarah's weekly review: ${writer} had ${randInt(0, 3)} articles below the Surfer 75 threshold for ${client} this week`,
    ];
    items.push({
      category: "event",
      subtype: pick(["conversation", "observation", "action"]),
      content: pick(miscTemplates),
      salience: 0.2 + rng() * 0.3,
      date: recentWeightedDate(),
    });
  }

  return items;
}

// ── Import original seed data ────────────────────────────────────────

// The original 62 items from seed.ts (imported inline to avoid dependency issues)
// We import the seedDb function from benchmark.ts's inline seed logic

async function seedOriginalGraphDb(db: Database) {
  // Re-use the seed logic from benchmark.ts but operate on our custom db
  // We need createNode/createEdge that work on our db
  function createNode(node: { node_type: string; subtype?: string; content: string; salience: number; confidence: number; source: string; attributes: Record<string, any> }): string {
    const id = crypto.randomUUID();
    const canSummarize = (node.subtype === "instruction" || node.subtype === "tool_usage") ? 0 : 1;
    db.prepare(
      `INSERT INTO nodes (id, node_type, subtype, content, salience, confidence, source, attributes, can_summarize) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, node.node_type, node.subtype ?? null, node.content, node.salience, node.confidence, node.source, JSON.stringify(node.attributes), canSummarize);
    return id;
  }

  function createEdge(edge: { source_id: string; target_id: string; edge_type: string }) {
    const id = crypto.randomUUID();
    db.prepare(
      `INSERT INTO edges (id, source_id, target_id, edge_type, attributes) VALUES (?, ?, ?, ?, '{}')`
    ).run(id, edge.source_id, edge.target_id, edge.edge_type);
  }

  function storeEmbedding(nodeId: string, nodeType: string, vector: number[]) {
    const blob = new Float32Array(vector).buffer;
    db.prepare(
      `INSERT OR REPLACE INTO embeddings (node_id, node_type, vector) VALUES (?, ?, ?)`
    ).run(nodeId, nodeType, Buffer.from(blob));
  }

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
    { c: "Always check AI detection using Originality.ai before submitting content to clients. Score must be above 80% original.", sal: 2.5, links: [{ t: originalityId, e: "about" }, { t: wobsId, e: "about" }] },
    { c: "Every article must score at least 75/100 on Surfer SEO before publishing. If it's below 75, send it back to the writer for optimization.", sal: 2.5, links: [{ t: surferId, e: "about" }] },
    { c: "Never publish an article without Sarah's approval. She must sign off on every piece before it goes live.", sal: 2.5, links: [{ t: sarahId, e: "about" }] },
    { c: "Meridian Health articles require an additional step: after Sarah's review, send the article to Meridian's in-house medical reviewer for accuracy sign-off before publishing.", sal: 2.0, links: [{ t: meridianId, e: "about" }] },
    { c: "All client communication should go through Lisa unless it's a strategic/pricing discussion, which Marcus handles.", sal: 2.0, links: [{ t: lisaId, e: "about" }, { t: marcusId, e: "about" }] },
    { c: "When a writer misses a deadline, immediately notify the client through Lisa and offer expedited delivery within 24 hours.", sal: 2.0, links: [{ t: lisaId, e: "about" }] },
    { c: "Monthly GSC reports must be sent to clients by the 5th of each month. Marcus reviews them before they go out.", sal: 2.0, links: [{ t: gscId, e: "about" }, { t: marcusId, e: "about" }] },
    { c: "For white-label clients like Canopy Digital, never include any WOBS branding, watermarks, or attribution in the content.", sal: 2.0, links: [{ t: canopyId, e: "about" }] },
  ];

  const instrIds: string[] = [];
  for (const i of instrData) {
    const id = createNode({ node_type: "fact", subtype: "instruction", content: i.c, salience: i.sal, confidence: 1.0, source: "user", attributes: {} });
    instrIds.push(id);
    for (const link of i.links) createEdge({ source_id: id, target_id: link.t, edge_type: link.e });
  }

  // ── Processes ──
  const procData = [
    { c: "To look up an order in Airtable: Open the WOBS Orders base → go to the 'Active Orders' view → filter by client name. Each row shows: client, article title, assigned writer, deadline, status (Draft/Review/Published). You can also filter by writer name to see their assignments.", sal: 1.8, links: [{ t: airtableId, e: "about" }] },
    { c: "To create a new article assignment in Airtable: In the 'Active Orders' view → click '+ Add record' → fill in: Client (dropdown), Article Title, Target Keyword, Assigned Writer (dropdown), Deadline, Word Count Target. Status will default to 'Draft'.", sal: 1.5, links: [{ t: airtableId, e: "about" }] },
    { c: "To update an order status in Airtable: Find the article row → change the Status dropdown from 'Draft' to 'Review' when submitted, 'Review' to 'Published' when live. Add the live URL to the 'Published URL' field.", sal: 1.5, links: [{ t: airtableId, e: "about" }] },
    { c: "To publish an article on WordPress: Log into the client's WP admin → Posts → Add New → paste the content → set the category and tags → add the featured image → set the SEO meta title and description in Yoast → click 'Publish'. Make sure the permalink slug matches the target keyword.", sal: 1.5, links: [{ t: wordpressId, e: "about" }] },
    { c: "To run a Surfer SEO check: Open Surfer → Content Editor → paste the target keyword → paste the article text → check the Content Score. Must be 75+ to pass. If below 75, Surfer will suggest missing terms and topics to add. Send suggestions back to the writer.", sal: 1.8, links: [{ t: surferId, e: "about" }] },
    { c: "To check AI detection with Originality.ai: Go to Originality.ai → Scan → paste the full article text → click 'Scan'. Check the 'Original' percentage. Must be above 80%. If below 80%, the article needs to be rewritten by the writer — do NOT attempt to manually edit it to pass.", sal: 1.8, links: [{ t: originalityId, e: "about" }] },
    { c: "To pull a GSC report: Open Google Search Console → select the client's property → Performance → set date range to last 30 days → export as CSV. Key metrics: total clicks, impressions, average CTR, average position. Compare to previous month.", sal: 1.5, links: [{ t: gscId, e: "about" }] },
    { c: "Content creation workflow at WOBS: 1) Lisa creates the assignment in Airtable with keyword and deadline. 2) Writer drafts the article. 3) Writer submits to Sarah for review (status → Review). 4) Sarah checks quality, Surfer score, and Originality score. 5) If passes, Sarah approves and publishes to WordPress. 6) Lisa updates Airtable status to Published.", sal: 1.8, links: [{ t: wobsId, e: "about" }, { t: airtableId, e: "about" }, { t: wordpressId, e: "about" }] },
    { c: "When dealing with a client complaint: 1) Lisa acknowledges within 2 hours. 2) Lisa investigates — checks the article, who wrote it, what went wrong. 3) Lisa coordinates fix with the writer. 4) If it's a factual error, escalate to Marcus. 5) Fixed article goes through Sarah's review again before re-publishing.", sal: 1.8, links: [{ t: lisaId, e: "about" }, { t: marcusId, e: "about" }] },
    { c: "To onboard a new client: 1) Marcus signs the contract and sets up billing. 2) Lisa creates the Airtable workspace for the client. 3) Lisa gets WordPress admin credentials from the client. 4) Lisa creates the first month's article assignments in Airtable. 5) Writers start on articles within 3 days of onboarding.", sal: 1.8, links: [{ t: marcusId, e: "about" }, { t: lisaId, e: "about" }, { t: airtableId, e: "about" }] },
  ];

  const procIds: string[] = [];
  for (const p of procData) {
    const id = createNode({ node_type: "fact", subtype: "tool_usage", content: p.c, salience: p.sal, confidence: 1.0, source: "user", attributes: {} });
    procIds.push(id);
    for (const link of p.links) createEdge({ source_id: id, target_id: link.t, edge_type: link.e });
  }

  // ── Opinions ──
  const opinData = [
    { c: "I think Dave needs more training before handling Meridian Health articles — the medical inaccuracy issues are concerning", sal: 0.7, links: [{ t: daveId, e: "about" }, { t: meridianId, e: "about" }] },
    { c: "Peter is the best writer we have. If we lose him, we're in trouble.", sal: 0.7, links: [{ t: peterId, e: "about" }] },
    { c: "Canopy Digital might be more trouble than they're worth — the white-label requirement adds complexity and they're paying standard rates", sal: 0.7, links: [{ t: canopyId, e: "about" }] },
    { c: "We should probably raise prices for healthcare content. The medical review step makes it much more expensive to produce.", sal: 0.7, links: [{ t: meridianId, e: "about" }, { t: wobsId, e: "about" }] },
  ];

  for (const o of opinData) {
    const id = createNode({ node_type: "opinion", subtype: "user_opinion", content: o.c, salience: o.sal, confidence: 1.0, source: "user", attributes: {} });
    for (const link of o.links) createEdge({ source_id: id, target_id: link.t, edge_type: link.e });
  }

  // Structural edges
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

  // ── Embeddings for original nodes ──
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
  for (let i = 0; i < instrData.length; i++) allNodes.push({ id: instrIds[i], type: "fact", text: instrData[i].c });
  for (let i = 0; i < procData.length; i++) allNodes.push({ id: procIds[i], type: "fact", text: procData[i].c });

  // Embed original nodes
  const texts = allNodes.map((n) => n.text);
  for (let start = 0; start < texts.length; start += EMBED_BATCH_SIZE) {
    const batch = texts.slice(start, start + EMBED_BATCH_SIZE);
    const vectors = await embed(batch);
    for (let j = 0; j < vectors.length; j++) {
      storeEmbedding(allNodes[start + j].id, allNodes[start + j].type, vectors[j]);
    }
  }

  return { allNodes, wobsId };
}

// ── DB Initialization ────────────────────────────────────────────────

function initGraphDb(path: string): Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY,
      node_type TEXT NOT NULL,
      subtype TEXT,
      content TEXT NOT NULL,
      salience REAL DEFAULT 1.0,
      confidence REAL DEFAULT 1.0,
      source TEXT DEFAULT 'user',
      created_at TEXT DEFAULT (datetime('now')),
      valid_from TEXT,
      valid_until TEXT,
      superseded_by TEXT,
      attributes TEXT DEFAULT '{}',
      can_summarize INTEGER DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS edges (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES nodes(id),
      target_id TEXT NOT NULL REFERENCES nodes(id),
      edge_type TEXT NOT NULL,
      attributes TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(node_type);
    CREATE INDEX IF NOT EXISTS idx_nodes_subtype ON nodes(subtype);
    CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
    CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
    CREATE INDEX IF NOT EXISTS idx_edges_type ON edges(edge_type);
    CREATE TABLE IF NOT EXISTS embeddings (
      node_id TEXT PRIMARY KEY REFERENCES nodes(id),
      node_type TEXT NOT NULL,
      vector BLOB NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  return db;
}

function initEmbedDb(path: string): Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL, vector BLOB NOT NULL, created_at TEXT DEFAULT (datetime('now')))");
  return db;
}

// ── Main ─────────────────────────────────────────────────────────────

console.log(`\n╔══════════════════════════════════════════════════════════╗`);
console.log(`║         Bulk Data Generator (20K Scale Test)            ║`);
console.log(`╚══════════════════════════════════════════════════════════╝`);
console.log(`PRNG seed: ${SEED}`);
console.log(`Graph DB:  ${GRAPH_DB_PATH}`);
if (GRAPH_ONLY) {
  console.log(`Mode:      graph-only`);
} else {
  console.log(`Embed DB:  ${EMBED_DB_PATH}`);
}

// 1. Generate all bulk items
console.log(`\n── Generating bulk items...`);
const bulkItems = generateAll();

// Distribution summary
const dist: Record<string, number> = {};
for (const item of bulkItems) {
  const key = `${item.category}/${item.subtype}`;
  dist[key] = (dist[key] || 0) + 1;
}
console.log(`   Total items: ${bulkItems.length}`);
console.log(`   Distribution:`);
for (const [key, count] of Object.entries(dist).sort((a, b) => b[1] - a[1])) {
  console.log(`     ${key}: ${count}`);
}

// 2. Reset and create DBs
console.log(`\n── Creating fresh databases...`);
try { rmSync(GRAPH_DB_PATH); } catch {}
try { rmSync(GRAPH_DB_PATH + "-wal"); } catch {}
try { rmSync(GRAPH_DB_PATH + "-shm"); } catch {}
if (!GRAPH_ONLY) {
  try { rmSync(EMBED_DB_PATH); } catch {}
  try { rmSync(EMBED_DB_PATH + "-wal"); } catch {}
  try { rmSync(EMBED_DB_PATH + "-shm"); } catch {}
}

const graphDb = initGraphDb(GRAPH_DB_PATH);
const embedDb = GRAPH_ONLY ? null : initEmbedDb(EMBED_DB_PATH);

// 3. Seed original data into graph DB
console.log(`\n── Seeding original 62 items into graph DB...`);
const { allNodes: originalNodes, wobsId: originalWobsId } = await seedOriginalGraphDb(graphDb);
console.log(`   Seeded ${originalNodes.length} original graph nodes`);

// 4. Seed original data into embed DB
const ORIGINAL_SEED_DATA = [
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
  "Peter submitted 8 articles for the Anderson order on Tuesday",
  "Dave missed the Brightwell deadline last Friday — 3 articles were late by 2 days",
  "Sarah flagged 2 of Dave's Meridian Health articles for medical inaccuracy on Monday",
  "Marcus had a call with Anderson's CEO on Wednesday — they're happy with content quality and want to explore video content too",
  "Canopy Digital onboarded last week. Lisa set up their Airtable workspace and WordPress access.",
  "James placed 12 guest posts for Anderson last month, which is above the target of 10",
  "One of Peter's Anderson articles went viral on LinkedIn last week — got 2,000+ shares",
  "Brightwell complained about a factual error in a published article on Wednesday. Dave wrote the article.",
  "Always check AI detection using Originality.ai before submitting content to clients. Score must be above 80% original.",
  "Every article must score at least 75/100 on Surfer SEO before publishing. If it's below 75, send it back to the writer for optimization.",
  "Never publish an article without Sarah's approval. She must sign off on every piece before it goes live.",
  "Meridian Health articles require an additional step: after Sarah's review, send the article to Meridian's in-house medical reviewer for accuracy sign-off before publishing.",
  "All client communication should go through Lisa unless it's a strategic/pricing discussion, which Marcus handles.",
  "When a writer misses a deadline, immediately notify the client through Lisa and offer expedited delivery within 24 hours.",
  "Monthly GSC reports must be sent to clients by the 5th of each month. Marcus reviews them before they go out.",
  "For white-label clients like Canopy Digital, never include any WOBS branding, watermarks, or attribution in the content.",
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
  "I think Dave needs more training before handling Meridian Health articles — the medical inaccuracy issues are concerning",
  "Peter is the best writer we have. If we lose him, we're in trouble.",
  "Canopy Digital might be more trouble than they're worth — the white-label requirement adds complexity and they're paying standard rates",
  "We should probably raise prices for healthcare content. The medical review step makes it much more expensive to produce.",
];

let embedInsert: ReturnType<Database["prepare"]> | null = null;
if (embedDb) {
  console.log(`── Seeding original 62 items into embed DB...`);
  embedInsert = embedDb.prepare("INSERT INTO items (content, vector) VALUES (?, ?)");
  for (let i = 0; i < ORIGINAL_SEED_DATA.length; i += EMBED_BATCH_SIZE) {
    const batch = ORIGINAL_SEED_DATA.slice(i, i + EMBED_BATCH_SIZE);
    const vectors = await embed(batch);
    for (let j = 0; j < vectors.length; j++) {
      const blob = Buffer.from(new Float32Array(vectors[j]).buffer);
      embedInsert.run(batch[j], blob);
    }
  }
  console.log(`   Seeded ${ORIGINAL_SEED_DATA.length} original embed items`);
}

// 5. Seed bulk items into both DBs
console.log(`\n── Seeding ${bulkItems.length} bulk items...`);

// Prepare graph DB statements
const graphInsertNode = graphDb.prepare(
  `INSERT INTO nodes (id, node_type, subtype, content, salience, confidence, source, attributes, can_summarize) VALUES (?, ?, ?, ?, ?, ?, 'user', '{}', ?)`
);
const graphInsertEdge = graphDb.prepare(
  `INSERT INTO edges (id, source_id, target_id, edge_type, attributes) VALUES (?, ?, ?, ?, '{}')`
);
const graphInsertEmbed = graphDb.prepare(
  `INSERT OR REPLACE INTO embeddings (node_id, node_type, vector) VALUES (?, ?, ?)`
);

// Create a WOBS-bulk entity node for edges to reference
const wobsBulkId = crypto.randomUUID();
graphInsertNode.run(wobsBulkId, "entity", "org", "WOBS (Wolf of Blog Street) — bulk alias for edge references", 0.1, 1.0, 1);

// Map entity names to IDs for edge creation
const entityNameToId: Map<string, string> = new Map();
entityNameToId.set("WOBS-bulk", wobsBulkId);

// Insert all bulk items into graph DB (nodes + edges)
const bulkNodeIds: string[] = [];
let entityCount = 0;
let edgeCount = 0;

// Use a transaction for performance
graphDb.exec("BEGIN TRANSACTION");

for (const item of bulkItems) {
  const nodeId = crypto.randomUUID();
  bulkNodeIds.push(nodeId);

  const nodeType = item.category === "opinion" ? "opinion" : item.category === "event" ? "event" : "fact";
  const actualNodeType = item.category === "entity" ? "entity" : nodeType;

  const canSummarize = (item.subtype === "instruction" || item.subtype === "tool_usage") ? 0 : 1;
  graphInsertNode.run(nodeId, actualNodeType, item.subtype, item.content, item.salience, 1.0, canSummarize);

  // Track entity IDs for edge creation
  if (item.category === "entity") {
    const nameMatch = item.content.match(/^([^—–\-]+)/);
    if (nameMatch) {
      entityNameToId.set(nameMatch[1].trim(), nodeId);
    }
    entityCount++;
  }
}

// Now create edges for entities
for (let i = 0; i < bulkItems.length; i++) {
  const item = bulkItems[i];
  if (item.edges) {
    for (const edge of item.edges) {
      const targetId = entityNameToId.get(edge.targetName);
      if (targetId) {
        graphInsertEdge.run(crypto.randomUUID(), bulkNodeIds[i], targetId, edge.edgeType);
        edgeCount++;
      }
    }
  }
}

// Also create writer → client edges (random assignments)
const writerIds = [...entityNameToId.entries()].filter(([name]) => NEW_WRITERS.includes(name));
const clientIds = [...entityNameToId.entries()].filter(([name]) => NEW_CLIENTS.includes(name));

for (const [, writerId] of writerIds) {
  // Each writer writes for 1-3 clients
  const numClients = randInt(1, 3);
  const assignedClients = pickN(clientIds, numClients);
  for (const [, clientId] of assignedClients) {
    graphInsertEdge.run(crypto.randomUUID(), writerId, clientId, "writes_for");
    edgeCount++;
  }
}

graphDb.exec("COMMIT");
console.log(`   Graph: ${bulkItems.length} nodes, ${edgeCount} edges (${entityCount} entities)`);

// 6. Embed all bulk items and store in both DBs
console.log(`\n── Embedding ${bulkItems.length} bulk items (batches of ${EMBED_BATCH_SIZE})...`);

const allBulkTexts = bulkItems.map((item) => item.content);
let embeddedCount = 0;

graphDb.exec("BEGIN TRANSACTION");

for (let i = 0; i < allBulkTexts.length; i += EMBED_BATCH_SIZE) {
  const batchTexts = allBulkTexts.slice(i, i + EMBED_BATCH_SIZE);
  const vectors = await embed(batchTexts);

  for (let j = 0; j < vectors.length; j++) {
    const idx = i + j;
    const blob = Buffer.from(new Float32Array(vectors[j]).buffer);

    // Graph DB embedding
    const nodeType = bulkItems[idx].category === "entity" ? "entity" :
      bulkItems[idx].category === "opinion" ? "opinion" :
      bulkItems[idx].category === "event" ? "event" : "fact";
    graphInsertEmbed.run(bulkNodeIds[idx], nodeType, blob);

    // Embed DB item
    if (embedInsert) {
      embedInsert.run(bulkItems[idx].content, blob);
    }
  }

  embeddedCount += batchTexts.length;
  const pct = Math.round((embeddedCount / allBulkTexts.length) * 100);
  process.stdout.write(`\r   Embedded: ${embeddedCount}/${allBulkTexts.length} (${pct}%)`);
}

graphDb.exec("COMMIT");
console.log(); // newline after progress

// 7. Final stats
const graphNodeCount = (graphDb.prepare("SELECT COUNT(*) as c FROM nodes").get() as any).c;
const graphEdgeCount = (graphDb.prepare("SELECT COUNT(*) as c FROM edges").get() as any).c;
const graphEmbedCount = (graphDb.prepare("SELECT COUNT(*) as c FROM embeddings").get() as any).c;
const embedItemCount = embedDb
  ? (embedDb.prepare("SELECT COUNT(*) as c FROM items").get() as any).c
  : null;

console.log(`\n══════════════════════════════════════════════════════════`);
console.log(`  GENERATION COMPLETE`);
console.log(`══════════════════════════════════════════════════════════`);
console.log(`  Graph DB:  ${GRAPH_DB_PATH}`);
console.log(`    Nodes:      ${graphNodeCount.toLocaleString()}`);
console.log(`    Edges:      ${graphEdgeCount.toLocaleString()}`);
console.log(`    Embeddings: ${graphEmbedCount.toLocaleString()}`);
if (embedItemCount !== null) {
  console.log(`  ──────────────────────────────────────`);
  console.log(`  Embed DB:  ${EMBED_DB_PATH}`);
  console.log(`    Items:      ${embedItemCount.toLocaleString()}`);
}
console.log(`══════════════════════════════════════════════════════════\n`);

graphDb.close();
if (embedDb) {
  embedDb.close();
}
