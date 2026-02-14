import { LAYER2_MODEL, MAX_LAYER2_TURNS, LAYER2_TIMEOUT_MS, CONVERSATION_STATE_PATH } from "./config";
import { callWorkersAI } from "./workers-ai";
import { RETRIEVE_TOOLS, STORE_TOOLS, handleToolCall } from "./tools";
import { getNode, getRelationships, getInstructions, getGlobalInstructions, promotePlanToEvent, getDb, supersedeNode } from "./db";
import { embed } from "./voyage";
import { searchSimilar, storeEmbedding } from "./vectors";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import type { ChatMessage, Layer1Result, ToolTurn, MemoryNode, ToolDefinition, StoreItem, ConversationState, ConversationTurn, FollowUpResult } from "./types";

// ── Layer 1.5: Search Strategy Reasoning ────────────────────────────

const REASONING_PROMPT = `You are a memory retrieval strategist. Given a user query, assess what kind of answer is needed, then output a minimal search plan.

First, assess the query complexity:
- SIMPLE FACT: "How much revenue?", "What do we charge?" → one search_facts call is likely enough
- ENTITY LOOKUP: "Who is Peter?", "Tell me about Anderson" → search_entity + get_relationships
- RULE/PROCESS: "How do I publish?", "What are the rules?" → search_processes or get_instructions, may need 2-3 results
- MULTI-PART: "Dave submitted an article, what tools does Sarah need?" → need to connect multiple pieces

Think like a human: what's the most direct path to the answer?
- "How much revenue?" → search facts for "revenue". That's it.
- "What are the rules for content?" → search instructions for "content rules". Might need multiple.
- "Who is Peter?" → look up Peter, get his relationships.

Your available search tools are:
- search_entity(name): Find a specific named person, org, project, or tool
- get_relationships(entity_id): Follow connections from an entity
- search_facts(query, entity_id?): Semantic search for facts (broad or scoped to entity)
- search_events(query, entity_id?, days?): Semantic search for events
- search_plans(query, entity_id?): Semantic search for upcoming plans and scheduled items
- search_processes(query, entity_id?): Find procedures and how-to guides
- get_instructions(topic, entity_id?): Find rules, policies, and behavioral instructions

Output:
1. Complexity assessment (one line: SIMPLE FACT / ENTITY LOOKUP / RULE/PROCESS / MULTI-PART)
2. What the user actually needs (one sentence)
3. Starting search (1-2 steps). The agent will decide if more searches are needed based on results.`;

async function planRetrieval(
  prompt: string,
  layer1Result: Layer1Result
): Promise<string> {
  const userContent = `Query: "${prompt}"
Entities mentioned: ${layer1Result.entities.map(e => `${e.name} (${e.type})`).join(", ") || "none"}
Concepts: ${layer1Result.concepts.join(", ") || "none"}
Intents: ${layer1Result.intents.join(", ")}

How should I search the memory graph for this? Think about what associations a human would make, then give me a search plan.`;

  const response = await callWorkersAI(LAYER2_MODEL, [
    { role: "system", content: REASONING_PROMPT },
    { role: "user", content: userContent },
  ], {
    max_tokens: 512,
    temperature: 0.2,
    tag: "l1",  // Track under L1 costs (lightweight call)
  });

  return response.content || "";
}

// ── Layer 1.5: Storage Filter ────────────────────────────────────────

const STORAGE_FILTER_PROMPT = `You are a memory storage gatekeeper. Given a user's message and extracted information, decide what is genuinely worth storing as a permanent memory.

STORE when the user is TELLING you something new:
- Teaching/instructing: "Remember, our process is...", "The way to do X is...", "From now on always..."
- Concrete facts with specific details: "Peter handles the Anderson account", "We pay £4,000/month"
- Real events that actually happened: "Peter finished the Anderson article yesterday", "Sarah flagged two articles Monday"
- Future plans with specific dates: "Anderson delivery due next Friday", "Dave going on holiday March 3rd"
- Corrections to existing knowledge: "Actually, Lisa handles that now, not Sarah"
- Specific opinions: "I think Peter's work quality has improved this quarter"
- Workflows/processes: "When a new client signs up, first we create an Airtable entry..."

DO NOT STORE:
- Questions about existing knowledge: "Who handles Anderson?" — they are ASKING, not TELLING
- Hypothetical scenarios from questions: "When peter finishes..." in "When peter finishes, who checks?" — NOT a real event
- Greetings/small talk: "How are you", "Thanks", "Good morning"
- Common sense or tautologies: "Articles need reviewing", "Writers write articles"
- Vague/generic statements: "Peter finishes articles" — that's just his job, not new info
- Information the user is querying, not asserting: "Does Sarah review articles?" — they want to KNOW

KEY TEST: Is the user TELLING you something new, or ASKING about something they expect you to already know?

When in doubt, do NOT store. It is far better to miss a minor detail than to pollute memory with noise.

For instructions/rules: use type "instruction". Set scope to indicate how broadly it applies:
  - scope 1.0 = applies to all content/clients universally (e.g. "Always check Originality.ai")
  - scope 0.5 = applies to a tool or team-wide procedure (e.g. "Airtable lookup process")
  - scope 0.2 = applies to a specific entity/client (e.g. "Brightwell needs ContentShake")
  - Default: 0.5
  - For instructions: do NOT set salience — they surface by relevance + scope.
For step-by-step procedures: use type "instruction", subtype "tool_usage".
For corrections: include the corrected version as the content.
For future plans: use type "plan". Subtypes: "scheduled" (confirmed date), "intended" (planned but no firm date), "requested" (asked for).
  - MUST include valid_from as ISO date (YYYY-MM-DD) — the scheduled/target date.
  - Set salience higher (1.5-2.0) for critical deadlines, lower (0.5-0.8) for routine.
For facts/events: set salience 1.5-2.0 for critical info (lost clients, major deadlines), 0.5-0.8 for routine.

Output valid JSON only. No markdown fences. No explanation.
{
  "store_items": [
    { "content": "exact text to store", "type": "fact|event|opinion|instruction|plan", "subtype": "definitional|rule|tool_usage|action|incident|user_opinion|scheduled|intended|requested", "reason": "brief reason", "valid_from": "YYYY-MM-DD (plans only)", "scope": 0.5, "salience": 1.0 }
  ],
  "skip_reason": "what was filtered out and why, or 'nothing to filter'"
}

If NOTHING is worth storing, return empty store_items with a skip_reason.`;

export interface StoreFilterResult {
  storeItems: StoreItem[];
  skipReason: string;
  duration_ms: number;
  raw: string;
}

