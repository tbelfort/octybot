import { LAYER1_MODEL } from "./config";
import { callWorkersAI } from "./workers-ai";
import { L1_CLASSIFY_PROMPT } from "./prompts";
import type { Layer1Result, ChatMessage } from "./types";
import { logger } from "./logger";

const SYSTEM_PROMPT = L1_CLASSIFY_PROMPT;

const DEFAULT_RESULT: Layer1Result = {
  entities: [],
  implied_facts: [],
  events: [],
  plans: [],
  opinions: [],
  concepts: [],
  implied_processes: [],
  intents: [],
  operations: { retrieve: false, store: false },
};

function tryParse(raw: string): Layer1Result | null {
  try {
    const cleaned = raw
      .replace(/```json\n?/g, "")
      .replace(/```\n?/g, "")
      .trim();
    if (!cleaned) return null;
    const parsed = JSON.parse(cleaned);
    return {
      entities: Array.isArray(parsed.entities) ? parsed.entities : [],
      implied_facts: Array.isArray(parsed.implied_facts) ? parsed.implied_facts : [],
      events: Array.isArray(parsed.events) ? parsed.events : [],
      plans: Array.isArray(parsed.plans) ? parsed.plans : [],
      opinions: Array.isArray(parsed.opinions) ? parsed.opinions : [],
      concepts: Array.isArray(parsed.concepts) ? parsed.concepts : [],
      implied_processes: Array.isArray(parsed.implied_processes) ? parsed.implied_processes : [],
      intents: Array.isArray(parsed.intents) ? parsed.intents : [],
      operations: {
        retrieve: !!parsed.operations?.retrieve,
        store: !!parsed.operations?.store,
      },
    };
  } catch {
    return null;
  }
}

/**
 * Fallback classification when L1 model fails to return valid JSON.
 * Extracts capitalized words as potential entity names and assumes retrieve=true.
 */
function fallbackClassify(prompt: string): Layer1Result {
  // Extract potential entity names: capitalized words that aren't sentence starters
  const words = prompt.split(/\s+/);
  const entities: Layer1Result["entities"] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i].replace(/[?.!,;:'"()]/g, "");
    if (!w || w.length < 2) continue;
    // Skip first word (sentence start) and common question words
    const skipWords = new Set(["who", "what", "when", "where", "why", "how", "is", "are", "do", "does", "did", "can", "the", "a", "an", "any", "i", "we", "our", "my", "me", "tell", "about", "from", "for", "with", "should", "would", "could", "have", "has", "been", "now", "that", "this", "there", "need", "want", "think"]);
    if (skipWords.has(w.toLowerCase())) continue;
    if (i > 0 && /^[A-Z]/.test(w)) {
      entities.push({ name: w, type: "concept" as any, ambiguous: true });
    }
  }

  // Fallback = L1 completely failed. Store the whole prompt as a fact — better to
  // over-store than miss important info. The storage filter will discard noise.
  logger.warn(`Fallback classification for: "${prompt.slice(0, 60)}..." — extracted ${entities.length} entities`);
  return {
    ...DEFAULT_RESULT,
    entities,
    implied_facts: [prompt],
    plans: [],
    concepts: [prompt.slice(0, 100)],
    intents: ["information"],
    operations: { retrieve: true, store: true },
  };
}

export interface ClassifyResult {
  result: Layer1Result;
  raw: string;        // Raw LLM response text
  duration_ms: number;
  retried: boolean;
  fallback: boolean;
}

// ── Sentence splitting ────────────────────────────────────────────────

const ABBREVIATIONS = /\b(?:Mr|Mrs|Ms|Dr|Sr|Jr|Prof|Inc|Ltd|Corp|etc|vs|approx|dept|govt|e\.g|i\.e)\.\s/g;

