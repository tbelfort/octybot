/**
 * Full pipeline test — instruction extractor + informed store filter on 100 messages.
 * Shows a table of all results with per-message cost and timing.
 *
 * Usage:
 *   bun test-pipeline-100.ts
 */
import { extractInstructions, filterForStorage } from "../src/memory/store";
import { resetUsage, getUsage } from "../src/memory/usage-tracker";
import type { Layer1Result } from "../src/memory/types";

interface TestMsg {
  msg: string;
  shouldBeInstruction: boolean;
  category: string;
  expectedType: string; // what the combined pipeline should produce
}

const MESSAGES: TestMsg[] = [
  // ═══ TRUE INSTRUCTIONS (80) ═══
  // -- Role assignments phrased as facts (10) --
  { msg: "Tom is the one who signs off on all purchase orders", shouldBeInstruction: true, category: "role-as-fact", expectedType: "instruction/rule" },
  { msg: "Maria handles client escalations for the east coast region", shouldBeInstruction: true, category: "role-as-fact", expectedType: "instruction/rule" },
  { msg: "The new intern Sam is the person to ask about the CRM data", shouldBeInstruction: true, category: "role-as-fact", expectedType: "instruction/rule" },
  { msg: "Rachel is our point of contact for anything related to compliance", shouldBeInstruction: true, category: "role-as-fact", expectedType: "instruction/rule" },
  { msg: "Jake runs the weekly standup every Monday at 9", shouldBeInstruction: true, category: "role-as-fact", expectedType: "instruction/rule" },
  { msg: "Nina covers for Mark whenever he's out on Fridays", shouldBeInstruction: true, category: "role-as-fact", expectedType: "instruction/rule" },
  { msg: "The security team reviews all third-party integrations before we enable them", shouldBeInstruction: true, category: "role-as-fact", expectedType: "instruction/rule" },
  { msg: "Our accountant Priya handles VAT filings for all EU clients", shouldBeInstruction: true, category: "role-as-fact", expectedType: "instruction/rule" },
  { msg: "Dev ops is responsible for rotating the API keys every quarter", shouldBeInstruction: true, category: "role-as-fact", expectedType: "instruction/rule" },
  { msg: "Only the CEO can approve expenses over £10,000", shouldBeInstruction: true, category: "role-as-fact", expectedType: "instruction/rule" },

  // -- Tool usage described as facts (10) --
  { msg: "The shared Google Drive is where all project proposals live", shouldBeInstruction: true, category: "tool-as-fact", expectedType: "instruction/tool_usage" },
  { msg: "We log all customer support interactions in Zendesk", shouldBeInstruction: true, category: "tool-as-fact", expectedType: "instruction/tool_usage" },
  { msg: "The deploy scripts are in the ops repo under /scripts/deploy", shouldBeInstruction: true, category: "tool-as-fact", expectedType: "instruction/tool_usage" },
  { msg: "Figma is what the design team uses for all mockups and prototypes", shouldBeInstruction: true, category: "tool-as-fact", expectedType: "instruction/tool_usage" },
  { msg: "The staging environment credentials are pinned in the #devops Slack channel", shouldBeInstruction: true, category: "tool-as-fact", expectedType: "instruction/tool_usage" },
  { msg: "All meeting notes go into the Notion workspace under the team folder", shouldBeInstruction: true, category: "tool-as-fact", expectedType: "instruction/tool_usage" },
  { msg: "GitHub Actions runs the full test suite on every PR", shouldBeInstruction: false, category: "fact", expectedType: "fact" },
  { msg: "Datadog is what we use to monitor API latency and error rates", shouldBeInstruction: true, category: "tool-as-fact", expectedType: "instruction/tool_usage" },
  { msg: "The product roadmap lives in Linear, not Jira anymore", shouldBeInstruction: true, category: "tool-as-fact", expectedType: "instruction/tool_usage" },
  { msg: "AWS costs are tracked in the FinOps dashboard under the billing account", shouldBeInstruction: true, category: "tool-as-fact", expectedType: "instruction/tool_usage" },

  // -- Preferences disguised as opinions (10) --
  { msg: "I'd rather we not do releases after 4pm, too risky", shouldBeInstruction: true, category: "preference-as-opinion", expectedType: "instruction/rule" },
  { msg: "Honestly I think all PRs should have at least two approvers going forward", shouldBeInstruction: true, category: "preference-as-opinion", expectedType: "instruction/rule" },
  { msg: "It would be nice if we kept retrospective notes under 1 page", shouldBeInstruction: true, category: "preference-as-opinion", expectedType: "instruction/rule" },
  { msg: "I feel strongly that customer data should never leave the EU region", shouldBeInstruction: true, category: "preference-as-opinion", expectedType: "instruction/rule" },
  { msg: "Can we please make sure error messages are user-friendly, not stack traces", shouldBeInstruction: true, category: "preference-as-opinion", expectedType: "instruction/rule" },
  { msg: "I really don't want us shipping features without feature flags", shouldBeInstruction: true, category: "preference-as-opinion", expectedType: "instruction/rule" },
  { msg: "My preference is that design reviews happen before dev starts, not after", shouldBeInstruction: true, category: "preference-as-opinion", expectedType: "instruction/rule" },
  { msg: "I believe we should keep API responses under 200ms for the core endpoints", shouldBeInstruction: true, category: "preference-as-opinion", expectedType: "instruction/rule" },
  { msg: "In my view, every outage should trigger a post-mortem within 48 hours", shouldBeInstruction: true, category: "preference-as-opinion", expectedType: "instruction/rule" },
  { msg: "Let's agree that hotfixes go through abbreviated review but still need tests", shouldBeInstruction: true, category: "preference-as-opinion", expectedType: "instruction/rule" },

  // -- Corrections that update rules (10) --
  { msg: "Actually the password policy changed — minimum 16 characters now, not 12", shouldBeInstruction: true, category: "correction-as-rule", expectedType: "instruction/rule" },
  { msg: "Wait, they moved the standup to Tuesday, not Monday anymore", shouldBeInstruction: true, category: "correction-as-rule", expectedType: "instruction/rule" },
  { msg: "I misspoke — the SLA is 4 hours response time, not 2", shouldBeInstruction: true, category: "correction-as-rule", expectedType: "instruction/rule" },
  { msg: "No actually, only senior devs should have prod database access, not everyone", shouldBeInstruction: true, category: "correction-as-rule", expectedType: "instruction/rule" },
  { msg: "Correction: the free tier allows 1000 API calls per day, not per hour", shouldBeInstruction: true, category: "correction-as-rule", expectedType: "instruction/rule" },
  { msg: "Scratch what I said before — vendors need to sign the NDA before we share any specs", shouldBeInstruction: true, category: "correction-as-rule", expectedType: "instruction/rule" },
  { msg: "The retention period is 90 days now, they extended it from 30", shouldBeInstruction: true, category: "correction-as-rule", expectedType: "instruction/rule" },
  { msg: "My bad, the cutoff for Q1 reports is March 15 not March 31", shouldBeInstruction: true, category: "correction-as-rule", expectedType: "instruction/rule" },
  { msg: "Oh right, I forgot — we need two-factor auth for the admin panel, not just a password", shouldBeInstruction: true, category: "correction-as-rule", expectedType: "instruction/rule" },
  { msg: "That's outdated — we stopped using Jenkins, everything goes through GitHub Actions now", shouldBeInstruction: true, category: "correction-as-rule", expectedType: "instruction/rule" },

  // -- Exception rules phrased as facts (10) --
  { msg: "Enterprise clients get 99.99% SLA, everyone else gets 99.9%", shouldBeInstruction: true, category: "exception-as-fact", expectedType: "instruction/rule" },
  { msg: "The Tokyo office runs on JST so their standups are at 10am their time", shouldBeInstruction: true, category: "exception-as-fact", expectedType: "instruction/rule" },
  { msg: "HIPAA clients need their data on dedicated infrastructure, not the shared cluster", shouldBeInstruction: true, category: "exception-as-fact", expectedType: "instruction/rule" },
  { msg: "Government contracts require all communication to go through the legal team", shouldBeInstruction: true, category: "exception-as-fact", expectedType: "instruction/rule" },
  { msg: "Startups on the free plan don't get phone support, only email", shouldBeInstruction: true, category: "exception-as-fact", expectedType: "instruction/rule" },
  { msg: "For the German market, all user-facing text needs to go through the localization team", shouldBeInstruction: true, category: "exception-as-fact", expectedType: "instruction/rule" },
  { msg: "Internal tools don't need the same accessibility audit as customer-facing ones", shouldBeInstruction: true, category: "exception-as-fact", expectedType: "instruction/rule" },
  { msg: "Quarterly clients get invoiced at the start of the quarter, monthly clients at the end of the month", shouldBeInstruction: true, category: "exception-as-fact", expectedType: "instruction/rule" },
  { msg: "Open source contributions need extra IP review that internal code doesn't", shouldBeInstruction: true, category: "exception-as-fact", expectedType: "instruction/rule" },
  { msg: "The finance team uses a different approval workflow than engineering — they need VP sign-off for anything over £500", shouldBeInstruction: true, category: "exception-as-fact", expectedType: "instruction/rule" },

  // -- Multi-step processes described casually (10) --
  { msg: "For refunds, first check the order in Stripe, then verify with the CS rep, then process through the admin panel", shouldBeInstruction: true, category: "casual-process", expectedType: "instruction/process" },
  { msg: "Whenever someone leaves the company, disable their accounts, revoke keys, and notify IT within 24 hours", shouldBeInstruction: true, category: "casual-process", expectedType: "instruction/process" },
  { msg: "New hires need laptop setup, badge access, Slack invite, and a buddy assigned in the first week", shouldBeInstruction: true, category: "casual-process", expectedType: "instruction/process" },
  { msg: "To push to production: branch from main, get 2 reviews, pass CI, then merge — no direct pushes", shouldBeInstruction: true, category: "casual-process", expectedType: "instruction/process" },
  { msg: "Client onboarding is: sign contract, create workspace, import data, schedule training call", shouldBeInstruction: true, category: "casual-process", expectedType: "instruction/process" },
  { msg: "Incident response: acknowledge in PagerDuty, open a Slack thread, fix it, then write the post-mortem", shouldBeInstruction: true, category: "casual-process", expectedType: "instruction/process" },
  { msg: "Patent filing process: invention disclosure → legal review → prior art search → file with attorney", shouldBeInstruction: true, category: "casual-process", expectedType: "instruction/process" },
  { msg: "When a payment fails, we retry 3 times over 7 days, send a warning email, then suspend the account", shouldBeInstruction: true, category: "casual-process", expectedType: "instruction/process" },
  { msg: "Feature launches go: internal dogfood → beta group → 10% rollout → full GA", shouldBeInstruction: true, category: "casual-process", expectedType: "instruction/process" },
  { msg: "Quarterly planning: each team submits proposals, leadership prioritizes, then we size and schedule", shouldBeInstruction: true, category: "casual-process", expectedType: "instruction/process" },

  // -- Bans and constraints stated softly (10) --
  { msg: "We moved away from using personal email accounts for any work communication", shouldBeInstruction: true, category: "soft-ban", expectedType: "instruction/rule" },
  { msg: "The consensus is that we shouldn't store credit card numbers ourselves", shouldBeInstruction: true, category: "soft-ban", expectedType: "instruction/rule" },
  { msg: "We've decided not to support IE11 anymore, it's just not worth it", shouldBeInstruction: true, category: "soft-ban", expectedType: "instruction/rule" },
  { msg: "Auto-scaling is turned off for the dev environment to keep costs down", shouldBeInstruction: true, category: "soft-ban", expectedType: "instruction/rule" },
  { msg: "We try not to schedule meetings during the team's focus block from 1-4pm", shouldBeInstruction: true, category: "soft-ban", expectedType: "instruction/rule" },
  { msg: "External contractors shouldn't have write access to the main repo", shouldBeInstruction: true, category: "soft-ban", expectedType: "instruction/rule" },
  { msg: "Nobody should be committing API keys to version control, use the secrets manager instead", shouldBeInstruction: true, category: "soft-ban", expectedType: "instruction/rule" },
  { msg: "We avoid using third-party cookies since the privacy policy update", shouldBeInstruction: true, category: "soft-ban", expectedType: "instruction/rule" },
  { msg: "The decision was made to stop doing manual QA for microservices, we rely on automated tests", shouldBeInstruction: true, category: "soft-ban", expectedType: "instruction/rule" },
  { msg: "We agreed not to use the production database for any kind of testing or experiments", shouldBeInstruction: true, category: "soft-ban", expectedType: "instruction/rule" },

  // -- Thresholds embedded in conversational statements (10) --
  { msg: "Pages that take more than 3 seconds to load are flagged in our performance dashboard", shouldBeInstruction: true, category: "embedded-threshold", expectedType: "instruction/rule" },
  { msg: "Anything with a severity of P1 or P2 wakes the on-call engineer", shouldBeInstruction: true, category: "embedded-threshold", expectedType: "instruction/rule" },
  { msg: "We keep code coverage at 80% minimum, anything below blocks the merge", shouldBeInstruction: true, category: "embedded-threshold", expectedType: "instruction/rule" },
  { msg: "Support tickets must be responded to within 4 business hours for paid customers", shouldBeInstruction: true, category: "embedded-threshold", expectedType: "instruction/rule" },
  { msg: "The content security policy blocks any inline scripts or styles", shouldBeInstruction: true, category: "embedded-threshold", expectedType: "instruction/rule" },
  { msg: "API rate limiting is set to 100 requests per minute per user", shouldBeInstruction: true, category: "embedded-threshold", expectedType: "instruction/rule" },
  { msg: "Pull requests with more than 500 lines changed need to be broken into smaller chunks", shouldBeInstruction: true, category: "embedded-threshold", expectedType: "instruction/rule" },
  { msg: "The CDN cache TTL for static assets is 24 hours", shouldBeInstruction: true, category: "embedded-threshold", expectedType: "instruction/rule" },
  { msg: "Database queries that take longer than 500ms trigger an alert in Datadog", shouldBeInstruction: true, category: "embedded-threshold", expectedType: "instruction/rule" },
  { msg: "Any spend above the team's quarterly budget needs the director's approval", shouldBeInstruction: true, category: "embedded-threshold", expectedType: "instruction/rule" },

  // ═══ NOT INSTRUCTIONS (20) ═══
  // -- Pure facts (7) --
  { msg: "Our ARR crossed $5 million last quarter", shouldBeInstruction: false, category: "fact", expectedType: "fact" },
  { msg: "The engineering team has 23 people across 4 time zones", shouldBeInstruction: false, category: "fact", expectedType: "fact" },
  { msg: "We signed the contract with Acme Corp in January", shouldBeInstruction: false, category: "fact", expectedType: "fact" },
  { msg: "The company was founded in 2019 in London", shouldBeInstruction: false, category: "fact", expectedType: "fact" },
  { msg: "React is our primary frontend framework", shouldBeInstruction: false, category: "fact", expectedType: "fact" },
  { msg: "The enterprise plan costs $499 per month", shouldBeInstruction: false, category: "fact", expectedType: "fact" },
  { msg: "There are three microservices in the payment processing pipeline", shouldBeInstruction: false, category: "fact", expectedType: "fact" },

  // -- Events (6) --
  { msg: "The server went down for about 20 minutes yesterday afternoon", shouldBeInstruction: false, category: "event", expectedType: "event" },
  { msg: "Tom submitted the Q3 budget proposal on Friday", shouldBeInstruction: false, category: "event", expectedType: "event" },
  { msg: "We lost two customers last month due to pricing complaints", shouldBeInstruction: false, category: "event", expectedType: "event" },
  { msg: "The migration to the new database finished over the weekend", shouldBeInstruction: false, category: "event", expectedType: "event" },
  { msg: "Maria presented the roadmap at the all-hands yesterday", shouldBeInstruction: false, category: "event", expectedType: "event" },
  { msg: "We shipped version 3.2 last Tuesday with the new dashboard", shouldBeInstruction: false, category: "event", expectedType: "event" },

  // -- Opinions (4) --
  { msg: "I think the new onboarding flow is much better than the old one", shouldBeInstruction: false, category: "opinion", expectedType: "opinion" },
  { msg: "Tom's been doing a great job with the infrastructure work", shouldBeInstruction: false, category: "opinion", expectedType: "opinion" },
  { msg: "The Kubernetes migration was worth the effort in hindsight", shouldBeInstruction: false, category: "opinion", expectedType: "opinion" },
  { msg: "I feel like the sprint velocity has improved this quarter", shouldBeInstruction: false, category: "opinion", expectedType: "opinion" },

  // -- Questions (3) --
  { msg: "Who handles the on-call rotation for the API team?", shouldBeInstruction: false, category: "question", expectedType: "(skip)" },
  { msg: "Do we have a process for handling GDPR data deletion requests?", shouldBeInstruction: false, category: "question", expectedType: "(skip)" },
  { msg: "What's our policy on remote work for contractors?", shouldBeInstruction: false, category: "question", expectedType: "(skip)" },
];