export async function filterForStorage(
  prompt: string,
  layer1Result: Layer1Result,
  extractedInstructions?: ExtractedInstruction[]
): Promise<StoreFilterResult> {
  const start = Date.now();

  const extracted: string[] = [];
  for (const f of layer1Result.implied_facts) extracted.push(`Fact: ${f}`);
  for (const e of layer1Result.events) extracted.push(`Event: ${e}`);
  for (const p of layer1Result.plans) extracted.push(`Plan: ${p}`);
  for (const o of layer1Result.opinions) extracted.push(`Opinion: ${o}`);
  if (layer1Result.intents.includes("instruction")) {
    extracted.push(`Instruction (user's exact words): "${prompt}"`);
  }

  // Fast path: nothing to evaluate
  if (extracted.length === 0) {
    return { storeItems: [], skipReason: "nothing extracted to evaluate", duration_ms: 0, raw: "" };
  }

  const alreadyHandled = extractedInstructions?.length
    ? `\nAlready stored as instructions (do NOT reclassify or duplicate these — they are handled):\n${extractedInstructions.map(ei => `- "${ei.content}" → instruction/${ei.subtype}`).join("\n")}\n`
    : "";

  const userContent = `User message: "${prompt}"

Extracted by classifier:
Entities: ${layer1Result.entities.map(e => `${e.name} (${e.type})`).join(", ") || "none"}
Items:
${extracted.map(s => `- ${s}`).join("\n")}
Intents: ${layer1Result.intents.join(", ")}
${alreadyHandled}
What from this is genuinely worth storing as a permanent memory?`;

  const response = await callWorkersAI(LAYER2_MODEL, [
    { role: "system", content: STORAGE_FILTER_PROMPT },
    { role: "user", content: userContent },
  ], {
    max_tokens: 16384,
    temperature: 0.1,
    tag: "l1",
  });

  const duration_ms = Date.now() - start;

  try {
    const cleaned = response.content
      .replace(/```json\n?/g, "")
      .replace(/```\n?/g, "")
      .trim();
    const parsed = JSON.parse(cleaned);
    return {
      storeItems: Array.isArray(parsed.store_items) ? parsed.store_items : [],
      skipReason: parsed.skip_reason || "",
      duration_ms,
      raw: response.content,
    };
  } catch {
    console.error(`[layer1.5-store] Parse failed: ${response.content.slice(0, 200)}`);
    return { storeItems: [], skipReason: "parse error — skipping storage to be safe", duration_ms, raw: response.content };
  }
}

// ── Layer 1.5: Instruction Extraction ────────────────────────────────

const INSTRUCTION_EXTRACT_PROMPT = `You are an instruction extraction specialist. Your ONLY job is to identify instructions, rules, procedures, and prescriptive statements in the user's message.

An INSTRUCTION is anything that tells someone HOW things should be done, WHO should do what, WHAT tools to use, or WHEN/WHERE something applies. It is prescriptive — it governs future behavior.

INSTRUCTION PATTERNS:

1. PROCESS / PROCEDURE — steps, workflows, pipelines
   "Orders go through three rounds of QA" → instruction/process
   "Request → review → approve → ship" → instruction/process
   "When onboarding a new customer, first create their account" → instruction/process

2. TOOL USAGE — what a tool is FOR, where things are stored, how to access something
   "We track all orders in the project board" → instruction/tool_usage
   "Credentials are in the shared password manager" → instruction/tool_usage
   "We use X for reporting and Y for monitoring" → instruction/tool_usage

3. ROLE ASSIGNMENT / ROUTING — who handles what, who to contact for what
   "Alex handles all billing disputes" → instruction/rule
   "Go to Jamie for any backend questions" → instruction/rule
   "Only the team lead should approve deployments" → instruction/rule

4. THRESHOLD / CONSTRAINT — numeric limits, quality bars, capacity caps
   "Quality scores must be 80+ before release" → instruction/rule
   "Maximum 2 free revisions, then we bill" → instruction/rule
   "Don't assign more than 5 tickets per sprint" → instruction/rule

5. EXCEPTION / OVERRIDE — entity-specific deviations from the norm
   "We bill Acme quarterly, not monthly like the others" → instruction/rule
   "Enterprise clients need legal review on every contract" → instruction/rule

6. PREFERENCE AS RULE — "I prefer", "let's make sure", "going forward"
   "I prefer we don't ship on Fridays" → instruction/rule
   "Going forward, every PR needs two reviewers" → instruction/rule
   "Let's make sure all reports include a summary" → instruction/rule

7. CORRECTION TO A RULE — updates a threshold, schedule, or assignment
   "Actually, the minimum is 80 now, not 75" → instruction/rule
   "They want fortnightly delivery, not weekly" → instruction/rule
   "He shouldn't have admin access anymore after the incident" → instruction/rule

8. BAN / NEGATIVE CONSTRAINT — things that must NOT be done
   "Don't use that tool for customer data" → instruction/rule
   "We stopped offering that service" → instruction/rule
   "Never deploy without running the test suite" → instruction/rule

NOT AN INSTRUCTION (leave for other classifiers):
- Pure pricing/revenue: "They pay £4,000/month" → FACT
- Past events: "He missed the deadline Friday" → EVENT
- Opinions without prescriptive force: "I think his work improved" → OPINION
- Future plans with dates: "Delivery due next Friday" → PLAN
- Questions: "Who handles billing?" → QUERY

KEY TEST: Does this statement prescribe how things SHOULD work, or just describe how things ARE?
When in doubt: if it assigns responsibility, sets a threshold, or describes a workflow → INSTRUCTION.

Set scope:
  - 1.0 = universal (applies across the board)
  - 0.5 = team/tool-wide
  - 0.2 = specific to one entity
Set subtype: "rule", "tool_usage", or "process"

Output valid JSON only. No markdown fences.
{
  "instructions": [
    { "content": "exact text from the user's message", "subtype": "rule|tool_usage|process", "scope": 0.5, "reason": "brief" }
  ]
}

If NO instructions found, return: { "instructions": [] }`;

interface ExtractedInstruction {
  content: string;
  subtype: string;
  scope: number;
}

export interface InstructionExtractResult {
  instructions: ExtractedInstruction[];
  duration_ms: number;
  raw: string;
}

export async function extractInstructions(
  prompt: string,
): Promise<InstructionExtractResult> {
  const start = Date.now();

  const response = await callWorkersAI(LAYER2_MODEL, [
    { role: "system", content: INSTRUCTION_EXTRACT_PROMPT },
    { role: "user", content: `User message: "${prompt}"\n\nExtract any instructions, rules, or procedures from this message.` },
  ], {
    max_tokens: 16384,
    temperature: 0.1,
    tag: "l1",
  });

  const duration_ms = Date.now() - start;

  try {
    const cleaned = response.content
      .replace(/```json\n?/g, "")
      .replace(/```\n?/g, "")
      .trim();
    const parsed = JSON.parse(cleaned);
    const instructions: ExtractedInstruction[] = (parsed.instructions ?? []).map((item: any) => ({
      content: item.content,
      subtype: item.subtype || "rule",
      scope: item.scope ?? 0.5,
    }));
    return { instructions, duration_ms, raw: response.content };
  } catch {
    console.error(`[instruction-extract] Parse failed: ${response.content.slice(0, 200)}`);
    return { instructions: [], duration_ms, raw: response.content };
  }
}

// ── Context Curation (Method B: text-based) ──────────────────────────

const CURATION_PROMPT = `You are a context curator for a personal assistant chatbot. Given a user's query and retrieved memory records, output ONLY the information needed to answer the query.

Your output will be injected as context for a chatbot. The chatbot needs enough information to give a complete, accurate answer.

RULES:
- Copy relevant record content VERBATIM from the input. Do NOT summarize, rephrase, or shorten.
- Preserve exact names, numbers, prices, dates, and details word-for-word.
- Include entity descriptions when they help answer the query (who someone is, their role).
- Include relevant relationships (who works with whom, who manages what).
- For comparison queries ("Is X faster than Y?", "Who is better?"): include details for ALL entities being compared.
- For "what tools" / "what steps" queries: include ALL relevant tools and steps, not just the first one.
- Omit entire records that don't help answer the query.
- Do NOT add information not present in the records.
- Do NOT add commentary, headers, or explanations.
- Output the relevant content directly, preserving the original formatting.
- If NOTHING in the records is relevant to the query, output exactly: NO_RELEVANT_RECORDS`;

