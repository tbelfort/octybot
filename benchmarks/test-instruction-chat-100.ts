/**
 * Instruction extraction — 100 message CHAT MODE stress test.
 *
 * Runs the same 100 messages from test-instruction-100.ts but sequentially
 * as a conversation, building up conversation state so turns 2-100 go
 * through the follow-up pipeline instead of the full pipeline.
 *
 * Tests that instruction extraction still works correctly when going
 * through the follow-up pipeline's storage path:
 *   followUpPipeline → extractInstructions → filterForStorage → storeLoop
 *
 * ALWAYS uses the noisy-large DB (20K items).
 *
 * Usage:
 *   bun test-instruction-chat-100.ts
 *   bun test-instruction-chat-100.ts --only 5,23,45
 */
import { join } from "path";
import { existsSync, copyFileSync, unlinkSync } from "fs";
import Database from "bun:sqlite";

// ── DB setup: copy noisy-large to a temp working copy ───────────────
const HOME = process.env.HOME || "~";
const NOISY_DB = join(HOME, ".octybot", "test", "memory-noisy-large.db");
const WORK_DB = join(HOME, ".octybot", "test", "memory-chat100-test.db");

if (!existsSync(NOISY_DB)) {
  console.error(`ERROR: Noisy-large DB not found at ${NOISY_DB}`);
  process.exit(1);
}

copyFileSync(NOISY_DB, WORK_DB);
try { copyFileSync(NOISY_DB + "-wal", WORK_DB + "-wal"); } catch {}
try { copyFileSync(NOISY_DB + "-shm", WORK_DB + "-shm"); } catch {}

// Force DB_PATH BEFORE any memory imports
process.env.DB_PATH = WORK_DB;

// Dynamic imports — must happen AFTER env var is set
const { classify } = await import("../memory/layer1");
const { agenticLoop, readConversationState, writeConversationState } = await import("../memory/layer2");
const { followUpPipeline } = await import("../memory/follow-up");
const { extractInstructions } = await import("../memory/store");
const { getDb } = await import("../memory/db-core");
const { CONVERSATION_STATE_PATH, DB_PATH } = await import("../memory/config");

const db = getDb();
const { resetUsage, getUsage, calculateCosts } = await import("../memory/usage-tracker");
type ConversationTurn = import("../memory/types").ConversationTurn;

// ── Messages (same as test-instruction-100.ts) ──────────────────────

interface TestMsg {
  msg: string;
  shouldBeInstruction: boolean;
  category: string;
}

