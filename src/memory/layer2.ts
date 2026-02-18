/**
 * Memory pipeline orchestrator.
 * Runs retrieve + store pipelines in parallel, then reconciles.
 *
 * This file used to contain the entire pipeline (~1,500 lines).
 * It's now split into focused modules — see imports below.
 */

import type { Database } from "bun:sqlite";
import { CONVERSATION_STATE_PATH } from "./config";
import { retrieveLoop } from "./retrieve";
import { filterForStorage, extractInstructions, storeLoop, reconcileMemories } from "./store";
import type { StoreFilterResult } from "./store";
import {
  readConversationState as _readState,
  writeConversationState as _writeState,
} from "./state";
import type { Layer1Result, ToolTurn, StoreItem, ConversationTurn } from "./types";
import { logger } from "./logger";

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
  db: Database,
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
    ? retrieveLoop(db, prompt, layer1Result)
    : Promise.resolve(null);

  const storePromise = hasStorableContent
    ? (async () => {
        const instrResult = await extractInstructions(prompt);
        const filterResult = await filterForStorage(prompt, layer1Result, instrResult.instructions);
        storeFilter = filterResult;

        const instructionItems: StoreItem[] = instrResult.instructions.map(ei => ({
          content: ei.content,
          type: "instruction",
          subtype: ei.subtype,
          scope: ei.scope,
        }));
        const filterNonInstructions = filterResult.storeItems.filter(item => item.type !== "instruction");
        const allItems = [...instructionItems, ...filterNonInstructions];

        if (allItems.length === 0) {
          return { turns: [] as ToolTurn[], store_ms: 0 };
        }
        const storeStart = Date.now();
        const storeResult = await storeLoop(db, prompt, layer1Result, allItems);
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
  let contradictions: AgenticResult["contradictions"];
  if (storeResult?.turns && storeResult.turns.length > 0) {
    const newNodeIds: string[] = [];
    for (const turn of storeResult.turns) {
      if (turn.tool_call.name === "store_memory") {
        const resultStr = turn.result.result as string;
        const match = resultStr.match(/^Stored memory ([a-f0-9-]+) \(instruction\//);
        if (match) newNodeIds.push(match[1]);
      }
    }
    if (newNodeIds.length > 0) {
      const reconcileStart = Date.now();
      const reconciliation = await reconcileMemories(db, newNodeIds);
      const reconcile_ms = Date.now() - reconcileStart;
      if (timing) timing.reconcile_ms = reconcile_ms;

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

// ── Conversation state management (delegates to memory/state.ts) ─────

export function readConversationState() {
  return _readState(CONVERSATION_STATE_PATH);
}

export function writeConversationState(turns: ConversationTurn[], sessionId?: string) {
  _writeState(CONVERSATION_STATE_PATH, turns, sessionId);
}