async function curateSection(
  prompt: string,
  sectionLabel: string,
  sectionContent: string
): Promise<string> {
  if (!sectionContent) return "";

  const msgs = [
    { role: "system" as const, content: CURATION_PROMPT },
    { role: "user" as const, content: `Query: "${prompt}"\n\n${sectionLabel}:\n${sectionContent}` },
  ];
  const opts = { max_tokens: 2048, temperature: 0.1, tag: "curate" as const };

  // Empty response retry + Sonnet fallback is handled by callWorkersAI
  const raw = (await callWorkersAI(LAYER2_MODEL, msgs, opts)).content || "";

  if (raw === "NO_RELEVANT_RECORDS") return "";
  return raw;
}

async function curateContext(
  prompt: string,
  sections: ContextSections
): Promise<{ curated: string; duration_ms: number }> {
  const flat = flattenSections(sections);
  if (!flat) return { curated: "", duration_ms: 0 };

  const start = Date.now();

  // Run per-section curation in parallel — each section gets focused attention
  const [entities, instructions, facts, events, plans] = await Promise.all([
    curateSection(prompt, "People & things", sections.entities),
    curateSection(prompt, "Instructions & rules", sections.instructions),
    curateSection(prompt, "Facts", sections.facts),
    curateSection(prompt, "Events", sections.events),
    curateSection(prompt, "Upcoming plans", sections.plans),
  ]);

  const duration_ms = Date.now() - start;
  const parts = [entities, instructions, facts, events, plans].filter(Boolean);
  const curated = parts.join("\n\n");

  return { curated, duration_ms };
}

// ── Retrieval pipeline ──────────────────────────────────────────────

const RETRIEVE_PROMPT = `You are a memory retrieval agent. Search the memory graph to answer the user's query. You have a search plan as a starting point, but YOU decide when you have enough.

After EVERY search result, evaluate:
1. Does this fully answer the question with specific details? → call "done"
2. Did I get a vague/high-level result that references something more specific? → search for the specific thing
3. Am I clearly missing something the user asked about? → search for that specific gap
4. Would more searching actually help, or just add noise?

Key principle: STOP WHEN YOU HAVE A COMPLETE ANSWER, NOT JUST A PARTIAL ONE.
- "How much revenue?" → search_facts("revenue"), found £12,600 → specific answer → done.
- "How do I pull a SEO report?" → found "Pull GSC data on the 1st" which is a HIGH-LEVEL REFERENCE, not the actual how-to. Search deeper: search_processes("GSC report steps") or search_processes("Google Search Console") → found the detailed steps → done.
- "What are the rules for content?" → found Originality + Surfer rules → check for more → done.
- "Tell me about Dave" → search_entity, get_relationships → done.

CRITICAL: For "how do I" questions, a result that just says "do X" without explaining HOW is not a complete answer. If a result says "Pull GSC data" or "run through Surfer", that's a REFERENCE — search for the actual tool procedure (e.g. search_processes("Google Search Console") or search_processes("Surfer SEO check")).

After each search, say what you found and what's still missing before deciding your next action.

DO NOT:
- Search for entities just because they're mentioned in results (don't expand every name you see)
- Follow the plan mechanically if you already have the answer
- Keep searching "just in case" — extra results add noise that hurts accuracy

The system collects everything your tools return automatically. Call "done" when finished.
Max ${MAX_LAYER2_TURNS} rounds, but most queries need only 1-3.`;

export async function retrieveLoop(
  prompt: string,
  layer1Result: Layer1Result
): Promise<{ context: string; curatedContext: string; turns: ToolTurn[]; searchPlan: string; timing: { plan_ms: number; search_ms: number; curate_ms: number } }> {
  const turns: ToolTurn[] = [];

  // Layer 1.5: Reason about search strategy before executing
  const planStart = Date.now();
  const searchPlan = await planRetrieval(prompt, layer1Result);
  const plan_ms = Date.now() - planStart;

  const userContent = `User prompt: "${prompt}"

Search plan from strategist:
${searchPlan}

Execute this search plan. Call "done" when you have finished searching.`;

  const searchStart = Date.now();
  await runToolLoop(
    RETRIEVE_PROMPT,
    userContent,
    RETRIEVE_TOOLS,
    turns,
    MAX_LAYER2_TURNS,
    LAYER2_TIMEOUT_MS
  );
  const search_ms = Date.now() - searchStart;

  // ── Deterministic safety nets ──
  // Smart retrieval supplements: find the RIGHT things L2 might have missed.
  // assembleContext dedupes by node ID, Method B curation filters noise.

  const fmt = (n: MemoryNode, score: number) =>
    `[${n.node_type}${n.subtype ? "/" + n.subtype : ""}] ${n.content} (id: ${n.id}, salience: ${n.salience}) [score: ${score.toFixed(3)}]`;

  const queryVec = (await embed([prompt], "query"))[0];
  if (queryVec) {
    // #1: Pre-fetch instructions — pure embedding search for instruction nodes
    // Fetch extra results then dedupe near-identical content (bulk templates flood the top-N)
    const instrHits = searchSimilar(queryVec, MAX_INSTRUCTIONS * 10, { nodeType: "instruction" });
    if (instrHits.length > 0) {
      const seen = new Map<string, number>(); // template key → count
      const deduped: Array<{ nodeId: string; score: number; node: MemoryNode }> = [];
      for (const h of instrHits) {
        const node = getNode(h.nodeId);
        if (!node) continue;
        // Detect near-identical templates: strip capitalized words (entity names) then compare structure
        const templateKey = node.content
          .split(/\s+/)
          .map(w => /^[A-Z]/.test(w) ? "_" : w.toLowerCase())
          .slice(0, 15)
          .join(" ")
          .replace(/_(\s_)*/g, "_"); // collapse consecutive placeholders
        const count = seen.get(templateKey) ?? 0;
        if (count >= 2) continue; // allow max 2 of the same template pattern
        seen.set(templateKey, count + 1);
        deduped.push({ ...h, node });
        if (deduped.length >= MAX_INSTRUCTIONS) break;
      }
      const lines = deduped.map(d => fmt(d.node, d.score));
      if (lines.length > 0) {
        turns.push({
          tool_call: { name: "get_instructions", arguments: { topic: prompt } },
          result: { name: "get_instructions", result: lines.join("\n") },
        });
      }
    }

    // #2: Embedding fallback — broad cosine search across all node types
    const broadHits = searchSimilar(queryVec, 20);
    if (broadHits.length > 0) {
      const lines = broadHits.map(h => {
        const node = getNode(h.nodeId);
        return node ? fmt(node, h.score) : null;
      }).filter(Boolean);
      if (lines.length > 0) {
        turns.push({
          tool_call: { name: "broad_search", arguments: { query: prompt } },
          result: { name: "broad_search", result: lines.join("\n") },
        });
      }
    }

    // #3: High-scope auto-inject — global instructions (scope >= 0.8) with lowered cosine bar
    // These get a score floor of 0.6 so they compete with bulk noise in assembleContext sorting
    const globalInstructions = getGlobalInstructions();
    if (globalInstructions.length > 0) {
      const globalIds = globalInstructions.map(n => n.id);
      const hits = searchSimilar(queryVec, globalIds.length, { nodeIds: globalIds });
      const relevant = hits.filter(h => h.score > 0.15);
      if (relevant.length > 0) {
        const lines = relevant.map(h => {
          const node = getNode(h.nodeId);
          const boostedScore = Math.max(h.score, 0.6); // floor: compete with bulk
          return node ? fmt(node, boostedScore) : null;
        }).filter(Boolean);
        if (lines.length > 0) {
          turns.push({
            tool_call: { name: "get_instructions", arguments: { topic: "__global_scope__" } },
            result: { name: "get_instructions", result: lines.join("\n") },
          });
        }
      }
    }
  }

  // Greedy assembly — gather everything L2 found + safety net results
  const sections = assembleContext(turns);
  const context = flattenSections(sections);

  // Per-section curation: Method B on each type in parallel
  const curation = await curateContext(prompt, sections);
  const curate_ms = curation.duration_ms;

  return { context, curatedContext: curation.curated, turns, searchPlan, timing: { plan_ms, search_ms, curate_ms } };
}

