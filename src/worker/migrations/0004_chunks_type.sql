-- Add type column to chunks (already exists in live DB, ensures fresh deploys work)
ALTER TABLE chunks ADD COLUMN type TEXT NOT NULL DEFAULT 'text';
