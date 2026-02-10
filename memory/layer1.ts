import { LAYER1_MODEL } from "./config";
import { callWorkersAI } from "./workers-ai";
import type { Layer1Result, ChatMessage } from "./types";

const SYSTEM_PROMPT = `You are a memory classification model. Given a user message, perform three tasks:

1. EXTRACT all entities, implied facts, events, opinions, concepts, and implied processes.
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

Rules:
- Extract what is EXPLICITLY mentioned and what is IMPLICITLY referenced.
- Mark entities as ambiguous if there's no qualifier (e.g. just a first name).
- "implied_facts" = SPECIFIC, NON-OBVIOUS facts stated or strongly implied. Only include facts that contain concrete details (names, numbers, roles, dates, relationships). EXCLUDE: common sense, tautologies, vague predictions, and things anyone would know without being told. Bad: "articles can be AI or human written". Good: "Jeff handles AI detection checks".
- "concepts" = abstract topics or domains referenced.
- "implied_processes" = if the message implies a known procedure.
- If a field has no entries, use an empty array.

Output valid JSON only. No markdown. No explanation. No reasoning preamble.

Schema:
{
  "entities": [{ "name": "string", "type": "person|org|project|place|tool|process|document|concept|event|account", "ambiguous": boolean }],
  "implied_facts": ["string"],
  "events": ["string"],
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

export async function classify(prompt: string): Promise<ClassifyResult> {
  const start = Date.now();
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: prompt },
  ];

  // Attempt 1
  const response = await callWorkersAI(LAYER1_MODEL, messages, {
    max_tokens: 1024,
    temperature: 0.1,
    tag: "l1",
  });

  const result = tryParse(response.content);
  if (result) return { result, raw: response.content, duration_ms: Date.now() - start, retried: false, fallback: false };

  // Attempt 2: retry with slightly higher temperature
  console.error(`[layer1] Parse failed, retrying... Raw: ${response.content.slice(0, 100)}`);
  const retry = await callWorkersAI(LAYER1_MODEL, messages, {
    max_tokens: 1024,
    temperature: 0.3,
    tag: "l1",
  });

  const retryResult = tryParse(retry.content);
  if (retryResult) return { result: retryResult, raw: `[attempt1] ${response.content}\n[attempt2] ${retry.content}`, duration_ms: Date.now() - start, retried: true, fallback: false };

  // Both attempts failed — use fallback
  console.error(`[layer1] Retry also failed. Raw: ${retry.content.slice(0, 100)}`);
  console.error(`[layer1] Using fallback classification.`);
  return { result: fallbackClassify(prompt), raw: `[attempt1] ${response.content}\n[attempt2] ${retry.content}\n[fallback]`, duration_ms: Date.now() - start, retried: true, fallback: true };
}