// ── Mock L1 result for filter testing ──

function mockL1(msg: string, category: string): Layer1Result {
  return {
    entities: [],
    implied_facts: category === "question" ? [] : [msg],
    events: [],
    plans: [],
    opinions: [],
    concepts: [],
    implied_processes: [],
    intents: ["instruction"],
    operations: { retrieve: false, store: category !== "question" },
  };
}

// ── Runner ──

interface Row {
  idx: number;
  query: string;
  result: string;
  expected: string;
  ok: boolean;
  timeS: number;
  filterItems: string[];
  duplicated: boolean;
}

async function main() {
  console.log(`\n═══ Full Pipeline Test — Extractor-First Approach ═══`);
  console.log(`Messages: ${MESSAGES.length} (${MESSAGES.filter(m => m.shouldBeInstruction).length} instructions, ${MESSAGES.filter(m => !m.shouldBeInstruction).length} non-instructions)\n`);

  resetUsage();
  const globalStart = Date.now();
  const rows: Row[] = [];

  for (let i = 0; i < MESSAGES.length; i++) {
    const { msg, shouldBeInstruction, category, expectedType } = MESSAGES[i];
    const idx = i + 1;
    process.stderr.write(`  [${String(idx).padStart(3)}/${MESSAGES.length}] ${msg.slice(0, 55)}...`);

    const msgStart = Date.now();

    // Step 1: Instruction extractor (runs first in the new approach)
    const instrResult = await extractInstructions(msg);

    // Step 2: Store filter, informed about extracted instructions
    let filterItems: string[] = [];
    let duplicated = false;
    if (category !== "question") {
      const l1 = mockL1(msg, category);
      const filterResult = await filterForStorage(msg, l1, instrResult.instructions);

      // Check what the filter produced
      for (const item of filterResult.storeItems) {
        filterItems.push(`${item.type}${item.subtype ? '/' + item.subtype : ''}`);
      }

      // Check for duplication: did the filter ALSO produce an instruction despite being told not to?
      const filterInstructions = filterResult.storeItems.filter(si => si.type === "instruction");
      if (instrResult.instructions.length > 0 && filterInstructions.length > 0) {
        duplicated = true;
      }
    }

    const timeS = (Date.now() - msgStart) / 1000;

    // Determine combined result
    let result: string;
    if (instrResult.instructions.length > 0) {
      result = `instruction/${instrResult.instructions[0].subtype}`;
    } else if (filterItems.length > 0) {
      result = filterItems[0];
    } else {
      result = "(skip)";
    }

    const ok = shouldBeInstruction
      ? instrResult.instructions.length > 0
      : instrResult.instructions.length === 0;

    process.stderr.write(` [${ok ? "OK" : "!!"}] ${timeS.toFixed(1)}s\n`);

    rows.push({ idx, query: msg, result, expected: expectedType, ok, timeS, filterItems, duplicated });
  }

  const totalTime = (Date.now() - globalStart) / 1000;
  const usage = getUsage();
  const cost = (usage.l1_input * 0.08 + usage.l1_output * 0.36) / 1_000_000;

  // ── Output table ──
  console.log();
  console.log(`| # | Query | Result | Expected | OK |`);
  console.log(`|---|-------|--------|----------|----|`);
  for (const r of rows) {
    const q = r.query.length > 65 ? r.query.slice(0, 62) + "..." : r.query;
    const dup = r.duplicated ? " DUP!" : "";
    const mark = r.ok ? "Y" : "N";
    console.log(`| ${String(r.idx).padStart(3)} | ${q} | ${r.result}${dup} | ${r.expected} | ${mark} |`);
  }

  // ── Duplications ──
  const dups = rows.filter(r => r.duplicated);
  if (dups.length > 0) {
    console.log(`\n⚠ DUPLICATIONS (${dups.length}): filter also produced instructions despite being informed`);
    for (const d of dups) {
      console.log(`  [${d.idx}] ${d.query.slice(0, 60)} → filter: ${d.filterItems.join(", ")}`);
    }
  } else {
    console.log(`\n✓ Zero duplications — filter respected all extracted instructions`);
  }

  // ── Summary ──
  const correct = rows.filter(r => r.ok).length;
  const misses = rows.filter(r => !r.ok && r.expected.startsWith("instruction")).length;
  const fps = rows.filter(r => !r.ok && !r.expected.startsWith("instruction")).length;

  console.log(`\n═══ Summary ═══`);
  console.log(`Accuracy: ${correct}/${rows.length} (${(correct / rows.length * 100).toFixed(1)}%)`);
  console.log(`Misses: ${misses} | False positives: ${fps}`);
  console.log(`Total time: ${totalTime.toFixed(1)}s (${(totalTime / rows.length).toFixed(2)}s/msg)`);
  console.log(`Total cost: $${cost.toFixed(4)}`);
  console.log(`Tokens: input=${usage.l1_input} output=${usage.l1_output}`);
  console.log();
}

main().catch(console.error);
