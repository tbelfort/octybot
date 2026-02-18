/**
 * Conversation-aware follow-up pipeline.
 * Single LLM analysis → targeted tool calls → optional store.
 * Extracted from layer2.ts.
 */

import type { Database } from "bun:sqlite";
import { LAYER2_MODEL } from "./config";
import { callWorkersAI } from "./workers-ai";
import { FOLLOWUP_PROMPT } from "./prompts";
import { handleRetrieveToolCall } from "./retrieve-tools";
import { getNode } from "./db-crud";
import { embed } from "./voyage";
import { searchSimilar } from "./vectors";
import { filterForStorage, extractInstructions, storeLoop, type ExtractedInstruction } from "./store";
import type { Layer1Result, ToolTurn, StoreItem, ConversationTurn, FollowUpResult } from "./types";
import { logger } from "./logger";

interface FollowUpAnalysis {
  resolved_entities: { name: string; type: string }[];
  retrieval_needed: boolean;
  retrieve_calls: { tool: string; args: Record<string, unknown> }[];
  storage_needed: boolean;
  resolved_prompt?: string;
  reasoning: string;
}

export async function followUpPipeline(
  db: Database,
  prompt: string,
  previousTurns: ConversationTurn[]
): Promise<FollowUpResult | null> {
  const analysisStart = Date.now();

  const turnLines = previousTurns.map(t => {
    let line = `User: "${t.prompt}" [entities: ${t.entities.join(", ") || "none"}]`;
    if (t.contextSummary) {
      line += `\n  Memory found: ${t.contextSummary}`;
    }
    return line;
  }).join("\n");

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
      logger.warn("Invalid analysis structure, falling back");
      return null;
    }
  } catch (err) {
    logger.error(`Analysis LLM call failed: ${(err as Error).message}`);
    return null;
  }

  const analysis_ms = Date.now() - analysisStart;
  const turns: ToolTurn[] = [];

  // Always search_entity first for every resolved entity
  const searchStart = Date.now();
  const entitySearched = new Set<string>();

  if (analysis.resolved_entities?.length > 0) {
    for (const entity of analysis.resolved_entities) {
      const name = entity.name?.trim();
      if (!name || entitySearched.has(name.toLowerCase())) continue;
      entitySearched.add(name.toLowerCase());
      try {
        const result = await handleRetrieveToolCall(db, "search_entity", { name });
        turns.push({
          tool_call: { name: "search_entity", arguments: { name } },
          result: { name: "search_entity", result },
          _pipeline: "retrieve",
        });
      } catch (err) {
        logger.warn(`search_entity(${name}) failed: ${(err as Error).message}`);
      }
    }
  }

  // Execute any additional LLM-chosen retrieve calls
  if (analysis.retrieval_needed && analysis.retrieve_calls?.length > 0) {
    for (const call of analysis.retrieve_calls) {
      const toolName = call.tool;
      if (toolName === "search_entity" && entitySearched.has(((call.args?.name as string) || "").toLowerCase())) continue;
      const args = call.args || {};
      try {
        const result = await handleRetrieveToolCall(db, toolName, args);
        turns.push({
          tool_call: { name: toolName, arguments: args },
          result: { name: toolName, result },
          _pipeline: "retrieve",
        });
      } catch (err) {
        logger.warn(`Tool ${toolName} failed: ${(err as Error).message}`);
      }
    }
  }

  // Broadening fallback: check what node types were covered
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
    const broadCount = Math.max(10, uncoveredTypes.length * 5);
    const broadResults = searchSimilar(db, queryVec, broadCount, { nodeTypes: uncoveredTypes });
    const MIN_SCORE = 0.25;
    const relevant = broadResults.filter(r => r.score >= MIN_SCORE);
    if (relevant.length > 0) {
      const nodes = relevant
        .map(r => ({ ...r, node: getNode(db, r.nodeId) }))
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
  let store_ms: number | undefined;
  const allStoreItems: StoreItem[] = [];
  if (analysis.storage_needed) {
    const storeStart = Date.now();
    const storePrompt = analysis.resolved_prompt || prompt;

    const minimalL1: Layer1Result = {
      entities: analysis.resolved_entities.map(e => ({
        name: e.name,
        type: e.type as Layer1Result["entities"][0]["type"],
        ambiguous: false,
      })),
      implied_facts: [storePrompt],
      events: [],
      plans: [],
      opinions: [],
      concepts: [],
      implied_processes: [],
      intents: [],
      operations: { retrieve: false, store: true },
    };

    const instrResult = await extractInstructions(storePrompt);
    const filterResult = await filterForStorage(storePrompt, minimalL1, instrResult.instructions);

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
      await storeLoop(db, storePrompt, minimalL1, combinedItems);
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
