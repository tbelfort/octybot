import { LAYER2_MODEL, MAX_LAYER2_TURNS, LAYER2_TIMEOUT_MS } from "./config";
import { callWorkersAI } from "./workers-ai";
import { RETRIEVE_TOOLS, STORE_TOOLS, handleToolCall } from "./tools";
import { getNode, getRelationships, getInstructions } from "./db";
import type { ChatMessage, Layer1Result, ToolTurn, MemoryNode, ToolDefinition } from "./types";

// ── Layer 1.5: Search Strategy Reasoning ────────────────────────────

const REASONING_PROMPT = `You are a memory retrieval strategist. Given a user query, think about how a human would naturally recall this information, then output a search plan.

Think like a human remembering:
- What associations does this query trigger?
- Is the user asking about a specific person/thing, or about a general concept/rule/process?
- "Writer misses a deadline" → think "deadline policy" not "look up Peter"
- "Who is Peter?" → think "Peter, the person" → look him up directly
- "How do I publish an article?" → think "publishing process" → search for procedures

Your available search tools are:
- search_entity(name): Find a specific named person, org, project, or tool
- get_relationships(entity_id): Follow connections from an entity
- search_facts(query, entity_id?): Semantic search for facts (broad or scoped to entity)
- search_events(query, entity_id?, days?): Semantic search for events
- search_processes(query): Find procedures and how-to guides
- get_instructions(topic): Find rules, policies, and behavioral instructions

Output a short reasoning chain (2-4 sentences), then a numbered search plan (1-5 steps). Be specific about what to search for and why.`;

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

// ── Retrieval pipeline ──────────────────────────────────────────────

const RETRIEVE_PROMPT = `You are a memory retrieval agent. You have a search plan from a strategist — follow it to search the memory graph.

Your ONLY job is to find relevant memories using the search tools. The system automatically collects everything your tools return — you do NOT need to assemble or summarize anything.

Guidelines:
- Follow the search plan's reasoning about what to look for and how
- If a search returns nothing useful, adapt — try broader searches or different tools
- Call "done" when you have finished searching (no arguments needed)
- Be efficient — max ${MAX_LAYER2_TURNS} tool calls`;

export async function retrieveLoop(
  prompt: string,
  layer1Result: Layer1Result
): Promise<{ context: string; turns: ToolTurn[]; searchPlan: string; timing: { plan_ms: number; search_ms: number } }> {
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

  // Always assemble context deterministically from collected tool results.
  // L2's job is finding memories, not interpreting or summarizing them.
  return { context: assembleContext(turns), turns, searchPlan, timing: { plan_ms, search_ms } };
}

// ── Storage pipeline ────────────────────────────────────────────────

const STORE_PROMPT = `You are a memory storage agent. Store new information into the memory graph.

Steps:
1. Call search_entity for each mentioned entity to get their IDs (for linking)
2. If an entity is NEW (search returns nothing), create it first with store_memory type="entity"
3. Call store_memory for each new piece of information (facts, events, opinions)
4. For corrections: call search_facts to find the old memory, then supersede_memory
5. Call "done" when finished

RULES:
- You MUST call store_memory at least once. That is your entire purpose.
- Do NOT spend more than 2 calls on searching. Store is the priority.
- For NEW entities (people, clients, tools, orgs): create an entity node FIRST, then store facts about it linked to that entity.
- PRESERVE exact numbers, prices, quantities, and dates in stored content. Do not paraphrase or decompose these values.
- Store the user's original wording when it contains specific figures (e.g. "£2,500", "10 articles per month").
- For opinions: use type="opinion" and include the user's exact wording.
- You have a maximum of ${MAX_LAYER2_TURNS} tool calls.`;

export async function storeLoop(
  prompt: string,
  layer1Result: Layer1Result
): Promise<{ turns: ToolTurn[] }> {
  const turns: ToolTurn[] = [];

  const toStore: string[] = [];
  for (const f of layer1Result.implied_facts) toStore.push(`Fact: ${f}`);
  for (const e of layer1Result.events) toStore.push(`Event: ${e}`);
  for (const o of layer1Result.opinions) toStore.push(`Opinion: ${o}`);
  if (layer1Result.intents.includes("instruction")) {
    toStore.push(`Instruction: ${prompt}`);
  }

  const userContent = `User said: "${prompt}"

Entities to link: ${JSON.stringify(layer1Result.entities)}
New information to store:
${toStore.map((s) => `- ${s}`).join("\n")}

Search for the entities to get their IDs, then store each piece of information using store_memory. Call "done" when finished.`;

  const result = await runToolLoop(
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
    await forceStore(prompt, layer1Result, turns);
  }

  return { turns };
}

// ── Public entry point ──────────────────────────────────────────────

export interface AgenticResult {
  context: string;
  turns: ToolTurn[];
  searchPlan?: string;
  timing?: { plan_ms: number; search_ms: number; store_ms?: number };
}

