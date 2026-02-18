/**
 * Structured context assembly from tool loop results.
 * Collects node IDs from tool results, ranks by score, builds ContextSections.
 * Extracted from layer2.ts.
 */

import type { Database } from "bun:sqlite";
import { getNode, promotePlanToEvent } from "./db-crud";
import { getRelationships } from "./db-queries";
import {
  MAX_ENTITIES, MAX_RELS_PER_ENTITY, MAX_FACTS, MAX_INSTRUCTIONS,
  MAX_EVENTS, MAX_PLANS, SAFETY_NET,
} from "./constants";
import type { ToolTurn, MemoryNode } from "./types";

export interface ContextSections {
  entities: string;
  instructions: string;
  facts: string;
  events: string;
  plans: string;
}

export function assembleContext(db: Database, turns: ToolTurn[]): ContextSections {
  const nodeScores = new Map<string, number>();

  for (const turn of turns) {
    if (["done", "store_memory", "supersede_memory"].includes(turn.tool_call.name)) continue;
    const result = turn.result.result as string;
    if (!result || result.startsWith("No ") || result.startsWith("Unknown")) continue;

    for (const line of result.split("\n")) {
      const idMatch = line.match(/\(id:\s*([a-f0-9-]+)/);
      if (!idMatch) continue;
      const id = idMatch[1];

      const scoreMatch = line.match(/\[score:\s*([\d.]+)\]/);
      const score = scoreMatch ? parseFloat(scoreMatch[1]) : 0.5;

      const existing = nodeScores.get(id) ?? 0;
      if (score > existing) nodeScores.set(id, score);
    }
  }

  const empty: ContextSections = { entities: "", instructions: "", facts: "", events: "", plans: "" };
  if (nodeScores.size === 0) return empty;

  interface RankedNode { node: MemoryNode; score: number }
  const ranked: RankedNode[] = [];

  for (const [id, score] of nodeScores) {
    const node = getNode(db, id);
    if (!node || node.superseded_by) continue;
    ranked.push({ node, score });
  }

  ranked.sort((a, b) => b.score - a.score);

  const groups: Record<string, RankedNode[]> = {
    entity: [], fact: [], event: [], opinion: [], instruction: [], plan: [],
  };
  for (const r of ranked) {
    const bucket = groups[r.node.node_type] ?? [];
    bucket.push(r);
    groups[r.node.node_type] = bucket;
  }

  // Collect node IDs that appear in non-entity sections to avoid duplicating
  // them as "about" relationships on entities
  const nonEntityNodeIds = new Set<string>();
  for (const [type, items] of Object.entries(groups)) {
    if (type === "entity") continue;
    for (const { node: n } of items) nonEntityNodeIds.add(n.id);
  }

  // Entities with relationships (skip edges to nodes that appear in other sections)
  let entitiesText = "";
  if (groups.entity.length > 0) {
    const lines: string[] = [];
    for (const { node } of groups.entity.slice(0, MAX_ENTITIES)) {
      lines.push(`${node.content}`);
      const rels = getRelationships(db, node.id);
      const topRels = rels
        .filter((r) => !nonEntityNodeIds.has(r.target.id))
        .sort((a, b) => (b.target.salience ?? 1) - (a.target.salience ?? 1))
        .slice(0, MAX_RELS_PER_ENTITY);
      for (const rel of topRels) {
        lines.push(`  - ${rel.edge.edge_type}: ${rel.target.content}`);
      }
    }
    entitiesText = lines.join("\n");
  }

  // Instructions — sort by cosine score (relevance to query) first, scope as tiebreaker
  const instrGroup = groups.instruction ?? [];
  instrGroup.sort((a, b) => {
    const scoreDiff = b.score - a.score;
    if (Math.abs(scoreDiff) > SAFETY_NET.instructionTiebreaker) return scoreDiff;
    return (b.node.scope ?? 0.5) - (a.node.scope ?? 0.5);
  });
  const allInstructions = instrGroup.slice(0, MAX_INSTRUCTIONS);
  const instructionsText = allInstructions.map((r) => `- ${r.node.content}`).join("\n");

  // Facts + opinions
  const allFacts = [...(groups.fact ?? []), ...(groups.opinion ?? [])].slice(0, MAX_FACTS);
  const factsText = allFacts.map((r) => `- ${r.node.content}`).join("\n");

  // Plan auto-promotion: plans whose valid_from has passed become events
  const promotedAnnotations = new Map<string, string>();
  for (let i = groups.plan.length - 1; i >= 0; i--) {
    const planNode = groups.plan[i].node;
    if (planNode.valid_from) {
      const validFrom = new Date(planNode.valid_from);
      if (validFrom <= new Date()) {
        const promoted = promotePlanToEvent(db, planNode.id);
        if (promoted) {
          promotedAnnotations.set(promoted.id, `[Was scheduled for ${planNode.valid_from} — now past] `);
          groups.event.push({ node: promoted, score: groups.plan[i].score });
          groups.plan.splice(i, 1);
        }
      }
    }
  }

  // Events (including promoted plans)
  const eventsText = groups.event.slice(0, MAX_EVENTS).map((r) => {
    const annotation = promotedAnnotations.get(r.node.id) ?? "";
    return `- ${annotation}${r.node.content}`;
  }).join("\n");

  // Plans (upcoming, sorted by valid_from ascending — soonest first)
  const plansSorted = groups.plan.slice(0, MAX_PLANS).sort((a, b) => {
    const aDate = a.node.valid_from ?? "";
    const bDate = b.node.valid_from ?? "";
    return aDate.localeCompare(bDate);
  });
  const plansText = plansSorted.map((r) => {
    const dateTag = r.node.valid_from ? ` [scheduled: ${r.node.valid_from}]` : "";
    return `- ${r.node.content}${dateTag}`;
  }).join("\n");

  return { entities: entitiesText, instructions: instructionsText, facts: factsText, events: eventsText, plans: plansText };
}

/** Flatten sections into a single string (for debug/logging) */
export function flattenSections(sections: ContextSections): string {
  const parts: string[] = [];
  if (sections.entities) parts.push("People & things:\n" + sections.entities);
  if (sections.instructions) parts.push("Instructions:\n" + sections.instructions);
  if (sections.facts) parts.push("Facts:\n" + sections.facts);
  if (sections.events) parts.push("Events:\n" + sections.events);
  if (sections.plans) parts.push("Upcoming plans:\n" + sections.plans);
  return parts.join("\n\n");
}
