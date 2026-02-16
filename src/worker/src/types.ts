export interface Env {
  DB: D1Database;
  JWT_SECRET: string;
  OPENAI_API_KEY: string;
}

export type HonoEnv = {
  Bindings: Env;
  Variables: {
    deviceId: string;
    deviceType: string;
  };
};

export interface ConversationRow {
  id: string;
  claude_session_id: string | null;
  model: string;
  title: string;
  process_status: string | null;
  process_stop_requested: number;
  created_at: string;
  updated_at: string;
}

export interface SettingsRow {
  key: string;
  value: string;
  updated_at: string;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface ChunkRow {
  id: number;
  message_id: string;
  sequence: number;
  text: string;
  is_final: number;
  created_at: string;
}
