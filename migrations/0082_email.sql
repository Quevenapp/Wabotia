-- Envio de e-mail pelo Cloudflare Email Sending (src/email.ts, docs/EMAIL.md).
-- Registro de cada envio: sem o corpo e sem o endereço inteiro (só mascarado
-- e o hash, para conferir). `key` torna o envio de um módulo idempotente na
-- área.
CREATE TABLE email_log (
  id TEXT PRIMARY KEY,
  profile_id TEXT,
  module_id TEXT,
  user_id TEXT,
  purpose TEXT NOT NULL,
  to_masked TEXT NOT NULL,
  to_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  error_code TEXT,
  key TEXT,
  created INTEGER NOT NULL
);
CREATE UNIQUE INDEX email_log_key ON email_log(profile_id, key)
WHERE
  key IS NOT NULL;
CREATE INDEX email_log_created ON email_log(created);
CREATE INDEX email_log_profile ON email_log(profile_id, created);