// ── Storage pipeline ────────────────────────────────────────────────

const STORE_PROMPT = `You are a memory storage agent. Store new information into the memory graph.

Steps:
1. Call search_entity for each mentioned entity to get their IDs (for linking)
2. If an entity is NEW (search returns nothing), create it first with store_memory type="entity"
3. Call store_memory for each new piece of information (facts, events, opinions, instructions)
4. For corrections: call search_facts to find the old memory, then supersede_memory
5. For updates/transfers (e.g. "Jeff now handles X instead of Sarah"): store the new fact and use related_ids to link it to the old fact. This creates a "see_also" trail so related memories can be found together.
6. Call "done" when finished

RULES:
- ONLY store facts that are SPECIFIC and contain concrete details (names, roles, numbers, dates, relationships).
- SKIP vague, obvious, or common-sense statements. "Peter will finish his article" is NOT worth storing. "Peter handles Anderson's cloud infrastructure articles" IS.
- Do NOT spend more than 2 calls on searching. Store is the priority.
- For NEW entities (people, clients, tools, orgs): create an entity node FIRST, then store facts about it linked to that entity.
- PRESERVE exact numbers, prices, quantities, and dates in stored content. Do not paraphrase or decompose these values.
- Store the user's original wording when it contains specific figures (e.g. "£2,500", "10 articles per month").
- For opinions: use type="opinion" and include the user's exact wording.
- For instructions: set scope to indicate breadth. 1.0 = universal, 0.5 = tool/team-wide, 0.2 = entity-specific. Default: 0.5. Do NOT set salience for instructions.
- For plans: use type="plan" with valid_from as ISO date (YYYY-MM-DD). Subtypes: "scheduled", "intended", "requested".
- Do NOT store duplicate information — if the fact is already in the search results, skip it.
- You have a maximum of ${MAX_LAYER2_TURNS} tool calls.`;

export async function storeLoop(
  prompt: string,
  layer1Result: Layer1Result,
  filteredItems?: StoreItem[]
): Promise<{ turns: ToolTurn[] }> {
  const turns: ToolTurn[] = [];

  const toStore: string[] = [];
  if (filteredItems && filteredItems.length > 0) {
    for (const item of filteredItems) {
      const label = item.type.charAt(0).toUpperCase() + item.type.slice(1);
      toStore.push(`${label}${item.subtype ? ` (${item.subtype})` : ""}: ${item.content}`);
    }
  } else {
    // Fallback: no filter provided (backward compat)
    for (const f of layer1Result.implied_facts) toStore.push(`Fact: ${f}`);
    for (const e of layer1Result.events) toStore.push(`Event: ${e}`);
    for (const p of layer1Result.plans) toStore.push(`Plan: ${p}`);
    for (const o of layer1Result.opinions) toStore.push(`Opinion: ${o}`);
    if (layer1Result.intents.includes("instruction")) {
      toStore.push(`Instruction: ${prompt}`);
    }
  }

  if (toStore.length === 0) return { turns };

  const userContent = `User said: "${prompt}"

Entities to link: ${JSON.stringify(layer1Result.entities)}
Verified information to store:
${toStore.map((s) => `- ${s}`).join("\n")}

Search for the entities to get their IDs, then store each piece of information using store_memory. Call "done" when finished.`;

  await runToolLoop(
    STORE_PROMPT,
    userContent,
    STORE_TOOLS,
    turns,
    MAX_LAYER2_TURNS,
    LAYER2_TIMEOUT_MS
  );

  // Safety net: if the model didn't store anything, force-store
  const didStore = turns.some(
    (t) => t.tool_call.name === "store_memory" || t.tool_call.name === "supersede_memory"
  );
  if (!didStore && toStore.length > 0) {
    await forceStore(prompt, layer1Result, turns, filteredItems);
  }

  return { turns };
}

// ── Post-storage reconciliation ─────────────────────────────────────

const RECONCILE_PROMPT = `You are checking whether a newly stored instruction contradicts any existing instructions.

New instruction: "{content}"

Existing instructions:
{candidates}

For each existing instruction, classify the relationship:
- NO_CONFLICT: Different topics, compatible rules, or clearly additive
- SUPERSEDES: The new instruction explicitly replaces this one. Look for language like "taking over from", "instead of", "now handles", "replacing", "no longer", "switched to", "actually X not Y"
- CONTRADICTION: Same topic with conflicting rules, but NO explicit replacement language. The user may intend both to coexist, or may have forgotten the old one.

IMPORTANT: Only mark SUPERSEDES when the new instruction has clear replacement language. If in doubt, mark CONTRADICTION — it's better to ask than to silently delete.

Output valid JSON only:
{ "results": [ { "id": "node_id", "verdict": "NO_CONFLICT|SUPERSEDES|CONTRADICTION", "reason": "brief" } ], "question": "If any CONTRADICTION: a natural question to ask the user. null if none." }`;

interface ReconciliationResult {
  superseded: { oldId: string; newId: string; reason: string }[];
  contradictions: { newContent: string; oldContent: string; oldId: string; question: string }[];
}

async function reconcileMemories(newNodeIds: string[]): Promise<ReconciliationResult> {
  const result: ReconciliationResult = { superseded: [], contradictions: [] };

  for (const nodeId of newNodeIds) {
    const node = getNode(nodeId);
    if (!node) continue;

    // Search existing instructions for potential conflicts
    const vec = (await embed([node.content], "query"))[0];
    const hits = searchSimilar(vec, 10, { nodeType: "instruction" });

    // Filter out self and low-similarity results
    const candidates = hits
      .filter(h => h.nodeId !== nodeId && h.score >= 0.45)
      .map(h => ({ ...h, node: getNode(h.nodeId) }))
      .filter(h => h.node != null && !h.node.superseded_by);

    if (candidates.length === 0) continue;

    // Build the prompt from template
    const candidateList = candidates
      .map((c, i) => `${i + 1}. "${c.node!.content}" (id: ${c.node!.id})`)
      .join("\n");
    const filledPrompt = RECONCILE_PROMPT
      .replace("{content}", node.content)
      .replace("{candidates}", candidateList);

    const response = await callWorkersAI(LAYER2_MODEL, [
      { role: "system", content: filledPrompt },
      { role: "user", content: "Classify each existing memory." },
    ], {
      max_tokens: 16384,
      temperature: 0.1,
      tag: "reconcile",
    });

    // Parse LLM response
    let parsed: { results: { id: string; verdict: string; reason: string }[]; question: string | null };
    try {
      const cleaned = response.content
        .replace(/```json\n?/g, "")
        .replace(/```\n?/g, "")
        .trim();
      parsed = JSON.parse(cleaned);
    } catch {
      console.error(`[reconcile] Parse failed for node ${nodeId}: ${response.content.slice(0, 200)}`);
      continue;
    }

    if (!Array.isArray(parsed.results)) continue;

    for (const r of parsed.results) {
      if (r.verdict === "SUPERSEDES") {
        const oldNode = getNode(r.id);
        if (!oldNode || oldNode.superseded_by) continue;

        // Supersede: mark old as superseded, create replacement with new content
        const replacementId = supersedeNode(r.id, node.content);
        // Re-embed the replacement node
        const newVec = (await embed([node.content]))[0];
        storeEmbedding(replacementId, node.node_type, newVec);

        result.superseded.push({ oldId: r.id, newId: replacementId, reason: r.reason });
      } else if (r.verdict === "CONTRADICTION") {
        const oldNode = getNode(r.id);
        if (!oldNode || oldNode.superseded_by) continue;

        result.contradictions.push({
          newContent: node.content,
          oldContent: oldNode.content,
          oldId: r.id,
          question: parsed.question || `"${node.content}" may conflict with "${oldNode.content}". Which is correct?`,
        });
      }
    }
  }

  return result;
}

