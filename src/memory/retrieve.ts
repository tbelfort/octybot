/**
 * Retrieval pipeline: L1.5 plan → L2 tool loop → 3 safety nets → assemble → curate.
 * Extracted from layer2.ts.
 */

import type { Database } from "bun:sqlite";
import { LAYER2_MODEL, MAX_LAYER2_TURNS, LAYER2_TIMEOUT_MS } from "./config";
import { callWorkersAI } from "./workers-ai";
import { REASONING_PROMPT, RETRIEVE_PROMPT } from "./prompts";
import { MAX_INSTRUCTIONS, SAFETY_NET } from "./constants";
import { RETRIEVE_TOOLS } from "./retrieve-tools";
import { runToolLoop } from "./tool-loop";
import { assembleContext, flattenSections } from "./assemble";
import { curateContext } from "./curate";
import { getNode } from "./db-crud";
import { getGlobalInstructions } from "./db-queries";
import { embed } from "./voyage";
import { searchSimilar } from "./vectors";
import type { Layer1Result, ToolTurn, MemoryNode } from "./types";
import { logger } from "./logger";

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
    tag: "l1",
  });

  return response.content || "";
}

export async function retrieveLoop(
  db: Database,
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
    db,
    RETRIEVE_PROMPT,
    userContent,
    RETRIEVE_TOOLS,
    turns,
    MAX_LAYER2_TURNS,
    LAYER2_TIMEOUT_MS
  );
  const search_ms = Date.now() - searchStart;

  // ── Deterministic safety nets ──
  const fmt = (n: MemoryNode, score: number) =>
    `[${n.node_type}${n.subtype ? "/" + n.subtype : ""}] ${n.content} (id: ${n.id}, salience: ${n.salience}) [score: ${score.toFixed(3)}]`;

  const queryVec = (await embed([prompt], "query"))[0];
  if (queryVec) {
    // #1: Pre-fetch instructions — pure embedding search with template dedup
    const instrHits = searchSimilar(db, queryVec, MAX_INSTRUCTIONS * 10, { nodeType: "instruction" });
    if (instrHits.length > 0) {
      const seen = new Map<string, number>();
      const deduped: Array<{ nodeId: string; score: number; node: MemoryNode }> = [];
      for (const h of instrHits) {
        const node = getNode(db, h.nodeId);
        if (!node) continue;
        const templateKey = node.content
          .split(/\s+/)
          .map(w => /^[A-Z]/.test(w) ? "_" : w.toLowerCase())
          .slice(0, 15)
          .join(" ")
          .replace(/_(\s_)*/g, "_");
        const count = seen.get(templateKey) ?? 0;
        if (count >= SAFETY_NET.templateMaxPerPattern) continue;
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
    const broadHits = searchSimilar(db, queryVec, SAFETY_NET.broadSearchTopK);
    if (broadHits.length > 0) {
      const lines = broadHits.map(h => {
        const node = getNode(db, h.nodeId);
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
    const globalInstructions = getGlobalInstructions(db);
    if (globalInstructions.length > 0) {
      const globalIds = globalInstructions.map(n => n.id);
      const hits = searchSimilar(db, queryVec, globalIds.length, { nodeIds: globalIds });
      const relevant = hits.filter(h => h.score > SAFETY_NET.globalCosineBar);
      if (relevant.length > 0) {
        const lines = relevant.map(h => {
          const node = getNode(db, h.nodeId);
          const boostedScore = Math.max(h.score, SAFETY_NET.globalScoreFloor);
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
  const sections = assembleContext(db, turns);
  const context = flattenSections(sections);

  // Per-section curation: Method B on each type in parallel
  const curation = await curateContext(prompt, sections);
  const curate_ms = curation.duration_ms;

  return { context, curatedContext: curation.curated, turns, searchPlan, timing: { plan_ms, search_ms, curate_ms } };
}
