/**
 * Storage pipeline: filter → extract instructions → L2 store loop → force-store safety net → reconcile.
 * Extracted from layer2.ts.
 */

import type { Database } from "bun:sqlite";
import { LAYER2_MODEL, MAX_LAYER2_TURNS, LAYER2_TIMEOUT_MS } from "./config";
import { callWorkersAI } from "./workers-ai";
import { STORAGE_FILTER_PROMPT, INSTRUCTION_EXTRACT_PROMPT, STORE_PROMPT, RECONCILE_PROMPT } from "./prompts";
import { SAFETY_NET } from "./constants";
import { STORE_TOOLS } from "./store-tools";
import { runToolLoop } from "./tool-loop";
import { handleStoreToolCall } from "./store-tools";
import { getNode, supersedeNode } from "./db-crud";
import { embed } from "./voyage";
import { searchSimilar, storeEmbedding } from "./vectors";
import type { Layer1Result, ToolTurn, StoreItem } from "./types";
import { logger } from "./logger";

// ── Layer 1.5: Storage Filter ────────────────────────────────────────

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
    logger.error("[layer1.5-store] Parse failed", { raw: response.content.slice(0, 200) });
    return { storeItems: [], skipReason: "parse error — skipping storage to be safe", duration_ms, raw: response.content };
  }
}

// ── Layer 1.5: Instruction Extraction ────────────────────────────────

export interface ExtractedInstruction {
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
    logger.error("[instruction-extract] Parse failed", { raw: response.content.slice(0, 200) });
    return { instructions: [], duration_ms, raw: response.content };
  }
}

// ── Storage pipeline ────────────────────────────────────────────────

export async function storeLoop(
  db: Database,
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
    db,
    STORE_PROMPT,
    userContent,
    STORE_TOOLS,
    turns,
    MAX_LAYER2_TURNS,
    LAYER2_TIMEOUT_MS
  );

  // Safety net: check that all filtered items were actually stored
  if (filteredItems && filteredItems.length > 0) {
    const storedContents = new Set<string>();
    for (const t of turns) {
      if (t.tool_call.name === "store_memory" || t.tool_call.name === "supersede_memory") {
        const content = (t.tool_call.arguments as any).content;
        if (content) storedContents.add(content.toLowerCase().slice(0, 60));
      }
    }
    const missed = filteredItems.filter(item => {
      const key = item.content.toLowerCase().slice(0, 60);
      for (const stored of storedContents) {
        if (stored.includes(key.slice(0, 30)) || key.includes(stored.slice(0, 30))) return false;
      }
      return true;
    });
    if (missed.length > 0) {
      await forceStore(db, prompt, layer1Result, turns, missed);
    }
  } else {
    const didStore = turns.some(
      (t) => t.tool_call.name === "store_memory" || t.tool_call.name === "supersede_memory"
    );
    if (!didStore && toStore.length > 0) {
      await forceStore(db, prompt, layer1Result, turns);
    }
  }

  return { turns };
}

// ── Force-store safety net ──────────────────────────────────────────

async function forceStore(
  db: Database,
  prompt: string,
  layer1Result: Layer1Result,
  turns: ToolTurn[],
  filteredItems?: StoreItem[]
): Promise<void> {
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
    const result = await handleStoreToolCall(db, "store_memory", args);
    turns.push({
      tool_call: { name: "store_memory", arguments: args },
      result: { name: "store_memory", result },
    });
  }
}

// ── Post-storage reconciliation ─────────────────────────────────────

export interface ReconciliationResult {
  superseded: { oldId: string; newId: string; reason: string }[];
  contradictions: { newContent: string; oldContent: string; oldId: string; question: string }[];
}

export async function reconcileMemories(db: Database, newNodeIds: string[]): Promise<ReconciliationResult> {
  const result: ReconciliationResult = { superseded: [], contradictions: [] };

  for (const nodeId of newNodeIds) {
    const node = getNode(db, nodeId);
    if (!node) continue;

    const vec = (await embed([node.content], "query"))[0];
    const hits = searchSimilar(db, vec, 10, { nodeType: "instruction" });

    const candidates = hits
      .filter(h => h.nodeId !== nodeId && h.score >= SAFETY_NET.reconcileCosineThreshold)
      .map(h => ({ ...h, node: getNode(db, h.nodeId) }))
      .filter(h => h.node != null && !h.node.superseded_by);

    if (candidates.length === 0) continue;

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

    let parsed: { results: { id: string; verdict: string; reason: string }[]; question: string | null };
    try {
      const cleaned = response.content
        .replace(/```json\n?/g, "")
        .replace(/```\n?/g, "")
        .trim();
      parsed = JSON.parse(cleaned);
    } catch {
      logger.error("[reconcile] Parse failed", { nodeId, raw: response.content.slice(0, 200) });
      continue;
    }

    if (!Array.isArray(parsed.results)) continue;

    for (const r of parsed.results) {
      if (r.verdict === "SUPERSEDES") {
        const oldNode = getNode(db, r.id);
        if (!oldNode || oldNode.superseded_by) continue;

        const replacementId = supersedeNode(db, r.id, node.content);
        const newVec = (await embed([node.content]))[0];
        storeEmbedding(db, replacementId, node.node_type, newVec);

        result.superseded.push({ oldId: r.id, newId: replacementId, reason: r.reason });
      } else if (r.verdict === "CONTRADICTION") {
        const oldNode = getNode(db, r.id);
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