// ── Public entry point ──────────────────────────────────────────────

export interface AgenticResult {
  context: string;
  curatedContext: string;
  turns: ToolTurn[];
  searchPlan?: string;
  storeFilter?: StoreFilterResult;
  timing?: { plan_ms: number; search_ms: number; curate_ms?: number; filter_ms?: number; store_ms?: number; reconcile_ms?: number };
  contradictions?: { newContent: string; oldContent: string; oldId: string; question: string }[];
}

export async function agenticLoop(
  prompt: string,
  layer1Result: Layer1Result
): Promise<AgenticResult> {
  const allTurns: ToolTurn[] = [];
  let context = "";
  let curatedContext = "";
  let searchPlan: string | undefined;
  let storeFilter: StoreFilterResult | undefined;
  let timing: AgenticResult["timing"];

  const shouldRetrieve = layer1Result.operations.retrieve;
  const hasStorableContent =
    layer1Result.operations.store ||
    layer1Result.implied_facts.length > 0 ||
    layer1Result.events.length > 0 ||
    layer1Result.plans.length > 0 ||
    layer1Result.opinions.length > 0 ||
    layer1Result.intents.includes("instruction");

  // Run retrieve in parallel with store pipeline.
  // Store pipeline: instruction extractor FIRST → informed store filter → storeLoop
  const retrievePromise = shouldRetrieve
    ? retrieveLoop(prompt, layer1Result)
    : Promise.resolve(null);

  const storePromise = hasStorableContent
    ? (async () => {
        // Step 1: Instruction extractor runs first — it's the instruction expert
        const instrResult = await extractInstructions(prompt);

        // Step 2: Store filter runs next, informed about what's already handled
        const filterResult = await filterForStorage(prompt, layer1Result, instrResult.instructions);
        storeFilter = filterResult;

        // Step 3: Combine — extractor's instructions + filter's non-instruction items
        const instructionItems: StoreItem[] = instrResult.instructions.map(ei => ({
          content: ei.content,
          type: "instruction",
          subtype: ei.subtype,
          scope: ei.scope,
        }));
        // Safety: strip any instruction-typed items the filter produced despite being told not to
        const filterNonInstructions = filterResult.storeItems.filter(item => item.type !== "instruction");
        const allItems = [...instructionItems, ...filterNonInstructions];

        if (allItems.length === 0) {
          return { turns: [] as ToolTurn[], store_ms: 0 };
        }
        const storeStart = Date.now();
        const storeResult = await storeLoop(prompt, layer1Result, allItems);
        return { ...storeResult, store_ms: Date.now() - storeStart };
      })()
    : Promise.resolve(null);

  const [retrieveResult, storeResult] = await Promise.all([retrievePromise, storePromise]);

  if (retrieveResult) {
    context = retrieveResult.context;
    curatedContext = retrieveResult.curatedContext;
    searchPlan = retrieveResult.searchPlan;
    timing = {
      ...retrieveResult.timing,
      filter_ms: storeFilter?.duration_ms,
      store_ms: storeResult?.store_ms,
    };
    allTurns.push(...retrieveResult.turns.map((t) => ({ ...t, _pipeline: "retrieve" as const })));
  } else {
    timing = {
      plan_ms: 0,
      search_ms: 0,
      curate_ms: 0,
      filter_ms: storeFilter?.duration_ms,
      store_ms: storeResult?.store_ms,
    };
  }

  if (storeResult?.turns && storeResult.turns.length > 0) {
    allTurns.push(...storeResult.turns.map((t) => ({ ...t, _pipeline: "store" as const })));
  }

  // ── Post-storage reconciliation (instructions only) ──
  // Facts are additive and allowed to coexist; instructions are prescriptive and must not conflict.
  let contradictions: AgenticResult["contradictions"];
  if (storeResult?.turns && storeResult.turns.length > 0) {
    const newNodeIds: string[] = [];
    for (const turn of storeResult.turns) {
      if (turn.tool_call.name === "store_memory") {
        const resultStr = turn.result.result as string;
        // Only reconcile instructions — facts are allowed to contradict
        const match = resultStr.match(/^Stored memory ([a-f0-9-]+) \(instruction\//);
        if (match) newNodeIds.push(match[1]);
      }
    }
    if (newNodeIds.length > 0) {
      const reconcileStart = Date.now();
      const reconciliation = await reconcileMemories(newNodeIds);
      const reconcile_ms = Date.now() - reconcileStart;
      if (timing) timing.reconcile_ms = reconcile_ms;

      // Record supersessions in turns for trace visibility
      for (const s of reconciliation.superseded) {
        allTurns.push({
          tool_call: { name: "supersede_memory", arguments: { old_id: s.oldId, reason: s.reason } },
          result: { name: "supersede_memory", result: `Reconciliation: superseded ${s.oldId} → ${s.newId}` },
          _pipeline: "reconcile",
        });
      }

      if (reconciliation.contradictions.length > 0) {
        contradictions = reconciliation.contradictions;
      }
    }
  }

  return { context, curatedContext, turns: allTurns, searchPlan, storeFilter, timing, contradictions };
}

// ── Conversation state management ────────────────────────────────────

const MAX_TURNS_KEPT = 5;

export function readConversationState(): ConversationState | null {
  try {
    const raw = readFileSync(CONVERSATION_STATE_PATH, "utf-8");
    const state = JSON.parse(raw) as ConversationState;
    if (!Array.isArray(state.turns) || state.turns.length === 0) return null;
    return state;
  } catch {
    return null;
  }
}

export function writeConversationState(turns: ConversationTurn[]): void {
  const capped = turns.slice(-MAX_TURNS_KEPT);
  const state: ConversationState = { turns: capped };
  try {
    mkdirSync(dirname(CONVERSATION_STATE_PATH), { recursive: true });
    writeFileSync(CONVERSATION_STATE_PATH, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error(`[state] Failed to write conversation state: ${(err as Error).message}`);
  }
}

// ── Follow-up pipeline ──────────────────────────────────────────────

const FOLLOWUP_PROMPT = `You are a memory conversation analyzer. Given recent conversation turns and a new user message, determine what NEW information to retrieve from memory and what to store.

1. RESOLVE pronouns/references using conversation context.
   Example: previous message about "Dave" → "him" in new message = Dave

2. RETRIEVE: What NEW information should be fetched from memory?
   Only information NOT already covered in previous turns.
   Return specific search calls to make. Available tools:
   - search_entity: { "name": "..." } — find a person/org/tool by name
   - search_facts: { "query": "...", "entity_id?": "..." } — semantic search for facts
   - search_events: { "query": "...", "entity_id?": "...", "days?": N } — search events
   - search_processes: { "query": "..." } — find procedures/how-tos
   - get_instructions: { "topic": "...", "entity_id?": "..." } — find rules/policies
   - search_plans: { "query": "...", "entity_id?": "..." } — find upcoming plans

3. STORE: Does the new message contain information worth storing?
   New facts, instructions, corrections, events — only if TELLING, not asking.
   If the user is asking a question, storage_needed should be false.
   You do NOT decide what to store — just flag whether storage is warranted.

4. REWRITE: If storage_needed is true AND the message contains pronouns/references,
   produce "resolved_prompt" — the user's message rewritten with pronouns replaced by actual names.
   Example: "She handles the finances" → "Lisa handles the finances"
   Keep the original wording otherwise. If no pronouns to resolve, set resolved_prompt to the original message.

Output valid JSON only. No markdown fences. No explanation.
{
  "resolved_entities": [{"name": "...", "type": "person|org|tool|project|concept"}],
  "retrieval_needed": true/false,
  "retrieve_calls": [
    {"tool": "search_events", "args": {"query": "...", "entity_id": "..."}}
  ],
  "storage_needed": true/false,
  "resolved_prompt": "message with pronouns replaced (only when storage_needed=true)",
  "reasoning": "one line explaining what's new vs already known"
}`;

interface FollowUpAnalysis {
  resolved_entities: { name: string; type: string }[];
  retrieval_needed: boolean;
  retrieve_calls: { tool: string; args: Record<string, unknown> }[];
  storage_needed: boolean;
  resolved_prompt?: string;
  reasoning: string;
}

export async function followUpPipeline(
  prompt: string,
  previousTurns: ConversationTurn[]
): Promise<FollowUpResult | null> {
  const analysisStart = Date.now();

  // Format conversation history for the LLM
  const turnLines = previousTurns.map(t =>
    `User: "${t.prompt}" [entities: ${t.entities.join(", ") || "none"}]`
  ).join("\n");

  const userContent = `Recent conversation:\n${turnLines}\n\nNew message: "${prompt}"\n\nWhat NEW information should be retrieved or stored?`;

  let analysis: FollowUpAnalysis;
  try {
    const response = await callWorkersAI(LAYER2_MODEL, [
      { role: "system", content: FOLLOWUP_PROMPT },
      { role: "user", content: userContent },
    ], {
      max_tokens: 1024,
      temperature: 0.1,
      tag: "l1",
    });

    const cleaned = response.content
      .replace(/```json\n?/g, "")
      .replace(/```\n?/g, "")
      .trim();
    analysis = JSON.parse(cleaned);

    if (!analysis || typeof analysis.retrieval_needed !== "boolean") {
      console.error(`[followup] Invalid analysis structure, falling back`);
      return null;
    }
  } catch (err) {
    console.error(`[followup] Analysis LLM call failed: ${(err as Error).message}`);
    return null;
  }

  const analysis_ms = Date.now() - analysisStart;
  const turns: ToolTurn[] = [];

  // Always search_entity first for every resolved entity — this is the graph foundation.
  // The LLM's retrieve_calls are supplementary (facts, events, etc.), not the primary lookup.
  const searchStart = Date.now();
  const entitySearched = new Set<string>();

  if (analysis.resolved_entities?.length > 0) {
    for (const entity of analysis.resolved_entities) {
      const name = entity.name?.trim();
      if (!name || entitySearched.has(name.toLowerCase())) continue;
      entitySearched.add(name.toLowerCase());
      try {
        const result = await handleToolCall("search_entity", { name });
        turns.push({
          tool_call: { name: "search_entity", arguments: { name } },
          result: { name: "search_entity", result },
          _pipeline: "retrieve",
        });
      } catch (err) {
        console.error(`[followup] search_entity(${name}) failed: ${(err as Error).message}`);
      }
    }
  }

  // Execute any additional LLM-chosen retrieve calls (skip search_entity since we already did those)
  if (analysis.retrieval_needed && analysis.retrieve_calls?.length > 0) {
    for (const call of analysis.retrieve_calls) {
      const toolName = call.tool;
      if (toolName === "search_entity" && entitySearched.has(((call.args?.name as string) || "").toLowerCase())) continue;
      const args = call.args || {};
      try {
        const result = await handleToolCall(toolName, args);
        turns.push({
          tool_call: { name: toolName, arguments: args },
          result: { name: toolName, result },
          _pipeline: "retrieve",
        });
      } catch (err) {
        console.error(`[followup] Tool ${toolName} failed: ${(err as Error).message}`);
      }
    }
  }
  // Broadening fallback: check what node types were covered by the searches above.
  // For any uncovered types, run a broad embedding search so we never miss relevant data
  // stored under a different type than the LLM guessed (e.g. plan vs event).
  const typesCovered = new Set<string>();
  for (const turn of turns) {
    const tool = turn.tool_call.name;
    if (tool === "search_entity") { typesCovered.add("entity"); }
    else if (tool === "search_facts") { typesCovered.add("fact"); typesCovered.add("opinion"); }
    else if (tool === "search_events") { typesCovered.add("event"); typesCovered.add("plan"); }
    else if (tool === "search_plans") { typesCovered.add("plan"); typesCovered.add("event"); }
    else if (tool === "search_processes" || tool === "get_instructions") { typesCovered.add("instruction"); }
  }
  const allTypes = ["entity", "fact", "opinion", "event", "plan", "instruction"];
  const uncoveredTypes = allTypes.filter(t => !typesCovered.has(t));

  if (uncoveredTypes.length > 0 && turns.length > 0) {
    const queryText = analysis.resolved_prompt || prompt;
    const queryVec = (await embed([queryText], "query"))[0];
    // Scale result count with number of uncovered types (5 per type, min 10)
    const broadCount = Math.max(10, uncoveredTypes.length * 5);
    const broadResults = searchSimilar(queryVec, broadCount, { nodeTypes: uncoveredTypes });
    const MIN_SCORE = 0.25;
    const relevant = broadResults.filter(r => r.score >= MIN_SCORE);
    if (relevant.length > 0) {
      const nodes = relevant
        .map(r => ({ ...r, node: getNode(r.nodeId) }))
        .filter(r => r.node != null);
      if (nodes.length > 0) {
        const broadText = nodes
          .map(r => `[${r.node!.node_type}${r.node!.subtype ? "/" + r.node!.subtype : ""}] ${r.node!.content} (id: ${r.node!.id}, salience: ${r.node!.salience}) [score: ${r.score.toFixed(3)}]`)
          .join("\n");
        turns.push({
          tool_call: { name: "broad_search", arguments: { types: uncoveredTypes, query: queryText } },
          result: { name: "broad_search", result: broadText },
          _pipeline: "retrieve",
        });
      }
    }
  }

  const search_ms = Date.now() - searchStart;

  // Compact assembly — no curation needed, results are already focused
  const contextParts: string[] = [];
  for (const turn of turns) {
    const result = turn.result.result as string;
    if (!result || result.startsWith("No ") || result.startsWith("Unknown")) continue;
    contextParts.push(result);
  }
  const context = contextParts.join("\n\n");

  // Handle storage via the same instruction extractor → storage filter → storeLoop chain
  // as the full pipeline. The follow-up LLM only flags *whether* to store, not *what*.
  // Use resolved_prompt (pronouns replaced) so the extraction chain sees "Lisa handles..."
  // instead of "She handles..." — the follow-up LLM already did the resolution.
  let store_ms: number | undefined;
  const allStoreItems: StoreItem[] = [];
  if (analysis.storage_needed) {
    const storeStart = Date.now();
    const storePrompt = analysis.resolved_prompt || prompt;

    // Build a minimal Layer1Result for the storage chain
    const minimalL1: Layer1Result = {
      entities: analysis.resolved_entities.map(e => ({
        name: e.name,
        type: e.type as Layer1Result["entities"][0]["type"],
        ambiguous: false,
      })),
      implied_facts: [storePrompt], // pass resolved prompt so filter can evaluate it
      events: [],
      plans: [],
      opinions: [],
      concepts: [],
      implied_processes: [],
      intents: [],
      operations: { retrieve: false, store: true },
    };

    // Step 1: Instruction extractor — on pronoun-resolved prompt
    const instrResult = await extractInstructions(storePrompt);

    // Step 2: Storage filter — validates what's worth storing
    const filterResult = await filterForStorage(storePrompt, minimalL1, instrResult.instructions);

    // Step 3: Combine — extractor's instructions + filter's non-instruction items
    const instructionItems: StoreItem[] = instrResult.instructions.map(ei => ({
      content: ei.content,
      type: "instruction",
      subtype: ei.subtype,
      scope: ei.scope,
    }));
    const filterNonInstructions = filterResult.storeItems.filter(item => item.type !== "instruction");
    const combinedItems = [...instructionItems, ...filterNonInstructions];

    if (combinedItems.length > 0) {
      allStoreItems.push(...combinedItems);
      await storeLoop(storePrompt, minimalL1, combinedItems);
    }

    store_ms = Date.now() - storeStart;
  }

  return {
    context,
    turns,
    storeItems: allStoreItems,
    reasoning: analysis.reasoning || "",
    timing: { analysis_ms, search_ms, store_ms },
  };
}

// ── Shared tool loop engine ─────────────────────────────────────────

async function runToolLoop(
  systemPrompt: string,
  userContent: string,
  tools: ToolDefinition[],
  turns: ToolTurn[],
  maxTurns: number,
  timeoutMs: number
): Promise<{ doneContext: string | null }> {
  const startTime = Date.now();
  const MAX_CONSECUTIVE_ERRORS = 3;
  let consecutiveErrors = 0;

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userContent },
  ];

  for (let turn = 0; turn < maxTurns; turn++) {
    if (Date.now() - startTime > timeoutMs) {
      return { doneContext: null };
    }

    const response = await callWorkersAI(LAYER2_MODEL, messages, {
      tools,
      max_tokens: 2048,
      temperature: 0.1,
      tag: "l2",
    });

    if (!response.tool_calls?.length) {
      // Model stopped calling tools without ever searching — nudge it to use tools
      if (turn === 0 && turns.length === 0) {
        messages.push(
          { role: "assistant", content: response.content || "" },
          { role: "user", content: "You MUST use the search tools to find information in the memory graph. Do not answer from your own knowledge. Start by calling search_entity or get_instructions." },
        );
        continue;
      }
      // Model stopped after using tools — return its text if any
      return { doneContext: response.content || null };
    }

    // Capture L2's reasoning text (response.content before tool calls)
    const reasoning = response.content || "";

    for (const tc of response.tool_calls) {
      let args: Record<string, unknown>;
      try {
        args =
          typeof tc.function.arguments === "string"
            ? JSON.parse(tc.function.arguments)
            : (tc.function.arguments as unknown as Record<string, unknown>);
      } catch (e) {
        const errorMsg = `Error: Invalid JSON in tool arguments. Please retry with valid JSON.`;
        consecutiveErrors++;
        turns.push({
          tool_call: { name: tc.function.name, arguments: {} },
          result: { name: tc.function.name, result: errorMsg },
          reasoning,
        });
        messages.push({
          role: "assistant",
          content: "",
          tool_calls: [tc],
        });
        messages.push({
          role: "tool",
          content: errorMsg,
          tool_call_id: tc.id,
        });
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          console.error(`[layer2] ${MAX_CONSECUTIVE_ERRORS} consecutive errors — ending loop`);
          return { doneContext: null };
        }
        continue;
      }

      const toolName = tc.function.name;

      if (toolName === "done") {
        turns.push({
          tool_call: { name: toolName, arguments: args },
          result: { name: toolName, result: "" },
          reasoning,
        });
        return { doneContext: "" };
      }

      let result: string;
      try {
        result = await handleToolCall(toolName, args);
      } catch (err) {
        result = `Error: ${(err as Error).message}`;
      }

      // Track consecutive errors
      if (result.startsWith("Error:")) {
        consecutiveErrors++;
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          console.error(`[layer2] ${MAX_CONSECUTIVE_ERRORS} consecutive errors — ending loop`);
          turns.push({
            tool_call: { name: toolName, arguments: args },
            result: { name: toolName, result },
            reasoning,
          });
          return { doneContext: null };
        }
      } else {
        consecutiveErrors = 0;
      }

      turns.push({
        tool_call: { name: toolName, arguments: args },
        result: { name: toolName, result },
        reasoning,
      });

      messages.push({
        role: "assistant",
        content: "",
        tool_calls: [tc],
      });

      // Truncate large tool results to prevent context window overflow at scale
      const MAX_RESULT_CHARS = 4000;
      const truncatedResult = result.length > MAX_RESULT_CHARS
        ? result.slice(0, MAX_RESULT_CHARS) + `\n... (truncated, ${result.length} chars total)`
        : result;

      messages.push({
        role: "tool",
        content: truncatedResult,
        tool_call_id: tc.id,
      });
    }
  }

  return { doneContext: null };
}

