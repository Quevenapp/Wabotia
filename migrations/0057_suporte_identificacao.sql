-- Suporte pago: identificação sem vincular telefone a partir de documento
-- digitado (docs/SUPORTE.md, "Identificação").
-- Contratação de plano pendente (mensalidade_contracts) da sessão.
ALTER TABLE suporte_sessions ADD COLUMN contract_id TEXT;
CREATE INDEX IF NOT EXISTS suporte_sessions_contract ON suporte_sessions(contract_id, status);
CREATE INDEX IF NOT EXISTS suporte_sessions_awaiting ON suporte_sessions(profile_id, status, updated);

-- CPF/CNPJ digitados por telefone, para o limite diário (um telefone não
-- consulta documentos à vontade). document vazio: tentativa inválida.
CREATE TABLE IF NOT EXISTS suporte_lookups (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  phone TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  document TEXT NOT NULL DEFAULT '',
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS suporte_lookups_phone ON suporte_lookups(profile_id, phone, created);
