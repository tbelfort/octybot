import { LAYER1_MODEL } from "./config";
import { callWorkersAI } from "./workers-ai";
import type { Layer1Result, ChatMessage } from "./types";

const SYSTEM_PROMPT = `You are a memory classification model. Given a user message, perform three tasks:

1. EXTRACT all entities, implied facts, events, plans, opinions, concepts, and implied processes.
2. CLASSIFY the intent(s). A message can have MULTIPLE intents:
   - action: user wants something executed
   - information: user wants to know something
   - status: user wants current state
   - process: user needs a stored procedure
   - recall: user wants past events recalled
   - comparison: user wants things compared
   - verification: user wants to confirm something
   - instruction: user is teaching/commanding ("from now on...", "always...", "never...")
   - correction: user is FIXING existing knowledge ("actually...", "no,", "that's wrong", moving/changing roles, updating facts)
   - opinion: user is expressing a subjective view
   - planning: user wants to plan something
   - delegation: user wants autonomous handling
3. DECIDE memory operations based on intents:
   - retrieve=true for: action, information, status, process, recall, comparison, verification, opinion, planning, delegation
   - store=true for: instruction, correction
   - BOTH retrieve=true AND store=true for: correction (find old fact + store new one)
   - retrieve=true AND store=true when the user states new facts while asking something

   If the user mentions ANY entities or asks ANY question, retrieve MUST be true.
   If the user states something as new fact (e.g. "Peter moved to X", "We switched to Y"), store MUST be true.
   If the user mentions a future plan/scheduled item (e.g. "Dave is going on holiday March 3rd"), store MUST be true.

Rules:
- Extract what is EXPLICITLY mentioned and what is IMPLICITLY referenced.
- Mark entities as ambiguous if there's no qualifier (e.g. just a first name).
- "implied_facts" = SPECIFIC, NON-OBVIOUS facts stated or strongly implied. Only include facts that contain concrete details (names, numbers, roles, dates, relationships). EXCLUDE: common sense, tautologies, vague predictions, and things anyone would know without being told. Bad: "articles can be AI or human written". Good: "Jeff handles AI detection checks".
- "plans" = future scheduled things with specific dates or timeframes. "Dave is going on holiday March 3rd", "Anderson delivery due next Friday", "Team meeting rescheduled to Thursday". NOT past events.
- "concepts" = abstract topics or domains referenced.
- "implied_processes" = if the message implies a known procedure.
- If a field has no entries, use an empty array.

Output valid JSON only. No markdown. No explanation. No reasoning preamble.

Schema:
{
  "entities": [{ "name": "string", "type": "person|org|project|place|tool|process|document|concept|event|account", "ambiguous": boolean }],
  "implied_facts": ["string"],
  "events": ["string"],
  "plans": ["string"],
  "opinions": ["string"],
  "concepts": ["string"],
  "implied_processes": ["string"],
  "intents": ["string"],
  "operations": { "retrieve": boolean, "store": boolean }
}`;

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
  console.error(`[layer1] Fallback classification for: "${prompt.slice(0, 60)}..." — extracted ${entities.length} entities`);
  return {
    ...DEFAULT_RESULT,
    entities,
    plans: [],
    concepts: [prompt.slice(0, 100)],
    intents: ["information"],
    operations: { retrieve: true, store: false },
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
  fullMessage?: string
): Promise<{ result: Layer1Result | null; raw: string }> {
  const userContent = fullMessage && fullMessage !== sentence
    ? `Full message (for pronoun/reference resolution):\n"${fullMessage}"\n\nClassify THIS specific sentence:\n"${sentence}"`
    : sentence;

  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userContent },
  ];

  const response = await callWorkersAI(LAYER1_MODEL, messages, {
    max_tokens: 1024,
    temperature: 0.1,
    tag: "l1",
  });

  const result = tryParse(response.content);
  if (result) return { result, raw: response.content };

  // One retry with higher temperature
  const retry = await callWorkersAI(LAYER1_MODEL, messages, {
    max_tokens: 1024,
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

export async function classify(prompt: string): Promise<ClassifyResult> {
  const start = Date.now();
  const sentences = splitSentences(prompt);

  // Single sentence — classify directly (no overhead)
  if (sentences.length <= 1) {
    const { result, raw } = await classifySingle(prompt);
    if (result) return { result, raw, duration_ms: Date.now() - start, retried: false, fallback: false };

    console.error(`[layer1] Using fallback classification.`);
    return { result: fallbackClassify(prompt), raw: `${raw}\n[fallback]`, duration_ms: Date.now() - start, retried: true, fallback: true };
  }

  // Multiple sentences — classify each in parallel with full message as context
  const promises = sentences.map(s => classifySingle(s, prompt));
  const settled = await Promise.all(promises);

  const good: Layer1Result[] = [];
  const raws: string[] = [];
  for (let i = 0; i < settled.length; i++) {
    raws.push(`[s${i + 1}] ${settled[i].raw}`);
    if (settled[i].result) good.push(settled[i].result!);
  }

  if (good.length === 0) {
    console.error(`[layer1] All ${sentences.length} sentence classifications failed, using fallback.`);
    return { result: fallbackClassify(prompt), raw: raws.join("\n") + "\n[fallback]", duration_ms: Date.now() - start, retried: true, fallback: true };
  }

  const merged = mergeResults(good);
  return { result: merged, raw: raws.join("\n"), duration_ms: Date.now() - start, retried: false, fallback: false };
}
