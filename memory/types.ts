// Node types
export type NodeType = "entity" | "fact" | "event" | "opinion";
export type EntityType =
  | "person"
  | "org"
  | "project"
  | "place"
  | "tool"
  | "process"
  | "document"
  | "concept"
  | "event"
  | "account";
export type FactSubtype =
  | "definitional"
  | "causal"
  | "conditional"
  | "comparative"
  | "negation"
  | "instruction"
  | "tool_usage";
export type EventSubtype =
  | "action"
  | "decision"
  | "conversation"
  | "incident"
  | "outcome";

export interface MemoryNode {
  id: string;
  node_type: NodeType;
  subtype?: string;
  content: string;
  salience: number; // Importance multiplier. Base 1.0, higher = more important
  confidence: number; // 0-1
  source: "user" | "claude";
  created_at: string;
  valid_from?: string;
  valid_until?: string;
  superseded_by?: string;
  attributes: Record<string, unknown>;
  can_summarize?: number;
}

export interface Edge {
  id: string;
  source_id: string;
  target_id: string;
  edge_type: string; // "works_for", "works_on", etc.
  attributes?: Record<string, unknown>;
  created_at?: string;
}

// Layer 1 output
export type Intent =
  | "action"
  | "information"
  | "status"
  | "process"
  | "recall"
  | "comparison"
  | "verification"
  | "instruction"
  | "correction"
  | "opinion"
  | "planning"
  | "delegation";

export interface Layer1Result {
  entities: { name: string; type: EntityType; ambiguous: boolean }[];
  implied_facts: string[];
  events: string[];
  opinions: string[];
  concepts: string[];
  implied_processes: string[];
  intents: Intent[];
  operations: { retrieve: boolean; store: boolean };
}

// Layer 2 tools
export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}
export interface ToolResult {
  name: string;
  result: unknown;
}

export interface ToolTurn {
  tool_call: ToolCall;
  result: ToolResult;
  reasoning?: string;           // L2's response.content before this tool call
  _pipeline?: "retrieve" | "store";
}

// Debug trace
export interface PipelineTrace {
  timestamp: string;
  prompt: string;
  layer1: Layer1Result;
  layer1_raw?: string;           // Raw LLM response text from L1
  layer1_5_plan?: string;        // L1.5 search strategy reasoning
  layer2_turns: ToolTurn[];
  final_context: string;
  duration_ms: number;
  timing?: {
    layer1_ms: number;
    layer1_5_ms?: number;
    layer2_ms: number;
  };
}

// Message types for Workers AI
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: WorkersAIToolCall[];
  tool_call_id?: string;
}

export interface WorkersAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}
