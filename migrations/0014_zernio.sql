-- Keep historical router rows and identifiers; only new accounts use Zernio.
ALTER TABLE meta_accounts ADD COLUMN provider TEXT NOT NULL DEFAULT 'meta';
ALTER TABLE meta_accounts ADD COLUMN zernio_profile_id TEXT;
CREATE UNIQUE INDEX zernio_workspace_profile ON meta_accounts(zernio_profile_id) WHERE provider='zernio';
CREATE TABLE zernio_conversations(
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  PRIMARY KEY(connection_id,external_id),
  UNIQUE(connection_id,conversation_id)
);
-- Credentials cannot be translated to a different provider. Reconnect explicitly.
UPDATE connections SET status='paused',config=json_set(config,'$.migration_required','zernio') WHERE kind='meta';
UPDATE outbox SET status='cancelled',error='Integração direta Meta removida. Reconecte o telefone pela Zernio.' WHERE connection_id IN (SELECT id FROM connections WHERE kind='meta') AND status='pending';
