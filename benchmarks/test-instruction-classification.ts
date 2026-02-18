/**
 * Test: What % of instruction-like messages actually get classified as "instruction"?
 *
 * Runs 50 tricky messages through L1 classify + L1.5 store filter (where the type
 * decision is made) and reports misclassification rates.
 *
 * Usage:
 *   bun test-instruction-classification.ts
 *   bun test-instruction-classification.ts --batch-size 10
 */
import { classify } from "../src/memory/layer1";
import { agenticLoop } from "../src/memory/layer2";
import { getDb } from "../src/memory/db-core";
import { getUsage, resetUsage, calculateCosts } from "../src/memory/usage-tracker";

const db = getDb();
import { LAYER1_MODEL, LAYER2_MODEL, VOYAGE_MODEL } from "../src/memory/config";

const BATCH_SIZE = parseInt(process.argv.find(a => a.startsWith("--batch-size="))?.split("=")[1] ?? "25");

// 50 messages that SHOULD be stored as instructions — tricky phrasing
const MESSAGES: { msg: string; difficulty: string }[] = [
  // --- Implicit rules (no "always"/"never", just describing how things work) ---
  { msg: "Dave checks grammar before anything goes to Sarah", difficulty: "implicit process" },
  { msg: "Articles go through three rounds of review at WOBS", difficulty: "process as fact" },
  { msg: "The Airtable board is where we track all client deliverables", difficulty: "tool usage as fact" },
  { msg: "Peter writes the first draft, then Sarah edits, then it goes to the client", difficulty: "multi-step process" },
  { msg: "Surfer scores need to be 75 or above before we can publish", difficulty: "threshold as fact" },
  { msg: "Client invoices go out on the 1st of every month", difficulty: "schedule as fact" },
  { msg: "Each article gets a plagiarism check through Originality.ai", difficulty: "process as fact" },
  { msg: "The WordPress login credentials are in the shared 1Password vault", difficulty: "location instruction" },
  { msg: "Brightwell articles need to be reviewed by their in-house medical team too", difficulty: "client-specific rule" },
  { msg: "We bill Anderson quarterly, not monthly like the others", difficulty: "exception rule" },

  // --- Soft/conditional rules ---
  { msg: "If a client complains about quality, escalate to Marcus immediately", difficulty: "conditional rule" },
  { msg: "When Dave misses a deadline, Sarah needs to cover his assignments", difficulty: "contingency process" },
  { msg: "Try to keep Anderson articles under 2500 words unless they specifically ask for longer", difficulty: "soft constraint" },
  { msg: "If an article fails the Surfer check twice, flag it for a full rewrite", difficulty: "conditional threshold" },
  { msg: "For health content, always get a second opinion from someone with medical knowledge", difficulty: "domain rule" },
  { msg: "When onboarding a new client, the first thing to do is create their Airtable workspace", difficulty: "onboarding step" },
  { msg: "In case of factual errors in published content, take it down within 2 hours", difficulty: "incident response" },
  { msg: "If Peter is on holiday, Dave picks up the Anderson work", difficulty: "backup assignment" },
  { msg: "Whenever we get a new Canopy Digital brief, check if it overlaps with existing client topics", difficulty: "conditional check" },
  { msg: "If the Originality.ai score is below 90, the article needs to be substantially rewritten", difficulty: "threshold rule" },

  // --- Role assignments (look like facts but are really instructions) ---
  { msg: "Sarah is the only person who should have publishing access to client WordPress sites", difficulty: "access control" },
  { msg: "Marcus handles all client contract negotiations, nobody else should discuss pricing", difficulty: "authority rule" },
  { msg: "Lisa is responsible for chasing late payments from clients", difficulty: "role as instruction" },
  { msg: "Dave should only be assigned Brightwell and Meridian Health work for now", difficulty: "assignment constraint" },
  { msg: "Peter is the go-to person for any Anderson technical questions", difficulty: "role as fact" },

  // --- Preferences that are really rules ---
  { msg: "I prefer that we never publish articles on Fridays — clients don't read them over the weekend", difficulty: "preference as rule" },
  { msg: "We should avoid using stock photos from Unsplash for Meridian Health — they want original imagery", difficulty: "client preference" },
  { msg: "I don't want anyone using ChatGPT for first drafts anymore, it's causing too many Originality issues", difficulty: "ban as preference" },
  { msg: "Let's make sure all Anderson articles include at least 3 internal links to their existing blog posts", difficulty: "content rule as suggestion" },
  { msg: "Going forward, every article should have a meta description written by the author, not auto-generated", difficulty: "new policy" },

  // --- Corrections that establish rules ---
  { msg: "Actually, all Meridian Health articles need to cite at least 2 peer-reviewed sources", difficulty: "correction as rule" },
  { msg: "No wait, the Surfer minimum is 80 now, not 75 — we raised it last week", difficulty: "threshold update" },
  { msg: "Scratch that — Dave shouldn't have access to the Anderson WordPress anymore after the incident", difficulty: "access revocation" },
  { msg: "I was wrong earlier, Canopy Digital wants fortnightly delivery not weekly", difficulty: "schedule correction" },
  { msg: "Update: Brightwell now requires all articles to be reviewed by their compliance team before publishing", difficulty: "new requirement" },

  // --- Complex multi-part instructions ---
  { msg: "The content pipeline is: brief from client → outline by writer → outline approval from Lisa → first draft → Sarah edit → Surfer check → client review → publish", difficulty: "full pipeline" },
  { msg: "For Anderson specifically: draft → internal review → Surfer 80+ → Anderson's tech team review → publish to their CMS not WordPress", difficulty: "client-specific pipeline" },
  { msg: "When we lose a client, archive their Airtable workspace, export all content to Google Drive, and send a final invoice within 5 business days", difficulty: "multi-step offboarding" },
  { msg: "New article onboarding: check Originality.ai, run through Surfer, get Sarah's sign-off, then schedule in WordPress for next Tuesday 9am", difficulty: "multi-tool process" },
  { msg: "Quarterly reporting for each client: pull analytics from GSC, compare against KPIs in Airtable, write summary, send to Lisa for client distribution", difficulty: "reporting process" },

  // --- Negative/boundary rules ---
  { msg: "We don't do same-day turnarounds, minimum is 48 hours for any article", difficulty: "negative constraint" },
  { msg: "Nobody should be editing published articles without creating a revision note in Airtable first", difficulty: "edit control" },
  { msg: "Don't assign Dave more than 5 articles per week — he's still learning and quality drops", difficulty: "capacity limit" },
  { msg: "We stopped doing guest post outreach for clients, that's handled by their own teams now", difficulty: "service boundary" },
  { msg: "The free revision policy is max 2 rounds per article, anything beyond that is billed separately", difficulty: "billing rule" },

  // --- Tricky edge cases ---
  { msg: "Anderson pays £4,000 per month and that includes up to 20 articles", difficulty: "pricing with embedded limit" },
  { msg: "Dave's been doing really well with the Brightwell work lately, keep assigning him their stuff", difficulty: "performance-based assignment" },
  { msg: "Sarah mentioned that the Meridian Health team wants us to use their style guide from now on", difficulty: "second-hand instruction" },
  { msg: "The way we handle SEO is: Surfer for on-page, Ahrefs for backlink research, and GSC for monitoring", difficulty: "tool assignment" },
  { msg: "I told the Anderson team we'd deliver 5 articles per week starting next month, so plan for that", difficulty: "commitment as instruction" },
];

