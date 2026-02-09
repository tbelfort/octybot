import {
  getRelationships,
  getFactsByEntity,
  getEventsByEntity,
  getInstructions,
  createNode,
  createEdge,
  supersedeNode,
} from "./db";
import { searchSimilar, storeEmbedding } from "./vectors";
import { embed } from "./voyage";
import type { ToolDefinition, MemoryNode } from "./types";

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
        "Find stored procedures, instructions, or tool usage guides by topic.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Topic to search for" },
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
        "Find behavioral rules and instructions, optionally filtered by topic.",
      parameters: {
        type: "object",
        properties: {
          topic: {
            type: "string",
            description: "Optional topic to filter instructions",
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
            enum: ["entity", "fact", "event", "opinion"],
            description: "Node type",
          },
          subtype: {
            type: "string",
            description:
              "Subtype (e.g. person, instruction, tool_usage, action)",
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
              "Importance multiplier. Base: 1.0. Set HIGHER (1.5-3.0) for critical rules, warnings, or information that would be damaging if not surfaced. Set LOWER (0.3-0.7) for routine observations. Default: 1.0.",
          },
          source: {
            type: "string",
            enum: ["user", "claude"],
            description: "Source attribution (default: user)",
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

// Combined (for backwards compat)
export const TOOL_DEFINITIONS: ToolDefinition[] = [...RETRIEVE_TOOLS, ...STORE_TOOLS];

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
      const name = (args.name as string || "").trim();
      if (!name) return "No entities found. Provide a non-empty name.";
      const queryVec = (await embed([name], "query"))[0];
      const hits = searchSimilar(queryVec, 5, { nodeType: "entity" });
      if (hits.length === 0) return "No entities found.";
      const { getNode } = await import("./db");
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
      // Search facts and opinions (instructions can be stored as either)
      const allResults = searchSimilar(queryVec, 10, {
        nodeIds: entityFacts,
      });
      if (allResults.length === 0) return "No matching facts found.";
      const { getNode } = await import("./db");
      const filtered = allResults
        .map((r) => ({ ...r, node: getNode(r.nodeId) }))
        .filter((r) => r.node && (r.node.node_type === "fact" || r.node.node_type === "opinion"))
        .slice(0, 5);
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
      const results = searchSimilar(queryVec, 5, {
        nodeType: "event",
        nodeIds: entityEvents,
      });
      if (results.length === 0) return "No matching events found.";
      const { getNode } = await import("./db");
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

    case "search_processes": {
      const query = (args.query as string || "").trim();
      if (!query) return "No matching processes found. Provide a non-empty query.";
      const queryVec = (await embed([query], "query"))[0];
      // Search all node types, then filter by instruction/tool_usage subtype
      const results = searchSimilar(queryVec, 10);
      if (results.length === 0) return "No matching processes found.";
      const { getNode } = await import("./db");
      const filtered = results
        .map((r) => ({ ...r, node: getNode(r.nodeId) }))
        .filter(
          (r) =>
            r.node &&
            (r.node.subtype === "instruction" || r.node.subtype === "tool_usage")
        );
      if (filtered.length === 0) return "No matching processes found.";
      return filtered
        .slice(0, 5)
        .map(
          (r) =>
            `${formatNode(r.node!)} [score: ${r.score.toFixed(3)}]`
        )
        .join("\n");
    }

    case "get_instructions": {
      const instructions = getInstructions(args.topic as string | undefined);
      if (instructions.length === 0) return "No instructions found.";
      return instructions.map(formatNode).join("\n");
    }

    case "store_memory": {
      const nodeType = args.type as string | undefined;
      const content = (args.content as string || "").trim();
      const validTypes = ["entity", "fact", "event", "opinion"];
      if (!nodeType || !validTypes.includes(nodeType))
        return `Error: type must be one of: ${validTypes.join(", ")}. Got: ${JSON.stringify(nodeType)}`;
      if (!content)
        return "Error: content is required and must be non-empty.";
      const nodeId = createNode({
        node_type: nodeType as MemoryNode["node_type"],
        subtype: args.subtype as string | undefined,
        content,
        salience: (args.salience as number) ?? 1.0,
        confidence: 1.0,
        source: (args.source as "user" | "claude") ?? "user",
        attributes: {},
      });
      // Create edges to entities
      const entityIds = (args.entity_ids as string[]) ?? [];
      const edgeType = (args.edge_type as string) ?? "about";
      for (const eid of entityIds) {
        createEdge({
          source_id: nodeId,
          target_id: eid,
          edge_type: edgeType,
        });
      }
      // Generate and store embedding
      const vec = (await embed([args.content as string]))[0];
      storeEmbedding(nodeId, args.type as string, vec);

      return `Stored memory ${nodeId} (${args.type}/${args.subtype ?? "none"})`;
    }

    case "supersede_memory": {
      const newId = supersedeNode(
        args.old_id as string,
        args.new_content as string
      );
      // Update embedding
      const vec = (await embed([args.new_content as string]))[0];
      storeEmbedding(newId, "fact", vec);
      return `Superseded ${args.old_id} → ${newId}`;
    }

    case "done": {
      return "";
    }

    default:
      return `Unknown tool: ${name}`;
  }
}
