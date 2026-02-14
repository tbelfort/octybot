import {
  getRelationships,
  getFactsByEntity,
  getEventsByEntity,
  getInstructions,
  getInstructionsByEntity,
  getPlansByEntity,
  createNode,
  createEdge,
  supersedeNode,
  getNode,
  getRecentEventIds,
} from "./db";
import { searchSimilar, storeEmbedding } from "./vectors";
import { embed } from "./voyage";
import { getDevModeFile } from "./debug";
import { appendFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import type { ToolDefinition, MemoryNode } from "./types";

function logToDevMode(msg: string) {
  const file = getDevModeFile();
  if (!file) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

// --- Tool Definitions (OpenAI function-calling format) ---

// Retrieval-only tools
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
      name: "search_plans",
      description:
        "Semantic search for upcoming plans and scheduled items. Optionally scoped to a specific entity.",
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

// Storage-only tools
export const STORE_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "search_entity",
      description:
        "Find an entity by name/alias to get its ID for linking edges.",
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
      name: "search_facts",
      description:
        "Search for existing facts (used to find memories to supersede during corrections).",
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
      name: "store_memory",
      description:
        "Store a new memory node with optional edges to existing entities.",
      parameters: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: ["entity", "fact", "event", "opinion", "instruction", "plan"],
            description: "Node type. Use 'instruction' for rules, procedures, tool usage guides. Use 'plan' for future scheduled things with dates.",
          },
          subtype: {
            type: "string",
            description:
              'Optional classifier within the type. For entities: "person", "org", "tool". For instructions: "rule", "tool_usage", "process". For events: "action". For plans: "scheduled", "intended", "requested".',
          },
          valid_from: {
            type: "string",
            description: "ISO date string (YYYY-MM-DD). Required for plans — the scheduled date. Optional for events.",
          },
          content: { type: "string", description: "Memory content" },
          entity_ids: {
            type: "array",
            items: { type: "string" },
            description: "Entity IDs to connect via edges",
          },
          edge_type: {
            type: "string",
            description: "Edge type for connections (default: about)",
          },
          salience: {
            type: "number",
            description:
              "Importance multiplier. Base: 1.0. For facts/events: set 1.5-2.0 for critical info (lost clients, deadlines), 0.5-0.8 for routine. For instructions: do NOT set — they surface by relevance + scope. Default: 1.0.",
          },
          source: {
            type: "string",
            enum: ["user", "claude"],
            description: "Source attribution (default: user)",
          },
          scope: {
            type: "number",
            description:
              "How broadly this applies. 1.0 = universal/org-wide. 0.5 = tool/team-wide. 0.2 = entity-specific. Default: 0.5 for instructions, 0.3 for plans, null for others.",
          },
          related_ids: {
            type: "array",
            items: { type: "string" },
            description:
              'IDs of existing memories this is related to (creates "see_also" edges). Use when storing an update, transfer of responsibility, or related fact that doesn\'t fully replace the original.',
          },
        },
        required: ["type", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "supersede_memory",
      description:
        "Mark an existing memory as superseded and store the corrected version.",
      parameters: {
        type: "object",
        properties: {
          old_id: { type: "string", description: "ID of the memory to supersede" },
          new_content: {
            type: "string",
            description: "Corrected content to replace it",
          },
        },
        required: ["old_id", "new_content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "done",
      description:
        "Signal that all new information has been stored.",
      parameters: {
        type: "object",
        properties: {
          stored_count: {
            type: "number",
            description: "Number of memories stored.",
          },
        },
        required: ["stored_count"],
      },
    },
  },
];

// --- Tool Handlers ---

function formatNode(node: MemoryNode): string {
  return `[${node.node_type}${node.subtype ? "/" + node.subtype : ""}] ${node.content} (id: ${node.id}, salience: ${node.salience})`;
}