interface TestResult {
  msg: string;
  difficulty: string;
  l1_intents: string[];
  filter_type: string | null;
  filter_subtype: string | null;
  is_instruction: boolean;
  raw_types: string[];
}

async function runBatch(batch: typeof MESSAGES, batchNum: number): Promise<TestResult[]> {
  const results: TestResult[] = [];

  for (let i = 0; i < batch.length; i++) {
    const { msg, difficulty } = batch[i];
    const globalIdx = (batchNum - 1) * BATCH_SIZE + i + 1;
    process.stderr.write(`  [${globalIdx}/50] ${msg.slice(0, 60)}...`);

    try {
      const l1c = await classify(msg);
      const l1 = l1c.result;

      // We need the store filter result — agenticLoop runs it internally
      // But we only want filter, not actual storage. Trick: override operations to store-only
      const fakeL1 = { ...l1, operations: { retrieve: false, store: true } };
      const result = await agenticLoop(db, msg, fakeL1);

      const storeItems = result.storeFilter?.storeItems ?? [];
      const types = storeItems.map(s => s.type);
      const firstItem = storeItems[0];

      const isInstruction = types.includes("instruction");

      results.push({
        msg,
        difficulty,
        l1_intents: l1.intents,
        filter_type: firstItem?.type ?? null,
        filter_subtype: firstItem?.subtype ?? null,
        is_instruction: isInstruction,
        raw_types: types,
      });

      const marker = isInstruction ? "OK" : "MISS";
      process.stderr.write(` → ${types.join(",")||"(none)"} [${marker}]\n`);
    } catch (err) {
      process.stderr.write(` → ERROR: ${(err as Error).message.slice(0, 80)}\n`);
      results.push({
        msg,
        difficulty,
        l1_intents: [],
        filter_type: "ERROR",
        filter_subtype: null,
        is_instruction: false,
        raw_types: ["ERROR"],
      });
    }
  }

  return results;
}

