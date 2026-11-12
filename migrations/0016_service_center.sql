-- Additive: existing conversations, protocols and settings are preserved.
ALTER TABLE tickets ADD COLUMN category TEXT;
ALTER TABLE tickets ADD COLUMN source_key TEXT;
ALTER TABLE conversations ADD COLUMN ticket_prompt_expires_at INTEGER;
ALTER TABLE conversations ADD COLUMN ticket_prompt_category TEXT;
ALTER TABLE conversations ADD COLUMN ticket_prompt_session TEXT;
ALTER TABLE conversations ADD COLUMN ticket_prompt_source TEXT;
CREATE UNIQUE INDEX tickets_source ON tickets(source_key) WHERE source_key IS NOT NULL;
CREATE INDEX tickets_conversation ON tickets(conversation_id,status);
CREATE INDEX tickets_profile_status ON tickets(profile_id,status,response_due_at);
CREATE INDEX tickets_profile_category ON tickets(profile_id,category);
