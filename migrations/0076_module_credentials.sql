-- Credenciais de módulo trocadas por QR (src/module-credentials.ts): a loja
-- gera um QR para um registro do módulo (uma entrega), o app sem login lê e
-- recebe uma credencial que só alcança as rotas daquele módulo e daquele
-- registro, com prazo curto e revogada quando o registro termina. Só os
-- hashes do código do QR e do token ficam guardados.
CREATE TABLE module_credentials(
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  module_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  -- issued (QR gerado, ainda não lido) → active (lido) → revoked/expired.
  status TEXT NOT NULL,
  claim_hash TEXT NOT NULL UNIQUE,
  claim_expires INTEGER NOT NULL,
  token_hash TEXT UNIQUE,
  -- Validade da credencial depois da leitura (minutos) e o vencimento.
  ttl_minutes INTEGER NOT NULL,
  expires INTEGER,
  -- Quem leu: nome digitado no app, rótulo do aparelho e hash do IP.
  label TEXT NOT NULL DEFAULT '',
  device TEXT NOT NULL DEFAULT '',
  claimed_ip_hash TEXT,
  claimed_at INTEGER,
  revoked_at INTEGER,
  revoked_reason TEXT,
  created_by TEXT NOT NULL,
  created INTEGER NOT NULL
);
CREATE INDEX module_credentials_subject ON module_credentials(profile_id,module_id,subject,status);
