/**
 * Per-section context curation (Method B: text-based verbatim copy).
 * Runs OSS-120B on each section in parallel.
 * Extracted from layer2.ts.
 */

import { LAYER2_MODEL } from "./config";
import { callWorkersAI } from "./workers-ai";
import { CURATION_PROMPT } from "./prompts";
import { flattenSections, type ContextSections } from "./assemble";

async function curateSection(
  prompt: string,
  sectionLabel: string,
  sectionContent: string
): Promise<string> {
  if (!sectionContent) return "";

  const msgs = [
    { role: "system" as const, content: CURATION_PROMPT },
    { role: "user" as const, content: `Query: "${prompt}"\n\n${sectionLabel}:\n${sectionContent}` },
  ];
  const opts = { max_tokens: 2048, temperature: 0.1, tag: "curate" as const };

  const raw = (await callWorkersAI(LAYER2_MODEL, msgs, opts)).content || "";

  if (raw === "NO_RELEVANT_RECORDS") return "";
  return raw;
}

export async function curateContext(
  prompt: string,
  sections: ContextSections
): Promise<{ curated: string; duration_ms: number }> {
  const flat = flattenSections(sections);
  if (!flat) return { curated: "", duration_ms: 0 };

  const start = Date.now();

  const [entities, instructions, facts, events, plans] = await Promise.all([
    curateSection(prompt, "People & things", sections.entities),
    curateSection(prompt, "Instructions & rules", sections.instructions),
    curateSection(prompt, "Facts", sections.facts),
    curateSection(prompt, "Events", sections.events),
    curateSection(prompt, "Upcoming plans", sections.plans),
  ]);

  const duration_ms = Date.now() - start;
  const parts = [entities, instructions, facts, events, plans].filter(Boolean);
  const curated = parts.join("\n\n");

  return { curated, duration_ms };
}
