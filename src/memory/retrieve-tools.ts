/**
 * Retrieval tool definitions and handler.
 * Extracted from tools.ts.
 */

import type { Database } from "bun:sqlite";
import { getNode } from "./db-crud";
import {
  getRelationships,
  getFactsByEntity,
  getEventsByEntity,
  getInstructions,
  getInstructionsByEntity,
  getRecentEventIds,
} from "./db-queries";
import { searchSimilar } from "./vectors";
import { embed } from "./voyage";
import { formatNode } from "./format";
import type { ToolDefinition, MemoryNode } from "./types";

export const RETRIEVE_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "search_entity",
      description:
        "Find an entity by name/alias. Returns the entity profile and its immediate relationships.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Entity name to search for" },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_relationships",
      description:
        "Get all relationships/edges from an entity, with summaries of connected nodes.",
      parameters: {
        type: "object",
        properties: {
          entity_id: { type: "string", description: "Entity node ID" },
        },
        required: ["entity_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_facts",
      description:
        "Semantic search for facts. Optionally scoped to a specific entity.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          entity_id: {
            type: "string",
            description: "Optional entity ID to scope results",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_events",
      description:
        "Semantic search for events. Optionally scoped to entity and/or time range.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          entity_id: {
            type: "string",
            description: "Optional entity ID to scope results",
          },
          days: {
            type: "number",
            description: "Only return events from the last N days",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_processes",
      description:
        "Find stored procedures, instructions, or tool usage guides by topic. Optionally scoped to a specific entity.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Topic to search for" },
          entity_id: {
            type: "string",
            description: "Optional entity ID to scope results to instructions connected to this entity",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_instructions",
      description:
        "Find behavioral rules and instructions, optionally filtered by topic or scoped to a specific entity.",
      parameters: {
        type: "object",
        properties: {
          topic: {
            type: "string",
            description: "Optional topic to filter instructions",
          },
          entity_id: {
            type: "string",
            description: "Optional entity ID to find instructions connected to this entity",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "done",
      description:
        "Signal that you have finished searching. The system will automatically collect all memories found by your tool calls — you do not need to assemble or pass any context.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
];

export async function handleRetrieveToolCall(
  db: Database,
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  switch (name) {
    case "search_entity": {
      const entityName = (args.name as string || "").trim();
      if (!entityName) return "No entities found. Provide a non-empty name.";
      const queryVec = (await embed([entityName], "query"))[0];
      const hits = searchSimilar(db, queryVec, 5, { nodeType: "entity" });
      if (hits.length === 0) return "No entities found.";

      const results: string[] = [];
      for (const hit of hits) {
        const entity = getNode(db, hit.nodeId);
        if (!entity) continue;
        results.push(`${formatNode(entity)} [score: ${hit.score.toFixed(3)}]`);
        const rels = getRelationships(db, entity.id);
        if (rels.length > 0) {
          const shown = rels.slice(0, 15);
          for (const rel of shown) {
            results.push(`  → ${rel.edge.edge_type} → ${rel.target.content} (${rel.target.node_type})`);
          }
          if (rels.length > 15) {
            results.push(`  ... and ${rels.length - 15} more relationships. Use get_relationships for full list.`);
          }
        }
      }
      return results.join("\n");
    }

    case "get_relationships": {
      const rels = getRelationships(db, args.entity_id as string);
      if (rels.length === 0) return "No relationships found.";
      const shown = rels.slice(0, 25);
      let output = shown
        .map(
          (r) =>
            `${r.edge.edge_type} → ${r.target.content} (${r.target.node_type}, id: ${r.target.id})`
        )
        .join("\n");
      if (rels.length > 25) {
        output += `\n... and ${rels.length - 25} more. Use search_facts with entity_id for scoped search.`;
      }
      return output;
    }

    case "search_facts": {
      const query = (args.query as string || "").trim();
      if (!query) return "No matching facts found. Provide a non-empty query.";
      const queryVec = (await embed([query], "query"))[0];
      let entityFacts: string[] | undefined;
      if (args.entity_id) {
        const facts = getFactsByEntity(db, args.entity_id as string);
        entityFacts = facts.map((f) => f.id);
      }
      const allResults = searchSimilar(db, queryVec, 20, {
        nodeTypes: ["fact", "opinion"],
        nodeIds: entityFacts,
      });
      if (allResults.length === 0) return "No matching facts found.";

      const filtered = allResults
        .map((r) => ({ ...r, node: getNode(db, r.nodeId) }))
        .filter((r) => r.node != null)
        .slice(0, 10);
      if (filtered.length === 0) return "No matching facts found.";
      let factsOutput = filtered
        .map((r) => `${formatNode(r.node!)} [score: ${r.score.toFixed(3)}]`)
        .join("\n");
      if (!args.entity_id && filtered.length >= 5) {
        factsOutput += "\nTip: These are broad results. Use entity_id to scope for more precise matches.";
      }
      return factsOutput;
    }

    case "search_events": {
      const query = (args.query as string || "").trim();
      if (!query) return "No matching events found. Provide a non-empty query.";
      const queryVec = (await embed([query], "query"))[0];
      let entityEvents: string[] | undefined;
      if (args.entity_id) {
        const events = getEventsByEntity(
          db,
          args.entity_id as string,
          args.days as number | undefined
        );
        entityEvents = events.map((e) => e.id);
      }
      if (!entityEvents && args.days) {
        entityEvents = getRecentEventIds(db, args.days as number);
      }
      const results = searchSimilar(db, queryVec, 20, {
        nodeType: "event",
        nodeIds: entityEvents,
      });
      if (results.length === 0) return "No matching events found.";

      let eventsOutput = results
        .map((r) => {
          const node = getNode(db, r.nodeId);
          return node
            ? `${formatNode(node)} [score: ${r.score.toFixed(3)}]`
            : `(node ${r.nodeId} not found)`;
        })
        .join("\n");
      if (!args.entity_id && results.length >= 5) {
        eventsOutput += "\nTip: These are broad results. Use entity_id to scope for more precise matches.";
      }
      return eventsOutput;
    }

    case "search_processes": {
      const query = (args.query as string || "").trim();
      if (!query) return "No matching processes found. Provide a non-empty query.";
      const queryVec = (await embed([query], "query"))[0];
      let entityInstrIds: string[] | undefined;
      if (args.entity_id) {
        const instrNodes = getInstructionsByEntity(db, args.entity_id as string);
        entityInstrIds = instrNodes.map((n) => n.id);
      }
      const results = searchSimilar(db, queryVec, 20, {
        nodeType: "instruction",
        nodeIds: entityInstrIds,
      });
      if (results.length === 0) return "No matching processes found.";

      const filtered = results
        .map((r) => ({ ...r, node: getNode(db, r.nodeId) }))
        .filter((r) => r.node != null);
      if (filtered.length === 0) return "No matching processes found.";
      return filtered
        .slice(0, 10)
        .map(
          (r) =>
            `${formatNode(r.node!)} [score: ${r.score.toFixed(3)}]`
        )
        .join("\n");
    }

    case "get_instructions": {
      let instructions: MemoryNode[];
      if (args.entity_id) {
        instructions = getInstructionsByEntity(db, args.entity_id as string);
      } else {
        instructions = getInstructions(db, args.topic as string | undefined);
      }
      if (instructions.length === 0) return "No instructions found.";
      return instructions.map(formatNode).join("\n");
    }

    case "done": {
      return "";
    }

    default:
      return `Unknown retrieve tool: ${name}`;
  }
}