export async function handleToolCall(
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  switch (name) {
    case "search_entity": {
      const entityName = (args.name as string || "").trim();
      if (!entityName) return "No entities found. Provide a non-empty name.";
      const queryVec = (await embed([entityName], "query"))[0];
      const hits = searchSimilar(queryVec, 5, { nodeType: "entity" });
      if (hits.length === 0) return "No entities found.";

      const results: string[] = [];
      for (const hit of hits) {
        const entity = getNode(hit.nodeId);
        if (!entity) continue;
        results.push(`${formatNode(entity)} [score: ${hit.score.toFixed(3)}]`);
        const rels = getRelationships(entity.id);
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
      const rels = getRelationships(args.entity_id as string);
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
        const facts = getFactsByEntity(args.entity_id as string);
        entityFacts = facts.map((f) => f.id);
      }
      // Pre-filter to facts + opinions in vector search (no cross-type competition)
      const allResults = searchSimilar(queryVec, 20, {
        nodeTypes: ["fact", "opinion"],
        nodeIds: entityFacts,
      });
      if (allResults.length === 0) return "No matching facts found.";

      const filtered = allResults
        .map((r) => ({ ...r, node: getNode(r.nodeId) }))
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
          args.entity_id as string,
          args.days as number | undefined
        );
        entityEvents = events.map((e) => e.id);
      }
      if (!entityEvents && args.days) {
        entityEvents = getRecentEventIds(args.days as number);
      }
      const results = searchSimilar(queryVec, 20, {
        nodeTypes: ["event", "plan"],
        nodeIds: entityEvents,
      });
      if (results.length === 0) return "No matching events found.";

      let eventsOutput = results
        .map((r) => {
          const node = getNode(r.nodeId);
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

    case "search_plans": {
      const query = (args.query as string || "").trim();
      if (!query) return "No matching plans found. Provide a non-empty query.";
      const queryVec = (await embed([query], "query"))[0];
      let entityPlanIds: string[] | undefined;
      if (args.entity_id) {
        const plans = getPlansByEntity(args.entity_id as string);
        entityPlanIds = plans.map((p) => p.id);
      }
      const results = searchSimilar(queryVec, 20, {
        nodeType: "plan",
        nodeIds: entityPlanIds,
      });
      if (results.length === 0) return "No matching plans found.";

      let plansOutput = results
        .map((r) => {
          const node = getNode(r.nodeId);
          if (!node) return `(node ${r.nodeId} not found)`;
          const dateTag = node.valid_from ? ` [scheduled: ${node.valid_from}]` : "";
          return `${formatNode(node)}${dateTag} [score: ${r.score.toFixed(3)}]`;
        })
        .join("\n");
      if (!args.entity_id && results.length >= 5) {
        plansOutput += "\nTip: These are broad results. Use entity_id to scope for more precise matches.";
      }
      return plansOutput;
    }

    case "search_processes": {
      const query = (args.query as string || "").trim();
      if (!query) return "No matching processes found. Provide a non-empty query.";
      const queryVec = (await embed([query], "query"))[0];
      // When entity_id provided, scope to instructions connected via edges
      let entityInstrIds: string[] | undefined;
      if (args.entity_id) {
        const instrNodes = getInstructionsByEntity(args.entity_id as string);
        entityInstrIds = instrNodes.map((n) => n.id);
      }
      const results = searchSimilar(queryVec, 20, {
        nodeType: "instruction",
        nodeIds: entityInstrIds,
      });
      if (results.length === 0) return "No matching processes found.";

      const filtered = results
        .map((r) => ({ ...r, node: getNode(r.nodeId) }))
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
        // Entity-scoped: find instructions connected via edges
        instructions = getInstructionsByEntity(args.entity_id as string);
      } else {
        // Keyword-based topic search
        instructions = getInstructions(args.topic as string | undefined);
      }
      if (instructions.length === 0) return "No instructions found.";
      return instructions.map(formatNode).join("\n");
    }

    case "store_memory": {
      let nodeType = args.type as string | undefined;
      const content = (args.content as string || "").trim();
      // Auto-remap subtypes the LLM sends as type
      const subtypeToType: Record<string, string> = {
        tool_usage: "instruction", process: "instruction",
        preference: "opinion", rule: "instruction",
        scheduled: "plan", intended: "plan", requested: "plan",
      };
      if (nodeType && subtypeToType[nodeType]) {
        args.subtype = args.subtype || nodeType;
        nodeType = subtypeToType[nodeType];
      }
      const validTypes = ["entity", "fact", "event", "opinion", "instruction", "plan"];
      if (!nodeType || !validTypes.includes(nodeType))
        return `Error: type must be one of: ${validTypes.join(", ")}. Got: ${JSON.stringify(nodeType)}`;
      if (!content)
        return "Error: content is required and must be non-empty.";
      // Reject garbled LLM output
      const stripped = content.replace(/[.\s]/g, "");
      if (stripped.length < content.length * 0.3)
        return `Error: content looks garbled (too much padding/ellipsis). Got: "${content.slice(0, 80)}"`;
      // Reject repeated word patterns (e.g. "the the the the")
      const words = content.split(/\s+/);
      if (words.length >= 4) {
        const wordCounts = new Map<string, number>();
        for (const w of words) wordCounts.set(w.toLowerCase(), (wordCounts.get(w.toLowerCase()) ?? 0) + 1);
        const maxRepeat = Math.max(...wordCounts.values());
        if (maxRepeat > words.length * 0.5)
          return `Error: content has excessive word repetition. Got: "${content.slice(0, 80)}"`;
      }
      // Reject content that's too short to be meaningful (entities/opinions exempt)
      if (content.length < 10 && !["entity"].includes(nodeType))
        return `Error: content too short to be meaningful (${content.length} chars). Got: "${content}"`;
      // Validate scope is 0-1 for instructions/plans
      if (args.scope != null) {
        const scope = args.scope as number;
        if (typeof scope !== "number" || scope < 0 || scope > 1)
          return `Error: scope must be between 0 and 1. Got: ${scope}`;
      }
      // Validate valid_from is a valid ISO date for plans
      if (nodeType === "plan" && args.valid_from) {
        const vf = args.valid_from as string;
        if (!/^\d{4}-\d{2}-\d{2}/.test(vf) || isNaN(new Date(vf).getTime()))
          return `Error: valid_from must be a valid ISO date (YYYY-MM-DD). Got: "${vf}"`;
      }
      // Dedup entity_ids
      const rawEntityIds = (args.entity_ids as string[]) ?? [];
      const dedupedEntityIds = [...new Set(rawEntityIds)];
      const nodeId = createNode({
        node_type: nodeType as MemoryNode["node_type"],
        subtype: args.subtype as string | undefined,
        content,
        salience: (args.salience as number) ?? 1.0,
        confidence: 1.0,
        source: (args.source as "user" | "claude") ?? "user",
        attributes: {},
        scope: args.scope as number | undefined,
        valid_from: args.valid_from as string | undefined,
      });
      // Create edges to entities (using deduped IDs)
      const edgeType = (args.edge_type as string) ?? "about";
      for (const eid of dedupedEntityIds) {
        createEdge({
          source_id: nodeId,
          target_id: eid,
          edge_type: edgeType,
        });
      }
      // Create see_also edges to related memories
      const relatedIds = (args.related_ids as string[]) ?? [];
      for (const rid of relatedIds) {
        createEdge({
          source_id: nodeId,
          target_id: rid,
          edge_type: "see_also",
        });
      }
      // Generate and store embedding
      const vec = (await embed([args.content as string]))[0];
      storeEmbedding(nodeId, nodeType, vec);

      const links = relatedIds.length > 0 ? ` [see_also: ${relatedIds.join(", ")}]` : "";
      logToDevMode(`STORED ${nodeType}/${args.subtype ?? "none"} (id: ${nodeId}, salience: ${(args.salience as number) ?? 1.0}) → "${content.slice(0, 120)}"${links}`);
      return `Stored memory ${nodeId} (${nodeType}/${args.subtype ?? "none"})${links}`;
    }

    case "supersede_memory": {
      const newContent = (args.new_content as string || "").trim();
      if (!newContent) return "Error: new_content is required and must be non-empty.";
      const newId = supersedeNode(
        args.old_id as string,
        newContent
      );
      // Update embedding with actual node type (not hardcoded "fact")
      const newNode = getNode(newId);
      const vec = (await embed([newContent]))[0];
      storeEmbedding(newId, newNode!.node_type, vec);
      logToDevMode(`SUPERSEDED ${args.old_id} → ${newId} → "${newContent.slice(0, 120)}"`);
      return `Superseded ${args.old_id} → ${newId}`;
    }

    case "done": {
      return "";
    }

    default:
      return `Unknown tool: ${name}`;
  }
}
