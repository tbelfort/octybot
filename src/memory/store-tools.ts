/**
 * Storage tool definitions and handler.
 * Extracted from tools.ts.
 */

import type { Database } from "bun:sqlite";
import { createNode, createEdge, supersedeNode, getNode } from "./db-crud";
import { storeEmbedding } from "./vectors";
import { embed } from "./voyage";
import { formatNode, logToDevMode } from "./format";
import type { ToolDefinition, MemoryNode } from "./types";

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
            enum: ["entity", "fact", "event", "opinion", "instruction"],
            description: "Node type. Use 'instruction' for rules, procedures, tool usage guides, and behavioral instructions.",
          },
          subtype: {
            type: "string",
            description:
              'Optional classifier within the type. For entities: "person", "org", "tool". For instructions: "rule", "tool_usage", "process". For events: "action".',
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
          scope: {
            type: "number",
            description:
              "For instructions: how broadly this applies. 1.0 = universal rule (e.g. 'Always check Originality.ai'). 0.5 = tool/team-wide (e.g. 'Airtable lookup process'). 0.2 = entity-specific (e.g. 'Brightwell needs ContentShake'). Default: 0.5.",
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

export async function handleStoreToolCall(
  db: Database,
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  switch (name) {
    case "store_memory": {
      let nodeType = args.type as string | undefined;
      const content = (args.content as string || "").trim();
      const subtypeToType: Record<string, string> = {
        tool_usage: "instruction", process: "instruction",
        preference: "opinion", rule: "instruction",
      };
      if (nodeType && subtypeToType[nodeType]) {
        args.subtype = args.subtype || nodeType;
        nodeType = subtypeToType[nodeType];
      }
      const validTypes = ["entity", "fact", "event", "opinion", "instruction"];
      if (!nodeType || !validTypes.includes(nodeType))
        return `Error: type must be one of: ${validTypes.join(", ")}. Got: ${JSON.stringify(nodeType)}`;
      if (!content)
        return "Error: content is required and must be non-empty.";
      const nodeId = createNode(db, {
        node_type: nodeType as MemoryNode["node_type"],
        subtype: args.subtype as string | undefined,
        content,
        salience: (args.salience as number) ?? 1.0,
        confidence: 1.0,
        source: (args.source as "user" | "claude") ?? "user",
        attributes: {},
        scope: args.scope as number | undefined,
      });
      const entityIds = (args.entity_ids as string[]) ?? [];
      const edgeType = (args.edge_type as string) ?? "about";
      for (const eid of entityIds) {
        createEdge(db, {
          source_id: nodeId,
          target_id: eid,
          edge_type: edgeType,
        });
      }
      const relatedIds = (args.related_ids as string[]) ?? [];
      for (const rid of relatedIds) {
        createEdge(db, {
          source_id: nodeId,
          target_id: rid,
          edge_type: "see_also",
        });
      }
      const vec = (await embed([args.content as string]))[0];
      storeEmbedding(db, nodeId, nodeType, vec);

      const links = relatedIds.length > 0 ? ` [see_also: ${relatedIds.join(", ")}]` : "";
      logToDevMode(`STORED ${nodeType}/${args.subtype ?? "none"} (id: ${nodeId}, salience: ${(args.salience as number) ?? 1.0}) → "${content.slice(0, 120)}"${links}`);
      return `Stored memory ${nodeId} (${nodeType}/${args.subtype ?? "none"})${links}`;
    }

    case "supersede_memory": {
      const newContent = (args.new_content as string || "").trim();
      if (!newContent) return "Error: new_content is required and must be non-empty.";
      const newId = supersedeNode(
        db,
        args.old_id as string,
        newContent
      );
      const newNode = getNode(db, newId);
      const vec = (await embed([newContent]))[0];
      storeEmbedding(db, newId, newNode!.node_type, vec);
      logToDevMode(`SUPERSEDED ${args.old_id} → ${newId} → "${newContent.slice(0, 120)}"`);
      return `Superseded ${args.old_id} → ${newId}`;
    }

    case "done": {
      return "";
    }

    default:
      return `Unknown store tool: ${name}`;
  }
}
