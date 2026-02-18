/**
 * Conversation follow-up pipeline test.
 *
 * ALWAYS uses the noisy-large DB (20K items) for realistic evaluation.
 * Makes a working copy so the original DB is never modified.
 *
 * Simulates a 45-turn conversation, sending messages one at a time through
 * the same code paths as on-prompt.ts. After each turn:
 *   - Records which pipeline path was taken (full vs follow-up)
 *   - Records what was stored in the DB (new nodes)
 *   - Compares actual storage against expected storage
 *
 * Usage:
 *   bun test-conversation.ts
 *   bun test-conversation.ts --only 3,7    # run specific turns only
 */
import { join } from "path";
import { existsSync, copyFileSync, unlinkSync, mkdirSync } from "fs";
import Database from "bun:sqlite";

// ── DB setup: copy noisy-large to a temp working copy ───────────────
const HOME = process.env.HOME || "~";
const NOISY_DB = join(HOME, ".octybot", "test", "memory-noisy-large.db");
const WORK_DB = join(HOME, ".octybot", "test", "memory-conversation-test.db");

if (!existsSync(NOISY_DB)) {
  console.error(`ERROR: Noisy-large DB not found at ${NOISY_DB}`);
  console.error(`Run: bun generate-bulk.ts to create it`);
  process.exit(1);
}

// Copy to working location (so we don't pollute the 20K original)
copyFileSync(NOISY_DB, WORK_DB);
// Also copy WAL/SHM if they exist
try { copyFileSync(NOISY_DB + "-wal", WORK_DB + "-wal"); } catch {}
try { copyFileSync(NOISY_DB + "-shm", WORK_DB + "-shm"); } catch {}

// Force DB_PATH BEFORE any memory imports (they read it at import time)
process.env.DB_PATH = WORK_DB;

// Dynamic imports — must happen AFTER env var is set (static imports are hoisted)
const { classify } = await import("../memory/layer1");
const { agenticLoop, readConversationState, writeConversationState } = await import("../memory/layer2");
const { followUpPipeline } = await import("../memory/follow-up");
const { getDb } = await import("../memory/db-core");
const { CONVERSATION_STATE_PATH, DB_PATH } = await import("../memory/config");

const db = getDb();
const { resetUsage, getUsage, calculateCosts } = await import("../memory/usage-tracker");
type ConversationTurn = import("../memory/types").ConversationTurn;

// ── Test conversation: 10 turns ─────────────────────────────────────

interface TestTurn {
  prompt: string;
  expectedPath: "full" | "followup";
  expectedStore: { type: string; contentMatch: string }[];
  expectedNoStore: string[];
}