async function main() {
  console.log(`\n═══ Instruction Classification Test ═══`);
  console.log(`Messages: ${MESSAGES.length} | Batch size: ${BATCH_SIZE}\n`);

  resetUsage();
  const startTime = Date.now();
  const allResults: TestResult[] = [];

  // Run in batches
  for (let i = 0; i < MESSAGES.length; i += BATCH_SIZE) {
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const batch = MESSAGES.slice(i, i + BATCH_SIZE);
    console.log(`── Batch ${batchNum} (${batch.length} messages) ──`);
    const results = await runBatch(batch, batchNum);
    allResults.push(...results);
    console.log();
  }

  const duration = Date.now() - startTime;

  // Results
  const hits = allResults.filter(r => r.is_instruction);
  const misses = allResults.filter(r => !r.is_instruction);

  console.log(`═══ Results ═══`);
  console.log(`Hit rate: ${hits.length}/${allResults.length} (${(hits.length / allResults.length * 100).toFixed(1)}%) stored as instruction`);
  console.log();

  if (misses.length > 0) {
    console.log(`── Misclassified (${misses.length}) ──`);
    for (const m of misses) {
      console.log(`  [${m.difficulty}] "${m.msg.slice(0, 70)}${m.msg.length > 70 ? "..." : ""}"`);
      console.log(`    → type: ${m.filter_type}/${m.filter_subtype} | intents: ${m.l1_intents.join(",")}`);
    }
    console.log();
  }

  // Breakdown by difficulty category
  const categories = new Map<string, { total: number; hits: number }>();
  for (const r of allResults) {
    const cat = r.difficulty;
    const entry = categories.get(cat) ?? { total: 0, hits: 0 };
    entry.total++;
    if (r.is_instruction) entry.hits++;
    categories.set(cat, entry);
  }

  // Type distribution
  const typeDist = new Map<string, number>();
  for (const r of allResults) {
    const key = `${r.filter_type}/${r.filter_subtype}`;
    typeDist.set(key, (typeDist.get(key) ?? 0) + 1);
  }
  console.log(`── Type Distribution ──`);
  for (const [type, count] of [...typeDist.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type}: ${count}`);
  }
  console.log();

  // Costs
  const usage = getUsage();
  const costs = calculateCosts(LAYER1_MODEL, LAYER2_MODEL, VOYAGE_MODEL, usage);
  console.log(`── Costs ──`);
  console.log(`  Duration: ${(duration / 1000).toFixed(1)}s`);
  console.log(`  Total: $${costs.total_cost.toFixed(4)}`);
  console.log(`  Per message: $${(costs.total_cost / allResults.length).toFixed(5)}`);
  console.log();
}

main().catch(console.error);