export async function agenticLoop(
  prompt: string,
  layer1Result: Layer1Result
): Promise<AgenticResult> {
  // Override: if Layer 1 extracted storable content but didn't set store=true, fix it
  if (!layer1Result.operations.store && (
    layer1Result.events.length > 0 ||
    layer1Result.opinions.length > 0 ||
    layer1Result.intents.includes("instruction")
  )) {
    layer1Result.operations.store = true;
  }

  const allTurns: ToolTurn[] = [];
  let context = "";
  let searchPlan: string | undefined;
  let timing: AgenticResult["timing"];

  // Run retrieve and store as SEPARATE pipelines
  if (layer1Result.operations.retrieve && layer1Result.operations.store) {
    // Both — run in parallel
    const storeStart = Date.now();
    const [retrieveResult, storeResult] = await Promise.all([
      retrieveLoop(prompt, layer1Result),
      storeLoop(prompt, layer1Result),
    ]);
    const store_ms = Date.now() - storeStart;
    context = retrieveResult.context;
    searchPlan = retrieveResult.searchPlan;
    timing = { ...retrieveResult.timing, store_ms };
    allTurns.push(
      ...retrieveResult.turns.map((t) => ({ ...t, _pipeline: "retrieve" as const })),
      ...storeResult.turns.map((t) => ({ ...t, _pipeline: "store" as const }))
    );
  } else if (layer1Result.operations.retrieve) {
    const result = await retrieveLoop(prompt, layer1Result);
    context = result.context;
    searchPlan = result.searchPlan;
    timing = result.timing;
    allTurns.push(...result.turns);
  } else if (layer1Result.operations.store) {
    const storeStart = Date.now();
    const result = await storeLoop(prompt, layer1Result);
    timing = { plan_ms: 0, search_ms: 0, store_ms: Date.now() - storeStart };
    allTurns.push(...result.turns);
  }

  return { context, turns: allTurns, searchPlan, timing };
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
  turns: ToolTurn[]
): Promise<void> {
  // Collect entity IDs found during search
  const foundEntityIds: string[] = [];
  for (const turn of turns) {
    if (turn.tool_call.name === "search_entity") {
      const result = turn.result.result as string;
      const ids = [...result.matchAll(/\(id:\s*([a-f0-9-]+)/g)].map((m) => m[1]);
      foundEntityIds.push(...ids);
    }
  }

  const toStore: Array<{ type: string; subtype: string; content: string; salience: number }> = [];

  for (const fact of layer1Result.implied_facts) {
    toStore.push({ type: "fact", subtype: "definitional", content: fact, salience: 1.0 });
  }
  for (const event of layer1Result.events) {
    toStore.push({ type: "event", subtype: "action", content: event, salience: 0.8 });
  }
  for (const opinion of layer1Result.opinions) {
    toStore.push({ type: "opinion", subtype: "user_opinion", content: opinion, salience: 0.6 });
  }
  if (layer1Result.intents.includes("instruction")) {
    toStore.push({ type: "fact", subtype: "instruction", content: prompt, salience: 2.0 });
  }

  for (const item of toStore) {
    const args = {
      type: item.type,
      subtype: item.subtype,
      content: item.content,
      entity_ids: foundEntityIds,
      salience: item.salience,
      source: "user",
    };
    const result = await handleToolCall("store_memory", args);
    turns.push({
      tool_call: { name: "store_memory", arguments: args },
      result: { name: "store_memory", result },
    });
  }
}

// ── Structured fallback context assembly ────────────────────────────

function assembleContext(turns: ToolTurn[]): string {
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

  if (nodeScores.size === 0) return "";

  interface RankedNode { node: MemoryNode; score: number; rank: number }
  const ranked: RankedNode[] = [];

  for (const [id, score] of nodeScores) {
    const node = getNode(id);
    if (!node || node.superseded_by) continue;
    ranked.push({ node, score, rank: node.salience * score });
  }

  ranked.sort((a, b) => b.rank - a.rank);

  const groups: Record<string, RankedNode[]> = {
    entity: [], fact: [], event: [], opinion: [],
  };
  for (const r of ranked) {
    const bucket = groups[r.node.node_type] ?? [];
    bucket.push(r);
    groups[r.node.node_type] = bucket;
  }

  const sections: string[] = [];

  if (groups.entity.length > 0) {
    const lines: string[] = [];
    for (const { node } of groups.entity) {
      lines.push(`${node.content}`);
      const rels = getRelationships(node.id);
      for (const rel of rels) {
        lines.push(`  - ${rel.edge.edge_type}: ${rel.target.content}`);
      }
    }
    sections.push("People & things:\n" + lines.join("\n"));
  }

  const instructions = (groups.fact ?? []).filter(
    (r) => r.node.subtype === "instruction" || r.node.subtype === "tool_usage"
  );
  const opinionInstructions = (groups.opinion ?? []).filter(
    (r) => r.node.subtype === "instruction" || r.node.subtype === "tool_usage"
  );
  const allInstructions = [...instructions, ...opinionInstructions];
  if (allInstructions.length > 0) {
    sections.push(
      "Instructions:\n" + allInstructions.map((r) => `- ${r.node.content}`).join("\n")
    );
  }

  const regularFacts = (groups.fact ?? []).filter(
    (r) => r.node.subtype !== "instruction" && r.node.subtype !== "tool_usage"
  );
  const regularOpinions = (groups.opinion ?? []).filter(
    (r) => r.node.subtype !== "instruction" && r.node.subtype !== "tool_usage"
  );
  const allFacts = [...regularFacts, ...regularOpinions];
  if (allFacts.length > 0) {
    sections.push(
      "Facts:\n" + allFacts.map((r) => `- ${r.node.content}`).join("\n")
    );
  }

  if (groups.event.length > 0) {
    sections.push(
      "Events:\n" + groups.event.map((r) => `- ${r.node.content}`).join("\n")
    );
  }

  return sections.join("\n\n");
}
