-- Pedido de aprovação à equipe originado numa conversa de cliente
-- (src/approvals.ts, docs/API.md "Pedidos de aprovação"). O cartão
-- (`fields`) é montado pelo módulo com dados lidos por código e fica guardado
-- como foi mostrado; a decisão guarda quem, quando e o valor.
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  module_id TEXT NOT NULL,
  -- Tipo dentro do módulo ("desconto", "dispensa").
  kind TEXT NOT NULL,
  -- Registro do módulo (pedido, parcela).
  ref_id TEXT,
  -- Conversa do cliente que pediu.
  conversation_id TEXT NOT NULL,
  -- Execução e bot que registraram o pedido, quando houver.
  run_id TEXT,
  bot_id TEXT,
  title TEXT NOT NULL,
  -- [{key,label,value,restricted?}] como o cartão mostrou.
  fields TEXT NOT NULL DEFAULT '[]',
  -- Quem decide: {admin?, access?, role?}.
  approvers TEXT NOT NULL DEFAULT '{}',
  -- Ajuste opcional ao aprovar: {label,type,min?,max?}.
  adjust TEXT,
  -- Resumo escrito pelo bot, mostrado à parte como não verificado.
  model_summary TEXT,
  -- pending | deciding | approved | declined | handoff | expired
  status TEXT NOT NULL DEFAULT 'pending',
  value REAL,
  reason TEXT,
  decided_by TEXT,
  decided_at INTEGER,
  expires_at INTEGER NOT NULL,
  source_key TEXT UNIQUE,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS approvals_open ON approvals(profile_id, status, expires_at);
CREATE INDEX IF NOT EXISTS approvals_conversation ON approvals(conversation_id, created);
