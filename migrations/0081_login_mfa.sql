-- Login do núcleo (src/mfa.ts, src/auth-tokens.ts): segundo fator TOTP,
-- nível da sessão, links de uso único (redefinir senha, convite) e horário de
-- acesso por pessoa. Só acrescenta.
ALTER TABLE sessions ADD COLUMN id TEXT;
ALTER TABLE sessions ADD COLUMN aal INTEGER NOT NULL DEFAULT 1;
ALTER TABLE sessions ADD COLUMN mfa_at INTEGER;
CREATE UNIQUE INDEX sessions_public_id ON sessions(id) WHERE id IS NOT NULL;
CREATE INDEX sessions_user ON sessions(user_id);
-- Segredo TOTP cifrado com seal() (MASTER_KEY). pending → active.
-- last_step: último passo de 30 s aceito (o mesmo código não vale duas vezes).
CREATE TABLE user_factors(
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'totp',
  secret TEXT NOT NULL,
  status TEXT NOT NULL,
  last_step INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL,
  activated_at INTEGER
);
CREATE INDEX user_factors_user ON user_factors(user_id,status);
-- Códigos de recuperação: só o HMAC (MASTER_KEY), uso único.
CREATE TABLE user_recovery_codes(
  user_id TEXT NOT NULL,
  hash TEXT NOT NULL,
  used_at INTEGER,
  created INTEGER NOT NULL,
  PRIMARY KEY(user_id,hash)
);
-- Links de uso único: purpose reset (redefinir senha) ou invite (convite).
CREATE TABLE auth_tokens(
  hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  expires INTEGER NOT NULL,
  used_at INTEGER,
  created_by TEXT NOT NULL,
  created INTEGER NOT NULL
);
CREATE INDEX auth_tokens_user ON auth_tokens(user_id,purpose);
-- Horário de acesso (formato do Fagoo): {"enabled":true,"windows":[{"start":"08:00","end":"18:00","days":[1,2,3,4,5]}]}.
ALTER TABLE users ADD COLUMN schedule TEXT;