function splitSentences(text: string): string[] {
  // Protect abbreviations from splitting
  let safe = text;
  const abbrs: { placeholder: string; original: string }[] = [];
  safe = safe.replace(ABBREVIATIONS, (match) => {
    const ph = `__ABBR${abbrs.length}__ `;
    abbrs.push({ placeholder: ph.trim(), original: match.trimEnd() });
    return ph;
  });

  // Split on sentence-ending punctuation followed by space + uppercase/quote
  const parts = safe.split(/(?<=[.!?])\s+(?=[A-Z"'(])/)
    .map(s => {
      let restored = s;
      for (const { placeholder, original } of abbrs) {
        restored = restored.replace(placeholder, original);
      }
      return restored.trim();
    })
    .filter(s => s.length > 0);

  return parts.length > 0 ? parts : [text];
}

// ── Single-sentence classification ────────────────────────────────────

async function classifySingle(
  sentence: string,
  fullMessage?: string,
  conversationContext?: string
): Promise<{ result: Layer1Result | null; raw: string }> {
  let userContent: string;
  if (fullMessage && fullMessage !== sentence) {
    userContent = `Full message (for pronoun/reference resolution):\n"${fullMessage}"\n\nClassify THIS specific sentence:\n"${sentence}"`;
  } else {
    userContent = sentence;
  }
  // Prepend conversation context if provided (for resolving pronouns across turns)
  if (conversationContext) {
    userContent = conversationContext + userContent;
  }

  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userContent },
  ];

  const response = await callWorkersAI(LAYER1_MODEL, messages, {
    temperature: 0.1,
    tag: "l1",
  });

  const result = tryParse(response.content);
  if (result) return { result, raw: response.content };

  // One retry with higher temperature
  const retry = await callWorkersAI(LAYER1_MODEL, messages, {
    temperature: 0.3,
    tag: "l1",
  });
  return { result: tryParse(retry.content), raw: retry.content };
}

// ── Merge per-sentence results ────────────────────────────────────────

function mergeResults(results: Layer1Result[]): Layer1Result {
  // Dedupe entities by lowercase name
  const entityMap = new Map<string, Layer1Result["entities"][0]>();
  for (const r of results) {
    for (const e of r.entities) {
      const key = e.name.toLowerCase();
      if (!entityMap.has(key)) entityMap.set(key, e);
    }
  }

  return {
    entities: [...entityMap.values()],
    implied_facts: results.flatMap(r => r.implied_facts),
    events: results.flatMap(r => r.events),
    plans: results.flatMap(r => r.plans),
    opinions: results.flatMap(r => r.opinions),
    concepts: [...new Set(results.flatMap(r => r.concepts))],
    implied_processes: results.flatMap(r => r.implied_processes),
    intents: [...new Set(results.flatMap(r => r.intents))] as Layer1Result["intents"],
    operations: {
      retrieve: results.some(r => r.operations.retrieve),
      store: results.some(r => r.operations.store),
    },
  };
}

// ── Public entry point ────────────────────────────────────────────────

export async function classify(prompt: string, conversationContext?: string): Promise<ClassifyResult> {
  const start = Date.now();
  const sentences = splitSentences(prompt);

  // Build context prefix for pronoun resolution
  // (e.g., Claude's response that clarifies who "her" or "he" refers to)
  const contextPrefix = conversationContext
    ? `[Conversation context for pronoun/reference resolution — do NOT extract facts from this]\n${conversationContext}\n\n`
    : undefined;

  // Single sentence — classify directly (no overhead)
  if (sentences.length <= 1) {
    const { result, raw } = await classifySingle(prompt, undefined, contextPrefix);
    if (result) return { result, raw, duration_ms: Date.now() - start, retried: false, fallback: false };

    logger.warn("Using fallback classification.");
    return { result: fallbackClassify(prompt), raw: `${raw}\n[fallback]`, duration_ms: Date.now() - start, retried: true, fallback: true };
  }

  // Multiple sentences — classify each in parallel with full message as context
  const promises = sentences.map(s => classifySingle(s, prompt, contextPrefix));
  const settled = await Promise.all(promises);

  const good: Layer1Result[] = [];
  const raws: string[] = [];
  for (let i = 0; i < settled.length; i++) {
    raws.push(`[s${i + 1}] ${settled[i].raw}`);
    if (settled[i].result) good.push(settled[i].result!);
  }

  if (good.length === 0) {
    logger.warn(`All ${sentences.length} sentence classifications failed, using fallback.`);
    return { result: fallbackClassify(prompt), raw: raws.join("\n") + "\n[fallback]", duration_ms: Date.now() - start, retried: true, fallback: true };
  }

  const merged = mergeResults(good);

  // Safety net: if the LLM returned valid JSON but extracted nothing useful
  // from a non-trivial prompt, treat it as a classification failure
  const hasAnything = merged.entities.length > 0 || merged.implied_facts.length > 0 ||
    merged.events.length > 0 || merged.plans.length > 0 || merged.opinions.length > 0;
  const isNonTrivial = prompt.split(/\s+/).length >= 4;
  if (!hasAnything && isNonTrivial) {
    logger.warn("LLM returned empty classification for non-trivial prompt, using fallback.");
    return { result: fallbackClassify(prompt), raw: raws.join("\n") + "\n[empty-fallback]", duration_ms: Date.now() - start, retried: false, fallback: true };
  }

  return { result: merged, raw: raws.join("\n"), duration_ms: Date.now() - start, retried: false, fallback: false };
}