const CONVERSATION: TestTurn[] = [
  // Turn 1: First message, no state → MUST be full pipeline
  // "handles X" is a role assignment → instruction/rule is correct
  {
    prompt: "Dave handles all the SEO content for our agency. He manages three writers and reports to Sarah.",
    expectedPath: "full",
    expectedStore: [
      { type: "instruction", contentMatch: "SEO" },
    ],
    expectedNoStore: [],
  },

  // Turn 2: Follow-up about Dave (pronoun "he" → Dave)
  {
    prompt: "He also runs the Brightwell account, their biggest client paying £4,000 a month.",
    expectedPath: "followup",
    expectedStore: [
      { type: "fact", contentMatch: "Brightwell" },
      { type: "fact", contentMatch: "4,000" },
    ],
    expectedNoStore: [],
  },

  // Turn 3: Pure question — no storage expected
  {
    prompt: "What tools does he use for keyword research?",
    expectedPath: "followup",
    expectedStore: [],
    expectedNoStore: ["keyword research"],
  },

  // Turn 4: New instruction
  {
    prompt: "From now on, all SEO articles must go through Surfer before publishing.",
    expectedPath: "followup",
    expectedStore: [
      { type: "instruction", contentMatch: "Surfer" },
    ],
    expectedNoStore: [],
  },

  // Turn 5: New entity + fact (topic shift within conversation)
  // "handles X" is a role assignment → instruction/rule is correct
  // Follow-up LLM resolves "She" → "Lisa" via resolved_prompt
  {
    prompt: "Actually, let me tell you about Lisa too. She handles the finances and invoicing for all our clients.",
    expectedPath: "followup",
    expectedStore: [
      { type: "instruction", contentMatch: "Lisa" },
    ],
    expectedNoStore: [],
  },

  // Turn 6: Event
  {
    prompt: "Dave missed the Brightwell deadline last Friday, Sarah had to step in and finish the article.",
    expectedPath: "followup",
    expectedStore: [
      { type: "event", contentMatch: "deadline" },
    ],
    expectedNoStore: [],
  },

  // Turn 7: Follow-up question using pronouns (she → Sarah from context)
  {
    prompt: "How often does she have to do that?",
    expectedPath: "followup",
    expectedStore: [],
    expectedNoStore: [],
  },

  // Turn 8: Correction
  {
    prompt: "Oh wait, Brightwell actually pays £4,500 now, they got a rate increase last month.",
    expectedPath: "followup",
    expectedStore: [
      { type: "fact", contentMatch: "4,500" },
    ],
    expectedNoStore: [],
  },

  // Turn 9: Opinion
  {
    prompt: "I think Dave's work quality has been slipping since he took on the third writer.",
    expectedPath: "followup",
    expectedStore: [
      { type: "opinion", contentMatch: "slipping" },
    ],
    expectedNoStore: [],
  },

  // Turn 10: Event with date (holiday is something that's happening, not a plan)
  {
    prompt: "Dave's going on holiday March 15th, so Sarah needs to cover Brightwell that week.",
    expectedPath: "followup",
    expectedStore: [
      { type: "event", contentMatch: "March 15" },
    ],
    expectedNoStore: [],
  },

  // ── Pronoun resolution stress tests (turns 11-15) ──

  // Turn 11: "their" → Brightwell's (possessive pronoun for an org)
  // Contract renewal in April is a scheduled future event, not a static fact
  {
    prompt: "Their contract is up for renewal in April, we need to prepare a proposal.",
    expectedPath: "followup",
    expectedStore: [
      { type: "event", contentMatch: "Brightwell" },
    ],
    expectedNoStore: [],
  },

  // Turn 12: "them" → the writers (plural reference from turn 1)
  {
    prompt: "We're paying them too little, each writer only gets £800 per article.",
    expectedPath: "followup",
    expectedStore: [
      { type: "fact", contentMatch: "800" },
    ],
    expectedNoStore: [],
  },

  // Turn 13: "it" → the Brightwell account / contract (thing reference)
  // This is a historical fact about who managed what, not an event
  {
    prompt: "It used to be managed by Sarah before Dave took over last year.",
    expectedPath: "followup",
    expectedStore: [
      { type: "fact", contentMatch: "Sarah" },
    ],
    expectedNoStore: [],
  },

  // Turn 14: "that team" / implicit reference to Dave's writers
  {
    prompt: "That team also handles the ContentShake reviews for all our clients.",
    expectedPath: "followup",
    expectedStore: [
      { type: "instruction", contentMatch: "ContentShake" },
    ],
    expectedNoStore: [],
  },

  // Turn 15: Mixed — "his" + "her" in the same sentence, storage-worthy
  // "deadline is always X" is a recurring rule, not a fact
  {
    prompt: "His deadline is always Wednesday, but her reviews are due by Friday.",
    expectedPath: "followup",
    expectedStore: [
      { type: "instruction", contentMatch: "Dave" },
    ],
    expectedNoStore: [],
  },

  // ── Should-NOT-store: questions, small talk, acknowledgments (turns 16-25) ──

  // Turn 16: Simple acknowledgment — no new info
  {
    prompt: "Ok, got it.",
    expectedPath: "followup",
    expectedStore: [],
    expectedNoStore: ["got it"],
  },

  // Turn 17: Follow-up question — no storage
  {
    prompt: "What's Sarah's email?",
    expectedPath: "followup",
    expectedStore: [],
    expectedNoStore: ["email"],
  },

  // Turn 18: Thinking out loud / rhetorical — no storage
  {
    prompt: "I wonder if we should hire another writer.",
    expectedPath: "followup",
    expectedStore: [],
    expectedNoStore: ["hire"],
  },

  // Turn 19: Requesting an action — no storage
  {
    prompt: "Can you send me a summary of the Brightwell account?",
    expectedPath: "followup",
    expectedStore: [],
    expectedNoStore: ["summary"],
  },

  // Turn 20: Vague filler — no storage
  {
    prompt: "Yeah, that makes sense.",
    expectedPath: "followup",
    expectedStore: [],
    expectedNoStore: ["sense"],
  },

  // Turn 21: Repeating known info — no storage
  {
    prompt: "So Dave runs the Brightwell account, right?",
    expectedPath: "followup",
    expectedStore: [],
    expectedNoStore: ["Brightwell"],
  },

  // Turn 22: Pure question about process
  {
    prompt: "How does the content review process work?",
    expectedPath: "followup",
    expectedStore: [],
    expectedNoStore: ["review"],
  },

  // Turn 23: Thanks / closing remark
  {
    prompt: "Thanks, that's helpful.",
    expectedPath: "followup",
    expectedStore: [],
    expectedNoStore: ["helpful"],
  },

  // Turn 24: Meta-question about the conversation
  {
    prompt: "Wait, did I already tell you about Lisa?",
    expectedPath: "followup",
    expectedStore: [],
    expectedNoStore: ["Lisa"],
  },

  // Turn 25: Greeting / small talk
  {
    prompt: "Anyway, let's move on.",
    expectedPath: "followup",
    expectedStore: [],
    expectedNoStore: ["move on"],
  },

  // ── Should-store: new info, corrections, instructions (turns 26-45) ──

  // Turn 26: New person + role
  {
    prompt: "We just hired Alex as a junior writer. He starts next Monday.",
    expectedPath: "followup",
    expectedStore: [
      { type: "event", contentMatch: "Alex" },
    ],
    expectedNoStore: [],
  },

  // Turn 27: Tool switch — "we switched" is an event that happened
  // The second sentence ("all comms go through Teams") gets stored as instruction/tool_usage
  {
    prompt: "We switched from Slack to Microsoft Teams last month. All internal comms go through Teams now.",
    expectedPath: "followup",
    expectedStore: [
      { type: "instruction", contentMatch: "Teams" },
    ],
    expectedNoStore: [],
  },

  // Turn 28: Correction — factual number update
  {
    prompt: "Oh, and Brightwell's headcount grew to 45 employees last quarter. They used to be around 30.",
    expectedPath: "followup",
    expectedStore: [
      { type: "fact", contentMatch: "45" },
    ],
    expectedNoStore: [],
  },

  // Turn 29: Client-specific rule
  {
    prompt: "Anderson requires all articles to be at least 2,000 words. No exceptions.",
    expectedPath: "followup",
    expectedStore: [
      { type: "instruction", contentMatch: "2,000" },
    ],
    expectedNoStore: [],
  },

  // Turn 30: Opinion about a tool
  {
    prompt: "I think Surfer SEO is overpriced for what it does, but Sarah loves it.",
    expectedPath: "followup",
    expectedStore: [
      { type: "opinion", contentMatch: "Surfer" },
    ],
    expectedNoStore: [],
  },

  // Turn 31: Event with specific date
  {
    prompt: "Marcus closed the Brightwell renewal deal yesterday for £5,200 a month.",
    expectedPath: "followup",
    expectedStore: [
      { type: "event", contentMatch: "5,200" },
    ],
    expectedNoStore: [],
  },

  // Turn 32: Process change / new rule
  {
    prompt: "Going forward, all new client onboarding must include a kickoff call with Marcus.",
    expectedPath: "followup",
    expectedStore: [
      { type: "instruction", contentMatch: "Marcus" },
    ],
    expectedNoStore: [],
  },

  // Turn 33: Promotion — now a fact about James's current role
  {
    prompt: "You know what, James just got promoted to senior link builder.",
    expectedPath: "followup",
    expectedStore: [
      { type: "fact", contentMatch: "James" },
    ],
    expectedNoStore: [],
  },

  // Turn 34: Negative fact — something that ISN'T true
  {
    prompt: "Peter doesn't do any client communication. That's all Lisa.",
    expectedPath: "followup",
    expectedStore: [
      { type: "instruction", contentMatch: "Peter" },
    ],
    expectedNoStore: [],
  },

  // Turn 35: Multi-entity relationship
  {
    prompt: "Sarah mentors Alex, and Dave is supposed to review all of Alex's work before it goes to Sarah.",
    expectedPath: "followup",
    expectedStore: [
      { type: "instruction", contentMatch: "Alex" },
    ],
    expectedNoStore: [],
  },

  // Turn 36: Question — should NOT store
  {
    prompt: "Is there a template for the monthly GSC reports?",
    expectedPath: "followup",
    expectedStore: [],
    expectedNoStore: ["template"],
  },

  // Turn 37: Preference / personal rule
  {
    prompt: "I prefer getting updates on Brightwell every Monday morning before standup.",
    expectedPath: "followup",
    expectedStore: [
      { type: "instruction", contentMatch: "Monday" },
    ],
    expectedNoStore: [],
  },

  // Turn 38: Tool usage detail
  {
    prompt: "When using Airtable, always filter by the 'Active' status column first, otherwise you'll see archived projects.",
    expectedPath: "followup",
    expectedStore: [
      { type: "instruction", contentMatch: "Airtable" },
    ],
    expectedNoStore: [],
  },

  // Turn 39: Acknowledgment with NO new info — should NOT store
  {
    prompt: "Right, I remember now.",
    expectedPath: "followup",
    expectedStore: [],
    expectedNoStore: ["remember"],
  },

  // Turn 40: Request for action — should NOT store
  {
    prompt: "Can you check if Dave submitted the Anderson article yet?",
    expectedPath: "followup",
    expectedStore: [],
    expectedNoStore: ["Anderson"],
  },

  // Turn 41: Financial fact
  {
    prompt: "Our total monthly revenue across all clients is about £18,000.",
    expectedPath: "followup",
    expectedStore: [
      { type: "fact", contentMatch: "18,000" },
    ],
    expectedNoStore: [],
  },

  // Turn 42: Incident / problem event
  {
    prompt: "The WordPress site for Anderson went down for three hours yesterday. Marcus had to call them to apologize.",
    expectedPath: "followup",
    expectedStore: [
      { type: "event", contentMatch: "WordPress" },
    ],
    expectedNoStore: [],
  },

  // Turn 43: Paraphrase of existing info — should NOT store
  {
    prompt: "So basically Sarah reviews everything before it goes live?",
    expectedPath: "followup",
    expectedStore: [],
    expectedNoStore: ["Sarah"],
  },

  // Turn 44: Conditional rule
  {
    prompt: "If a writer's Originality score drops below 70%, they get a formal warning.",
    expectedPath: "followup",
    expectedStore: [
      { type: "instruction", contentMatch: "70%" },
    ],
    expectedNoStore: [],
  },

  // Turn 45: Vague musing — should NOT store
  {
    prompt: "I need to think about what to do with the Anderson account.",
    expectedPath: "followup",
    expectedStore: [],
    expectedNoStore: ["Anderson"],
  },
];