const MESSAGES: TestMsg[] = [
  // TRUE INSTRUCTIONS (80)
  // -- Role assignments phrased as facts (10) --
  { msg: "Tom is the one who signs off on all purchase orders", shouldBeInstruction: true, category: "role-as-fact" },
  { msg: "Maria handles client escalations for the east coast region", shouldBeInstruction: true, category: "role-as-fact" },
  { msg: "The new intern Sam is the person to ask about the CRM data", shouldBeInstruction: true, category: "role-as-fact" },
  { msg: "Rachel is our point of contact for anything related to compliance", shouldBeInstruction: true, category: "role-as-fact" },
  { msg: "Jake runs the weekly standup every Monday at 9", shouldBeInstruction: true, category: "role-as-fact" },
  { msg: "Nina covers for Mark whenever he's out on Fridays", shouldBeInstruction: true, category: "role-as-fact" },
  { msg: "The security team reviews all third-party integrations before we enable them", shouldBeInstruction: true, category: "role-as-fact" },
  { msg: "Our accountant Priya handles VAT filings for all EU clients", shouldBeInstruction: true, category: "role-as-fact" },
  { msg: "Dev ops is responsible for rotating the API keys every quarter", shouldBeInstruction: true, category: "role-as-fact" },
  { msg: "Only the CEO can approve expenses over £10,000", shouldBeInstruction: true, category: "role-as-fact" },

  // -- Tool usage described as facts (10) --
  { msg: "The shared Google Drive is where all project proposals live", shouldBeInstruction: true, category: "tool-as-fact" },
  { msg: "We log all customer support interactions in Zendesk", shouldBeInstruction: true, category: "tool-as-fact" },
  { msg: "The deploy scripts are in the ops repo under /scripts/deploy", shouldBeInstruction: true, category: "tool-as-fact" },
  { msg: "Figma is what the design team uses for all mockups and prototypes", shouldBeInstruction: true, category: "tool-as-fact" },
  { msg: "The staging environment credentials are pinned in the #devops Slack channel", shouldBeInstruction: true, category: "tool-as-fact" },
  { msg: "All meeting notes go into the Notion workspace under the team folder", shouldBeInstruction: true, category: "tool-as-fact" },
  { msg: "GitHub Actions runs the full test suite on every PR", shouldBeInstruction: false, category: "fact" },
  { msg: "Datadog is what we use to monitor API latency and error rates", shouldBeInstruction: true, category: "tool-as-fact" },
  { msg: "The product roadmap lives in Linear, not Jira anymore", shouldBeInstruction: true, category: "tool-as-fact" },
  { msg: "AWS costs are tracked in the FinOps dashboard under the billing account", shouldBeInstruction: true, category: "tool-as-fact" },

  // -- Preferences disguised as opinions (10) --
  { msg: "I'd rather we not do releases after 4pm, too risky", shouldBeInstruction: true, category: "preference-as-opinion" },
  { msg: "Honestly I think all PRs should have at least two approvers going forward", shouldBeInstruction: true, category: "preference-as-opinion" },
  { msg: "It would be nice if we kept retrospective notes under 1 page", shouldBeInstruction: true, category: "preference-as-opinion" },
  { msg: "I feel strongly that customer data should never leave the EU region", shouldBeInstruction: true, category: "preference-as-opinion" },
  { msg: "Can we please make sure error messages are user-friendly, not stack traces", shouldBeInstruction: true, category: "preference-as-opinion" },
  { msg: "I really don't want us shipping features without feature flags", shouldBeInstruction: true, category: "preference-as-opinion" },
  { msg: "My preference is that design reviews happen before dev starts, not after", shouldBeInstruction: true, category: "preference-as-opinion" },
  { msg: "I believe we should keep API responses under 200ms for the core endpoints", shouldBeInstruction: true, category: "preference-as-opinion" },
  { msg: "In my view, every outage should trigger a post-mortem within 48 hours", shouldBeInstruction: true, category: "preference-as-opinion" },
  { msg: "Let's agree that hotfixes go through abbreviated review but still need tests", shouldBeInstruction: true, category: "preference-as-opinion" },

  // -- Corrections that update rules (10) --
  { msg: "Actually the password policy changed — minimum 16 characters now, not 12", shouldBeInstruction: true, category: "correction-as-rule" },
  { msg: "Wait, they moved the standup to Tuesday, not Monday anymore", shouldBeInstruction: true, category: "correction-as-rule" },
  { msg: "I misspoke — the SLA is 4 hours response time, not 2", shouldBeInstruction: true, category: "correction-as-rule" },
  { msg: "No actually, only senior devs should have prod database access, not everyone", shouldBeInstruction: true, category: "correction-as-rule" },
  { msg: "Correction: the free tier allows 1000 API calls per day, not per hour", shouldBeInstruction: true, category: "correction-as-rule" },
  { msg: "Scratch what I said before — vendors need to sign the NDA before we share any specs", shouldBeInstruction: true, category: "correction-as-rule" },
  { msg: "The retention period is 90 days now, they extended it from 30", shouldBeInstruction: true, category: "correction-as-rule" },
  { msg: "My bad, the cutoff for Q1 reports is March 15 not March 31", shouldBeInstruction: true, category: "correction-as-rule" },
  { msg: "Oh right, I forgot — we need two-factor auth for the admin panel, not just a password", shouldBeInstruction: true, category: "correction-as-rule" },
  { msg: "That's outdated — we stopped using Jenkins, everything goes through GitHub Actions now", shouldBeInstruction: true, category: "correction-as-rule" },

  // -- Exception rules phrased as facts (10) --
  { msg: "Enterprise clients get 99.99% SLA, everyone else gets 99.9%", shouldBeInstruction: true, category: "exception-as-fact" },
  { msg: "The Tokyo office runs on JST so their standups are at 10am their time", shouldBeInstruction: true, category: "exception-as-fact" },
  { msg: "HIPAA clients need their data on dedicated infrastructure, not the shared cluster", shouldBeInstruction: true, category: "exception-as-fact" },
  { msg: "Government contracts require all communication to go through the legal team", shouldBeInstruction: true, category: "exception-as-fact" },
  { msg: "Startups on the free plan don't get phone support, only email", shouldBeInstruction: true, category: "exception-as-fact" },
  { msg: "For the German market, all user-facing text needs to go through the localization team", shouldBeInstruction: true, category: "exception-as-fact" },
  { msg: "Internal tools don't need the same accessibility audit as customer-facing ones", shouldBeInstruction: true, category: "exception-as-fact" },
  { msg: "Quarterly clients get invoiced at the start of the quarter, monthly clients at the end of the month", shouldBeInstruction: true, category: "exception-as-fact" },
  { msg: "Open source contributions need extra IP review that internal code doesn't", shouldBeInstruction: true, category: "exception-as-fact" },
  { msg: "The finance team uses a different approval workflow than engineering — they need VP sign-off for anything over £500", shouldBeInstruction: true, category: "exception-as-fact" },

  // -- Multi-step processes described casually (10) --
  { msg: "For refunds, first check the order in Stripe, then verify with the CS rep, then process through the admin panel", shouldBeInstruction: true, category: "casual-process" },
  { msg: "Whenever someone leaves the company, disable their accounts, revoke keys, and notify IT within 24 hours", shouldBeInstruction: true, category: "casual-process" },
  { msg: "New hires need laptop setup, badge access, Slack invite, and a buddy assigned in the first week", shouldBeInstruction: true, category: "casual-process" },
  { msg: "To push to production: branch from main, get 2 reviews, pass CI, then merge — no direct pushes", shouldBeInstruction: true, category: "casual-process" },
  { msg: "Client onboarding is: sign contract, create workspace, import data, schedule training call", shouldBeInstruction: true, category: "casual-process" },
  { msg: "Incident response: acknowledge in PagerDuty, open a Slack thread, fix it, then write the post-mortem", shouldBeInstruction: true, category: "casual-process" },
  { msg: "Patent filing process: invention disclosure → legal review → prior art search → file with attorney", shouldBeInstruction: true, category: "casual-process" },
  { msg: "When a payment fails, we retry 3 times over 7 days, send a warning email, then suspend the account", shouldBeInstruction: true, category: "casual-process" },
  { msg: "Feature launches go: internal dogfood → beta group → 10% rollout → full GA", shouldBeInstruction: true, category: "casual-process" },
  { msg: "Quarterly planning: each team submits proposals, leadership prioritizes, then we size and schedule", shouldBeInstruction: true, category: "casual-process" },

  // -- Bans and constraints stated softly (10) --
  { msg: "We moved away from using personal email accounts for any work communication", shouldBeInstruction: true, category: "soft-ban" },
  { msg: "The consensus is that we shouldn't store credit card numbers ourselves", shouldBeInstruction: true, category: "soft-ban" },
  { msg: "We've decided not to support IE11 anymore, it's just not worth it", shouldBeInstruction: true, category: "soft-ban" },
  { msg: "Auto-scaling is turned off for the dev environment to keep costs down", shouldBeInstruction: true, category: "soft-ban" },
  { msg: "We try not to schedule meetings during the team's focus block from 1-4pm", shouldBeInstruction: true, category: "soft-ban" },
  { msg: "External contractors shouldn't have write access to the main repo", shouldBeInstruction: true, category: "soft-ban" },
  { msg: "Nobody should be committing API keys to version control, use the secrets manager instead", shouldBeInstruction: true, category: "soft-ban" },
  { msg: "We avoid using third-party cookies since the privacy policy update", shouldBeInstruction: true, category: "soft-ban" },
  { msg: "The decision was made to stop doing manual QA for microservices, we rely on automated tests", shouldBeInstruction: true, category: "soft-ban" },
  { msg: "We agreed not to use the production database for any kind of testing or experiments", shouldBeInstruction: true, category: "soft-ban" },

  // -- Thresholds embedded in conversational statements (10) --
  { msg: "Pages that take more than 3 seconds to load are flagged in our performance dashboard", shouldBeInstruction: true, category: "embedded-threshold" },
  { msg: "Anything with a severity of P1 or P2 wakes the on-call engineer", shouldBeInstruction: true, category: "embedded-threshold" },
  { msg: "We keep code coverage at 80% minimum, anything below blocks the merge", shouldBeInstruction: true, category: "embedded-threshold" },
  { msg: "Support tickets must be responded to within 4 business hours for paid customers", shouldBeInstruction: true, category: "embedded-threshold" },
  { msg: "The content security policy blocks any inline scripts or styles", shouldBeInstruction: true, category: "embedded-threshold" },
  { msg: "API rate limiting is set to 100 requests per minute per user", shouldBeInstruction: true, category: "embedded-threshold" },
  { msg: "Pull requests with more than 500 lines changed need to be broken into smaller chunks", shouldBeInstruction: true, category: "embedded-threshold" },
  { msg: "The CDN cache TTL for static assets is 24 hours", shouldBeInstruction: true, category: "embedded-threshold" },
  { msg: "Database queries that take longer than 500ms trigger an alert in Datadog", shouldBeInstruction: true, category: "embedded-threshold" },
  { msg: "Any spend above the team's quarterly budget needs the director's approval", shouldBeInstruction: true, category: "embedded-threshold" },

  // NOT INSTRUCTIONS (20)
  // -- Pure facts (7) --
  { msg: "Our ARR crossed $5 million last quarter", shouldBeInstruction: false, category: "fact" },
  { msg: "The engineering team has 23 people across 4 time zones", shouldBeInstruction: false, category: "fact" },
  { msg: "We signed the contract with Acme Corp in January", shouldBeInstruction: false, category: "fact" },
  { msg: "The company was founded in 2019 in London", shouldBeInstruction: false, category: "fact" },
  { msg: "React is our primary frontend framework", shouldBeInstruction: false, category: "fact" },
  { msg: "The enterprise plan costs $499 per month", shouldBeInstruction: false, category: "fact" },
  { msg: "There are three microservices in the payment processing pipeline", shouldBeInstruction: false, category: "fact" },

  // -- Events (6) --
  { msg: "The server went down for about 20 minutes yesterday afternoon", shouldBeInstruction: false, category: "event" },
  { msg: "Tom submitted the Q3 budget proposal on Friday", shouldBeInstruction: false, category: "event" },
  { msg: "We lost two customers last month due to pricing complaints", shouldBeInstruction: false, category: "event" },
  { msg: "The migration to the new database finished over the weekend", shouldBeInstruction: false, category: "event" },
  { msg: "Maria presented the roadmap at the all-hands yesterday", shouldBeInstruction: false, category: "event" },
  { msg: "We shipped version 3.2 last Tuesday with the new dashboard", shouldBeInstruction: false, category: "event" },

  // -- Opinions without prescriptive force (4) --
  { msg: "I think the new onboarding flow is much better than the old one", shouldBeInstruction: false, category: "opinion" },
  { msg: "Tom's been doing a great job with the infrastructure work", shouldBeInstruction: false, category: "opinion" },
  { msg: "The Kubernetes migration was worth the effort in hindsight", shouldBeInstruction: false, category: "opinion" },
  { msg: "I feel like the sprint velocity has improved this quarter", shouldBeInstruction: false, category: "opinion" },

  // -- Questions (3) --
  { msg: "Who handles the on-call rotation for the API team?", shouldBeInstruction: false, category: "question" },
  { msg: "Do we have a process for handling GDPR data deletion requests?", shouldBeInstruction: false, category: "question" },
  { msg: "What's our policy on remote work for contractors?", shouldBeInstruction: false, category: "question" },
];