// ── Force-store safety net ──────────────────────────────────────────

async function forceStore(
  prompt: string,
  layer1Result: Layer1Result,
  turns: ToolTurn[],
  filteredItems?: StoreItem[]
): Promise<void> {
  // Collect entity IDs + names found during search
  const foundEntities: Array<{ id: string; name: string }> = [];
  for (const turn of turns) {
    if (turn.tool_call.name === "search_entity") {
      const result = turn.result.result as string;
      for (const line of result.split("\n")) {
        const idMatch = line.match(/\(id:\s*([a-f0-9-]+)/);
        if (!idMatch) continue;
        const nameMatch = line.match(/\]\s*(.+?)\s*\(id:/);
        if (nameMatch) {
          foundEntities.push({ id: idMatch[1], name: nameMatch[1].trim() });
        }
      }
    }
  }

  const toStore: Array<{ type: string; subtype: string; content: string; salience: number; scope?: number; valid_from?: string }> = [];

  if (filteredItems && filteredItems.length > 0) {
    // Items already vetted by storage filter — store them directly
    const subtypeDefaults: Record<string, string> = {
      fact: "definitional", event: "action", opinion: "user_opinion", instruction: "rule", plan: "scheduled",
    };
    const salienceDefaults: Record<string, number> = {
      fact: 1.0, event: 0.8, opinion: 0.6, instruction: 1.0, plan: 1.0,
    };
    for (const item of filteredItems) {
      toStore.push({
        type: item.type,
        subtype: item.subtype || subtypeDefaults[item.type] || "definitional",
        content: item.content,
        salience: item.salience ?? salienceDefaults[item.type] ?? 1.0,
        scope: item.scope,
        valid_from: item.valid_from,
      });
    }
  } else {
    // Legacy fallback (no filter)
    for (const fact of layer1Result.implied_facts) {
      toStore.push({ type: "fact", subtype: "definitional", content: fact, salience: 1.0 });
    }
    for (const event of layer1Result.events) {
      toStore.push({ type: "event", subtype: "action", content: event, salience: 0.8 });
    }
    for (const plan of layer1Result.plans) {
      toStore.push({ type: "plan", subtype: "scheduled", content: plan, salience: 1.0 });
    }
    for (const opinion of layer1Result.opinions) {
      toStore.push({ type: "opinion", subtype: "user_opinion", content: opinion, salience: 0.6 });
    }
    if (layer1Result.intents.includes("instruction")) {
      toStore.push({ type: "instruction", subtype: "rule", content: prompt, salience: 1.0 });
    }
  }

  for (const item of toStore) {
    // Match: only link entities whose name appears in the item content
    const contentLower = item.content.toLowerCase();
    const matchedIds = foundEntities
      .filter(e => contentLower.includes(e.name.toLowerCase()))
      .map(e => e.id);

    const args: Record<string, unknown> = {
      type: item.type,
      subtype: item.subtype,
      content: item.content,
      entity_ids: matchedIds,
      salience: item.salience,
      source: "user",
    };
    if (item.type === "instruction") {
      args.scope = item.scope ?? 0.5;
    } else if (item.type === "plan") {
      args.scope = item.scope ?? 0.3;
      if (item.valid_from) args.valid_from = item.valid_from;
    } else if (item.scope != null) {
      args.scope = item.scope;
    }
    const result = await handleToolCall("store_memory", args);
    turns.push({
      tool_call: { name: "store_memory", arguments: args },
      result: { name: "store_memory", result },
    });
  }
}

// ── Structured context assembly ──────────────────────────────────────

// Per-type limits — generous since per-section curation filters downstream
const MAX_ENTITIES = 15;
const MAX_RELS_PER_ENTITY = 8;
const MAX_FACTS = 30;
const MAX_INSTRUCTIONS = 15;
const MAX_EVENTS = 15;
const MAX_PLANS = 10;

interface ContextSections {
  entities: string;
  instructions: string;
  facts: string;
  events: string;
  plans: string;
}

function assembleContext(turns: ToolTurn[]): ContextSections {
  const nodeScores = new Map<string, number>();

  for (const turn of turns) {
    if (["done", "store_memory", "supersede_memory"].includes(turn.tool_call.name)) continue;
    const result = turn.result.result as string;
    if (!result || result.startsWith("No ") || result.startsWith("Unknown")) continue;

    for (const line of result.split("\n")) {
      const idMatch = line.match(/\(id:\s*([a-f0-9-]+)/);
      if (!idMatch) continue;
      const id = idMatch[1];

      const scoreMatch = line.match(/\[score:\s*([\d.]+)\]/);
      const score = scoreMatch ? parseFloat(scoreMatch[1]) : 0.5;

      const existing = nodeScores.get(id) ?? 0;
      if (score > existing) nodeScores.set(id, score);
    }
  }

  const empty: ContextSections = { entities: "", instructions: "", facts: "", events: "", plans: "" };
  if (nodeScores.size === 0) return empty;

  interface RankedNode { node: MemoryNode; score: number }
  const ranked: RankedNode[] = [];

  for (const [id, score] of nodeScores) {
    const node = getNode(id);
    if (!node || node.superseded_by) continue;
    // score is pure cosine (no salience/scope boost in searchSimilar)
    ranked.push({ node, score });
  }

  ranked.sort((a, b) => b.score - a.score);

  const groups: Record<string, RankedNode[]> = {
    entity: [], fact: [], event: [], opinion: [], instruction: [], plan: [],
  };
  for (const r of ranked) {
    const bucket = groups[r.node.node_type] ?? [];
    bucket.push(r);
    groups[r.node.node_type] = bucket;
  }

  // Collect node IDs that appear in non-entity sections to avoid duplicating
  // them as "about" relationships on entities (facts/events/instructions/plans
  // already get their own sections).
  const nonEntityNodeIds = new Set<string>();
  for (const [type, items] of Object.entries(groups)) {
    if (type === "entity") continue;
    for (const { node: n } of items) nonEntityNodeIds.add(n.id);
  }

  // Entities with relationships (skip edges to nodes that appear in other sections)
  let entitiesText = "";
  if (groups.entity.length > 0) {
    const lines: string[] = [];
    for (const { node } of groups.entity.slice(0, MAX_ENTITIES)) {
      lines.push(`${node.content}`);
      const rels = getRelationships(node.id);
      const topRels = rels
        .filter((r) => !nonEntityNodeIds.has(r.target.id))
        .sort((a, b) => (b.target.salience ?? 1) - (a.target.salience ?? 1))
        .slice(0, MAX_RELS_PER_ENTITY);
      for (const rel of topRels) {
        lines.push(`  - ${rel.edge.edge_type}: ${rel.target.content}`);
      }
    }
    entitiesText = lines.join("\n");
  }

  // Instructions (now a primary node type)
  // Sort by cosine score (relevance to query) first, scope as tiebreaker.
  // This ensures query-relevant instructions beat generic global ones.
  const instrGroup = groups.instruction ?? [];
  instrGroup.sort((a, b) => {
    const scoreDiff = b.score - a.score;
    if (Math.abs(scoreDiff) > 0.05) return scoreDiff; // meaningful score difference → use score
    return (b.node.scope ?? 0.5) - (a.node.scope ?? 0.5); // tiebreaker: scope
  });
  const allInstructions = instrGroup.slice(0, MAX_INSTRUCTIONS);
  const instructionsText = allInstructions.map((r) => `- ${r.node.content}`).join("\n");

  // Facts + opinions
  const allFacts = [...(groups.fact ?? []), ...(groups.opinion ?? [])].slice(0, MAX_FACTS);
  const factsText = allFacts.map((r) => `- ${r.node.content}`).join("\n");

  // Plan auto-promotion: plans whose valid_from has passed become events
  const promotedAnnotations = new Map<string, string>(); // nodeId → annotation
  for (let i = groups.plan.length - 1; i >= 0; i--) {
    const planNode = groups.plan[i].node;
    if (planNode.valid_from) {
      const validFrom = new Date(planNode.valid_from);
      if (validFrom <= new Date()) {
        const promoted = promotePlanToEvent(planNode.id);
        if (promoted) {
          promotedAnnotations.set(promoted.id, `[Was scheduled for ${planNode.valid_from} — now past] `);
          groups.event.push({ node: promoted, score: groups.plan[i].score });
          groups.plan.splice(i, 1);
        }
      }
    }
  }

  // Events (including promoted plans)
  const eventsText = groups.event.slice(0, MAX_EVENTS).map((r) => {
    const annotation = promotedAnnotations.get(r.node.id) ?? "";
    return `- ${annotation}${r.node.content}`;
  }).join("\n");

  // Plans (upcoming, sorted by valid_from ascending — soonest first)
  const plansSorted = groups.plan.slice(0, MAX_PLANS).sort((a, b) => {
    const aDate = a.node.valid_from ?? "";
    const bDate = b.node.valid_from ?? "";
    return aDate.localeCompare(bDate);
  });
  const plansText = plansSorted.map((r) => {
    const dateTag = r.node.valid_from ? ` [scheduled: ${r.node.valid_from}]` : "";
    return `- ${r.node.content}${dateTag}`;
  }).join("\n");

  return { entities: entitiesText, instructions: instructionsText, facts: factsText, events: eventsText, plans: plansText };
}

/** Flatten sections into a single string (for debug/logging) */
function flattenSections(sections: ContextSections): string {
  const parts: string[] = [];
  if (sections.entities) parts.push("People & things:\n" + sections.entities);
  if (sections.instructions) parts.push("Instructions:\n" + sections.instructions);
  if (sections.facts) parts.push("Facts:\n" + sections.facts);
  if (sections.events) parts.push("Events:\n" + sections.events);
  if (sections.plans) parts.push("Upcoming plans:\n" + sections.plans);
  return parts.join("\n\n");
}