// ── Helpers ─────────────────────────────────────────────────────────

function getNodeCount(): number {
  const db = new Database(WORK_DB, { readonly: true });
  const row = db.query("SELECT COUNT(*) as c FROM nodes").get() as { c: number };
  db.close();
  return row.c;
}

function getAllNodeIds(): string[] {
  const db = new Database(WORK_DB, { readonly: true });
  const rows = db.query("SELECT id FROM nodes").all() as { id: string }[];
  db.close();
  return rows.map(r => r.id);
}

function getNewNodes(knownIds: Set<string>): Array<{ id: string; node_type: string; subtype: string; content: string; scope: number | null }> {
  const db = new Database(WORK_DB, { readonly: true });
  const allRows = db.query("SELECT id, node_type, subtype, content, scope FROM nodes ORDER BY created_at DESC").all() as any[];
  db.close();
  return allRows.filter(r => !knownIds.has(r.id));
}

// ── Per-turn runner ─────────────────────────────────────────────────

async function runTurn(
  turn: TestTurn,
  knownIds: Set<string>
): Promise<{
  path: "full" | "followup" | "followup-fallback";
  newNodes: Array<{ id: string; node_type: string; subtype: string; content: string; scope: number | null }>;
  context: string;
  totalMs: number;
}> {
  const startMs = Date.now();
  resetUsage();

  const prompt = turn.prompt;

  // ── Replicate on-prompt.ts routing logic ──
  const state = readConversationState();
  const hasRecentState = !!state;

  let context = "";
  let path: "full" | "followup" | "followup-fallback" = "full";
  let entityNames: string[] = [];

  if (hasRecentState) {
    const result = await followUpPipeline(db, prompt, state!.turns);

    if (result) {
      path = "followup";
      context = result.context;
      entityNames = result.turns
        .filter(t => t.tool_call.name === "search_entity")
        .flatMap(t => {
          const name = t.tool_call.arguments.name as string;
          return name ? [name] : [];
        });

      const newTurn: ConversationTurn = { prompt, entities: entityNames, timestamp: Date.now() };
      writeConversationState([...state!.turns, newTurn]);
    } else {
      path = "followup-fallback";
    }
  }

  if (path === "full" || path === "followup-fallback") {
    const l1c = await classify(prompt);
    const l1 = l1c.result;

    const hasStorableContent =
      l1.implied_facts.length > 0 ||
      l1.events.length > 0 ||
      l1.opinions.length > 0 ||
      l1.intents.includes("instruction");

    if (l1.operations.retrieve || hasStorableContent) {
      const result = await agenticLoop(db, prompt, l1);
      context = result.curatedContext || result.context;
    }

    entityNames = l1.entities.map(e => e.name);
    const prevTurns = state?.turns ?? [];
    writeConversationState([...prevTurns, { prompt, entities: entityNames, timestamp: Date.now() }]);
  }

  const totalMs = Date.now() - startMs;
  const newNodes = getNewNodes(knownIds);

  return { path, newNodes, context, totalMs };
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const onlyArg = args.find(a => a.startsWith("--only"));
  const onlyTurns = onlyArg
    ? (onlyArg.includes("=") ? onlyArg.split("=")[1] : args[args.indexOf(onlyArg) + 1])
        ?.split(",").map(n => parseInt(n.trim())) ?? []
    : [];

  console.log(`\n${"═".repeat(80)}`);
  console.log(`  CONVERSATION FOLLOW-UP PIPELINE TEST — ${CONVERSATION.length} TURNS`);
  console.log(`  Source DB: ${NOISY_DB}`);
  console.log(`  Working copy: ${WORK_DB}`);
  console.log(`  Active DB_PATH: ${DB_PATH}`);
  console.log(`${"═".repeat(80)}`);

  // Verify DB_PATH landed correctly
  if (DB_PATH !== WORK_DB) {
    console.error(`\nERROR: DB_PATH mismatch. Expected ${WORK_DB}, got ${DB_PATH}`);
    console.error(`The env var must be set before memory modules are imported.`);
    process.exit(1);
  }

  // Clean slate: remove conversation state
  try { unlinkSync(CONVERSATION_STATE_PATH); } catch {}

  const initialCount = getNodeCount();
  const knownIds = new Set(getAllNodeIds());
  console.log(`\nStarting nodes: ${initialCount}`);
  console.log(`Conversation state: cleared\n`);

  let totalPassed = 0;
  let totalFailed = 0;
  let totalMs = 0;

  interface TurnResult {
    turn: number;
    prompt: string;
    expectedPath: string;
    actualPath: string;
    pathMatch: boolean;
    storeResults: { expected: string; found: boolean; actual?: string }[];
    noStoreResults: { keyword: string; violated: boolean; actual?: string }[];
    newNodeCount: number;
    ms: number;
  }
  const results: TurnResult[] = [];

  for (let i = 0; i < CONVERSATION.length; i++) {
    const turnNum = i + 1;

    if (onlyTurns.length > 0 && !onlyTurns.includes(turnNum)) {
      // Write state for skipped turns to maintain conversation flow
      const state = readConversationState();
      const prevTurns = state?.turns ?? [];
      writeConversationState([...prevTurns, {
        prompt: CONVERSATION[i].prompt,
        entities: [],
        timestamp: Date.now(),
      }]);
      continue;
    }

    const turn = CONVERSATION[i];
    console.log(`── Turn ${turnNum} [expect: ${turn.expectedPath.toUpperCase()}] ──────────────────────────────`);
    console.log(`  "${turn.prompt}"`);

    const result = await runTurn(turn, knownIds);
    totalMs += result.totalMs;

    // Add new nodes to known set for next turn
    for (const n of result.newNodes) {
      knownIds.add(n.id);
    }

    // ── Check path ──
    const pathMatch = turn.expectedPath === "full"
      ? result.path === "full"
      : (result.path === "followup" || result.path === "followup-fallback");

    // ── Check expected storage ──
    const storeResults: TurnResult["storeResults"] = [];
    for (const expected of turn.expectedStore) {
      const match = result.newNodes.find(n =>
        n.node_type === expected.type &&
        n.content.toLowerCase().includes(expected.contentMatch.toLowerCase())
      );
      storeResults.push({
        expected: `[${expected.type}] containing "${expected.contentMatch}"`,
        found: !!match,
        actual: match?.content?.slice(0, 100),
      });
    }

    // ── Check no-store ──
    const noStoreResults: TurnResult["noStoreResults"] = [];
    for (const keyword of turn.expectedNoStore) {
      const violation = result.newNodes.find(n =>
        n.content.toLowerCase().includes(keyword.toLowerCase())
      );
      noStoreResults.push({
        keyword,
        violated: !!violation,
        actual: violation?.content?.slice(0, 100),
      });
    }

    // ── Print ──
    console.log(`  Path:    ${pathMatch ? "PASS" : "FAIL"} — expected ${turn.expectedPath}, got ${result.path}`);

    if (result.newNodes.length > 0) {
      console.log(`  Stored:  ${result.newNodes.length} new node(s):`);
      for (const n of result.newNodes) {
        const scopeStr = n.scope != null ? ` scope=${n.scope}` : "";
        console.log(`           [${n.node_type}/${n.subtype || "?"}${scopeStr}] "${n.content.slice(0, 120)}"`);
      }
    } else {
      console.log(`  Stored:  (nothing)`);
    }

    let turnPassed = pathMatch;
    for (const sr of storeResults) {
      console.log(`  Expect:  ${sr.found ? "PASS" : "FAIL"} — ${sr.expected}${sr.found ? ` → "${sr.actual}"` : " — NOT FOUND"}`);
      if (!sr.found) turnPassed = false;
    }
    for (const nr of noStoreResults) {
      console.log(`  NoStore: ${nr.violated ? "FAIL" : "PASS"} — "${nr.keyword}" should not be stored${nr.violated ? ` → "${nr.actual}"` : ""}`);
      if (nr.violated) turnPassed = false;
    }

    const usage = getUsage();
    const costs = calculateCosts("openai/gpt-oss-120b", "openai/gpt-oss-120b", "voyage-4", usage);
    console.log(`  Time:    ${(result.totalMs / 1000).toFixed(1)}s | Cost: $${costs.total_cost.toFixed(4)} | Context: ${result.context.length} chars`);
    console.log(`  ${turnPassed ? "PASS" : "FAIL"}`);
    console.log();

    if (turnPassed) totalPassed++;
    else totalFailed++;

    results.push({
      turn: turnNum,
      prompt: turn.prompt.slice(0, 60),
      expectedPath: turn.expectedPath,
      actualPath: result.path,
      pathMatch,
      storeResults,
      noStoreResults,
      newNodeCount: result.newNodes.length,
      ms: result.totalMs,
    });
  }

  // ── Summary ──
  const finalCount = getNodeCount();
  console.log(`${"═".repeat(80)}`);
  console.log(`  SUMMARY`);
  console.log(`${"═".repeat(80)}`);
  console.log();
  console.log(`  Turns run:     ${results.length}`);
  console.log(`  Passed:        ${totalPassed}`);
  console.log(`  Failed:        ${totalFailed}`);
  console.log(`  Nodes:         ${initialCount} → ${finalCount} (+${finalCount - initialCount})`);
  console.log(`  Total time:    ${(totalMs / 1000).toFixed(1)}s`);
  console.log();

  console.log(`  Turn  Path Expected  Path Actual       Nodes  Time`);
  console.log(`  ────  ─────────────  ────────────────  ─────  ────`);
  for (const r of results) {
    const pathFlag = r.pathMatch ? " " : "!";
    const storeFlag = r.storeResults.every(s => s.found) && r.noStoreResults.every(n => !n.violated) ? " " : "!";
    console.log(`  ${String(r.turn).padStart(4)}  ${r.expectedPath.padEnd(13)}  ${r.actualPath.padEnd(16)} ${pathFlag}${storeFlag}${String(r.newNodeCount).padStart(4)}  ${(r.ms / 1000).toFixed(1)}s`);
  }

  if (totalFailed > 0) {
    console.log(`\n  FAILURES:`);
    for (const r of results) {
      const failures: string[] = [];
      if (!r.pathMatch) failures.push(`path: expected ${r.expectedPath}, got ${r.actualPath}`);
      for (const sr of r.storeResults) {
        if (!sr.found) failures.push(`missing: ${sr.expected}`);
      }
      for (const nr of r.noStoreResults) {
        if (nr.violated) failures.push(`unwanted store: "${nr.keyword}" → "${nr.actual}"`);
      }
      if (failures.length > 0) {
        console.log(`    Turn ${r.turn}: ${failures.join("; ")}`);
      }
    }
  }

  // Clean up working copy
  try { unlinkSync(WORK_DB); } catch {}
  try { unlinkSync(WORK_DB + "-wal"); } catch {}
  try { unlinkSync(WORK_DB + "-shm"); } catch {}

  console.log(`\n${"═".repeat(80)}\n`);
  process.exit(totalFailed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`Test error: ${err.message}\n${err.stack}`);
  process.exit(1);
});
