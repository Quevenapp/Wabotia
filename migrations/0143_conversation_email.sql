ALTER TABLE email_log ADD COLUMN conversation_id TEXT;
ALTER TABLE email_log ADD COLUMN request_hash TEXT;
ALTER TABLE email_log ADD COLUMN provider_message_id TEXT;

CREATE INDEX email_log_transcript_quota
  ON email_log(profile_id,purpose,created,user_id);

CREATE INDEX email_log_conversation
  ON email_log(profile_id,conversation_id,created);
