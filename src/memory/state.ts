/**
 * Conversation state persistence.
 * Read/write turn history for follow-up pipeline.
 * Extracted from layer2.ts — accepts statePath as parameter.
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { MAX_TURNS_KEPT } from "./constants";
import type { ConversationState, ConversationTurn } from "./types";

export function readConversationState(statePath: string): ConversationState | null {
  try {
    const raw = readFileSync(statePath, "utf-8");
    const state = JSON.parse(raw) as ConversationState;
    if (!Array.isArray(state.turns) || state.turns.length === 0) return null;
    return state;
  } catch {
    return null;
  }
}

export function writeConversationState(statePath: string, turns: ConversationTurn[], sessionId?: string): void {
  const capped = turns.slice(-MAX_TURNS_KEPT);
  const state: ConversationState = { sessionId, turns: capped };
  try {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error(`[state] Failed to write conversation state: ${(err as Error).message}`);
  }
}
