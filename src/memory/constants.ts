/**
 * All numeric constants and configuration for the memory pipeline.
 * Extracted from layer2.ts for reuse across split modules.
 */

// ── Per-type assembly limits (generous — per-section curation filters downstream)
export const MAX_ENTITIES = 15;
export const MAX_RELS_PER_ENTITY = 8;
export const MAX_FACTS = 30;
export const MAX_INSTRUCTIONS = 15;
export const MAX_EVENTS = 15;
export const MAX_PLANS = 10;

// ── Tool loop
export const MAX_CONSECUTIVE_ERRORS = 3;
export const MAX_RESULT_CHARS = 4000;

// ── API retry / timeout
export const MAX_RETRIES = 3;
export const RETRY_DELAY_MS = 1000;
export const FETCH_TIMEOUT_MS = 30_000;

// ── Conversation state
export const MAX_TURNS_KEPT = 5;

// ── Safety net config
export const SAFETY_NET = {
  templateMaxPerPattern: 2,
  globalScopeThreshold: 0.8,
  globalCosineBar: 0.15,
  globalScoreFloor: 0.6,
  reconcileCosineThreshold: 0.45,
  instructionTiebreaker: 0.05,
  broadSearchTopK: 20,
} as const;