// ── Helpers ─────────────────────────────────────────────────────────

function getAllNodeIds(): Set<string> {
  const db = new Database(WORK_DB, { readonly: true });
  const rows = db.query("SELECT id FROM nodes").all() as { id: string }[];
  db.close();
  return new Set(rows.map(r => r.id));
}

function getNewNodes(knownIds: Set<string>): Array<{
  id: string; node_type: string; subtype: string; content: string; scope: number | null;
}> {
  const db = new Database(WORK_DB, { readonly: true });
  const allRows = db.query("SELECT id, node_type, subtype, content, scope FROM nodes ORDER BY created_at DESC").all() as any[];
  db.close();
  return allRows.filter(r => !knownIds.has(r.id));
}

function getNodeCount(): number {
  const db = new Database(WORK_DB, { readonly: true });
  const row = db.query("SELECT COUNT(*) as c FROM nodes").get() as { c: number };
  db.close();
  return row.c;
}

// ── Per-message runner ──────────────────────────────────────────────

interface TurnResult {
  path: "full" | "followup" | "followup-fallback";
  newNodes: Array<{ id: string; node_type: string; subtype: string; content: string; scope: number | null }>;
  gotInstruction: boolean;
  totalMs: number;
}

async function runMessage(
  msg: string,
  knownIds: Set<string>
): Promise<TurnResult> {
  const startMs = Date.now();
  resetUsage();

  const state = readConversationState();
  const hasRecentState = !!state;

  let path: TurnResult["path"] = "full";
  let entityNames: string[] = [];

  if (hasRecentState) {
    const result = await followUpPipeline(db, msg, state!.turns);

    if (result) {
      path = "followup";
      entityNames = result.turns
        .filter(t => t.tool_call.name === "search_entity")
        .flatMap(t => {
          const name = t.tool_call.arguments.name as string;
          return name ? [name] : [];
        });

      const newTurn: ConversationTurn = { prompt: msg, entities: entityNames, timestamp: Date.now() };
      writeConversationState([...state!.turns, newTurn]);
    } else {
      path = "followup-fallback";
    }
  }

  if (path === "full" || path === "followup-fallback") {
    const l1c = await classify(msg);
    const l1 = l1c.result;

    const hasStorableContent =
      l1.implied_facts.length > 0 ||
      l1.events.length > 0 ||
      l1.opinions.length > 0 ||
      l1.intents.includes("instruction");

    if (l1.operations.retrieve || hasStorableContent) {
      await agenticLoop(db, msg, l1);
    }

    entityNames = l1.entities.map(e => e.name);
    const prevTurns = state?.turns ?? [];
    writeConversationState([...prevTurns, { prompt: msg, entities: entityNames, timestamp: Date.now() }]);
  }

  const totalMs = Date.now() - startMs;
  const newNodes = getNewNodes(knownIds);
  const gotInstruction = newNodes.some(n => n.node_type === "instruction");

  return { path, newNodes, gotInstruction, totalMs };
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const onlyArg = args.find(a => a.startsWith("--only"));
  const onlySet = onlyArg
    ? new Set(
        (onlyArg.includes("=") ? onlyArg.split("=")[1] : args[args.indexOf(onlyArg) + 1])
          ?.split(",").map(n => parseInt(n.trim())) ?? []
      )
    : null;

  console.log(`\n${"═".repeat(80)}`);
  console.log(`  INSTRUCTION CHAT MODE — 100 MESSAGE STRESS TEST`);
  console.log(`  Source DB: ${NOISY_DB}`);
  console.log(`  Working copy: ${WORK_DB}`);
  console.log(`  Active DB_PATH: ${DB_PATH}`);
  console.log(`${"═".repeat(80)}`);

  if (DB_PATH !== WORK_DB) {
    console.error(`\nERROR: DB_PATH mismatch. Expected ${WORK_DB}, got ${DB_PATH}`);
    process.exit(1);
  }

  // Clean slate
  try { unlinkSync(CONVERSATION_STATE_PATH); } catch {}

  const initialCount = getNodeCount();
  const knownIds = getAllNodeIds();
  const trueInstrCount = MESSAGES.filter(m => m.shouldBeInstruction).length;
  const nonInstrCount = MESSAGES.filter(m => !m.shouldBeInstruction).length;

  console.log(`\nMessages: ${MESSAGES.length} (${trueInstrCount} instructions, ${nonInstrCount} non-instructions)`);
  console.log(`Starting nodes: ${initialCount}`);
  console.log(`Conversation state: cleared\n`);

  const startTime = Date.now();

  interface Result {
    idx: number;
    msg: string;
    category: string;
    shouldBeInstruction: boolean;
    gotInstruction: boolean;
    correct: boolean;
    path: string;
    newNodeCount: number;
    instrContent?: string;
    ms: number;
  }

  const results: Result[] = [];
  let fullCount = 0;
  let followupCount = 0;
  let fallbackCount = 0;

  for (let i = 0; i < MESSAGES.length; i++) {
    const msgNum = i + 1;
    const { msg, shouldBeInstruction, category } = MESSAGES[i];

    // For --only: still write conversation state for skipped turns to maintain flow
    if (onlySet && !onlySet.has(msgNum)) {
      const state = readConversationState();
      const prevTurns = state?.turns ?? [];
      writeConversationState([...prevTurns, { prompt: msg, entities: [], timestamp: Date.now() }]);
      continue;
    }

    const pathLabel = i === 0 ? "FULL" : "CHAT";
    process.stderr.write(`  [${msgNum}/100] [${pathLabel}] ${msg.slice(0, 55)}...`);

    const result = await runMessage(msg, knownIds);

    // Track new nodes
    for (const n of result.newNodes) {
      knownIds.add(n.id);
    }

    // Track path distribution
    if (result.path === "full") fullCount++;
    else if (result.path === "followup") followupCount++;
    else fallbackCount++;

    const correct = result.gotInstruction === shouldBeInstruction;
    const marker = correct ? "OK" : (shouldBeInstruction ? "MISS" : "FP");

    // Get first instruction content if any
    const instrNode = result.newNodes.find(n => n.node_type === "instruction");

    process.stderr.write(` [${marker}] [${result.path}] ${(result.totalMs / 1000).toFixed(1)}s\n`);

    results.push({
      idx: msgNum,
      msg, category, shouldBeInstruction,
      gotInstruction: result.gotInstruction,
      correct,
      path: result.path,
      newNodeCount: result.newNodes.length,
      instrContent: instrNode?.content?.slice(0, 80),
      ms: result.totalMs,
    });
  }

  const duration = Date.now() - startTime;

  // ── Results ──
  const trueInstructions = results.filter(r => r.shouldBeInstruction);
  const nonInstructions = results.filter(r => !r.shouldBeInstruction);

  const truePositives = trueInstructions.filter(r => r.gotInstruction).length;
  const falseNegatives = trueInstructions.filter(r => !r.gotInstruction).length;
  const trueNegatives = nonInstructions.filter(r => !r.gotInstruction).length;
  const falsePositives = nonInstructions.filter(r => r.gotInstruction).length;

  const recall = truePositives / trueInstructions.length;
  const precision = truePositives / (truePositives + falsePositives) || 0;
  const f1 = 2 * (precision * recall) / (precision + recall) || 0;

  console.log(`\n${"═".repeat(80)}`);
  console.log(`  RESULTS`);
  console.log(`${"═".repeat(80)}`);
  console.log();
  console.log(`  Recall:    ${truePositives}/${trueInstructions.length} = ${(recall * 100).toFixed(1)}% (instructions correctly identified)`);
  console.log(`  Precision: ${truePositives}/${truePositives + falsePositives} = ${(precision * 100).toFixed(1)}% (of stored, how many were real instructions)`);
  console.log(`  F1 Score:  ${(f1 * 100).toFixed(1)}%`);
  console.log(`  False neg: ${falseNegatives} | False pos: ${falsePositives}`);
  console.log();
  console.log(`  Pipeline paths: ${fullCount} full, ${followupCount} follow-up, ${fallbackCount} fallback`);
  console.log(`  Total time: ${(duration / 1000).toFixed(1)}s | Avg: ${(duration / results.length / 1000).toFixed(1)}s/msg`);
  console.log();

  // Breakdown by category
  const categories = new Map<string, { total: number; correct: number }>();
  for (const r of results) {
    const entry = categories.get(r.category) ?? { total: 0, correct: 0 };
    entry.total++;
    if (r.correct) entry.correct++;
    categories.set(r.category, entry);
  }
  console.log(`  ── By Category ──`);
  for (const [cat, { total, correct }] of [...categories.entries()].sort((a, b) => a[1].correct / a[1].total - b[1].correct / b[1].total)) {
    const pct = (correct / total * 100).toFixed(0);
    const marker = correct === total ? "" : " <<<";
    console.log(`    ${cat.padEnd(24)} ${correct}/${total} (${pct}%)${marker}`);
  }
  console.log();

  // List failures
  const failures = results.filter(r => !r.correct);
  if (failures.length > 0) {
    console.log(`  ── Failures (${failures.length}) ──`);
    for (const f of failures) {
      const label = f.shouldBeInstruction ? "MISS" : "FALSE POS";
      console.log(`    [${label}] [${f.category}] [${f.path}] #${f.idx}: "${f.msg.slice(0, 70)}${f.msg.length > 70 ? "..." : ""}"`);
      if (f.instrContent) {
        console.log(`      → stored: "${f.instrContent}"`);
      }
    }
    console.log();
  }

  // Comparison note
  console.log(`  ── Chat Mode vs Direct ──`);
  console.log(`  This test runs messages as a conversation (follow-up pipeline).`);
  console.log(`  Compare with: bun test-instruction-100.ts (direct extractInstructions only)`);
  console.log();

  // Node stats
  const finalCount = getNodeCount();
  console.log(`  Nodes: ${initialCount} → ${finalCount} (+${finalCount - initialCount})`);

  // Costs
  const usage = getUsage();
  const costs = calculateCosts("openai/gpt-oss-120b", "openai/gpt-oss-120b", "voyage-4", usage);
  console.log(`  Cost: $${costs.total_cost.toFixed(4)}`);

  // Clean up
  try { unlinkSync(WORK_DB); } catch {}
  try { unlinkSync(WORK_DB + "-wal"); } catch {}
  try { unlinkSync(WORK_DB + "-shm"); } catch {}

  console.log(`\n${"═".repeat(80)}\n`);
  process.exit(failures.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`Test error: ${err.message}\n${err.stack}`);
  process.exit(1);
});
