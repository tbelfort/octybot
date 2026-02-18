-- Add project/bot scoping to conversations
ALTER TABLE conversations ADD COLUMN project_name TEXT DEFAULT 'default';
ALTER TABLE conversations ADD COLUMN bot_name TEXT DEFAULT 'default';
CREATE INDEX IF NOT EXISTS idx_conv_project ON conversations(project_name);
