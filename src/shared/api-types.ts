/**
 * Shared API types between worker (producer) and agent/PWA (consumer).
 *
 * These interfaces describe the JSON shapes returned by worker routes
 * and consumed by the agent's polling/fetch logic and the PWA.
 */

/** GET /messages/pending — a message waiting for the agent to process */
export interface PendingMessage {
  message_id: string;
  conversation_id: string;
  user_content: string;
  claude_session_id: string | null;
  model: string;
}

/** GET /conversations/process/stop-requests */
export interface StopRequestsResponse {
  conversation_ids: string[];
}

/** GET /settings */
export interface SettingsResponse {
  settings: Record<string, string>;
}

/** GET /projects — individual project entry */
export interface ProjectEntry {
  name: string;
  config?: Record<string, unknown>;
}

/** GET /projects */
export interface ProjectsResponse {
  projects: ProjectEntry[];
}

/** GET /memory/commands/pending — a command waiting for the agent to execute */
export interface PendingMemoryCommand {
  id: string;
  command: string;
  args: Record<string, unknown> | null;
}

// ── PWA-facing types ──

/** A conversation as returned by GET /conversations */
export interface Conversation {
  id: string;
  title: string;
  project_name: string;
  agent_name: string;
  process_status?: string;
  created_at: string;
  updated_at: string;
}

/** A message as returned by GET /conversations/:id */
export interface Message {
  role: "user" | "assistant";
  content: string;
  status?: string;
}

/** GET /conversations */
export interface ConversationsResponse {
  conversations: Conversation[];
}

/** GET /conversations/:id */
export interface ConversationDetailResponse {
  messages: Message[];
}

/** POST /conversations/:id/messages */
export interface SendMessageResponse {
  assistant_message_id: string;
}

/** A usage row from GET /usage/daily or /usage/monthly */
export interface UsageRow {
  date?: string;
  month?: string;
  category: string;
  cost_usd: number;
}

/** GET /usage/daily or /usage/monthly */
export interface UsageResponse {
  rows: UsageRow[];
}

/** Agent entry from GET /projects/:name/agents */
export interface AgentEntry {
  agent_name: string;
}
