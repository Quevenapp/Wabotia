-- Cadastro de clientes: consentimento, auditoria de revelação, pedidos de
-- exclusão (LGPD) e guarda das notas fiscais (docs/CLIENTES.md).

-- Consentimento do cadastro (finalidade "cadastro"), com a evidência do
-- aceite: passo web, conversa, versão e hash do texto aceito. Fica como
-- prova (LGPD, art. 8º, § 2º) mesmo depois da exclusão, sem dado pessoal.
CREATE TABLE IF NOT EXISTS clientes_consents (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'cadastro',
  -- granted | revoked
  status TEXT NOT NULL,
  -- web_step | panel | whatsapp
  source TEXT NOT NULL,
  terms_version TEXT NOT NULL DEFAULT '',
  terms_hash TEXT NOT NULL DEFAULT '',
  evidence TEXT NOT NULL DEFAULT '{}',
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS clientes_consents_customer ON clientes_consents(customer_id, created);

-- Quem viu o dado sem máscara, quando e por quê (revelar, emitir nota).
CREATE TABLE IF NOT EXISTS clientes_access_log (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  -- reveal | fiscal
  action TEXT NOT NULL,
  fields TEXT NOT NULL DEFAULT '[]',
  reason TEXT NOT NULL,
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS clientes_access_customer ON clientes_access_log(customer_id, created);
CREATE INDEX IF NOT EXISTS clientes_access_profile ON clientes_access_log(profile_id, created);

-- Pedidos de exclusão. Sem dado pessoal: só ids, canais, datas e o resumo
-- por módulo. Ficam como registro do atendimento ao direito do titular.
CREATE TABLE IF NOT EXISTS clientes_erasures (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  -- awaiting_confirmation | processing | done | cancelled | expired
  status TEXT NOT NULL,
  -- whatsapp | menu | link | panel
  requested_via TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  conversation_id TEXT,
  web_step_id TEXT,
  -- button | text | link (como o titular confirmou)
  confirmed_via TEXT,
  confirmed_at INTEGER,
  expires_at INTEGER NOT NULL,
  -- Conversas e protocolos guardados como vínculo (ids), resumo por módulo.
  conversation_ids TEXT NOT NULL DEFAULT '[]',
  ticket_ids TEXT NOT NULL DEFAULT '[]',
  modules TEXT NOT NULL DEFAULT '{}',
  core TEXT,
  fiscal_documents INTEGER NOT NULL DEFAULT 0,
  fiscal_retention_until INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  completed_at INTEGER,
  source_key TEXT UNIQUE,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS clientes_erasures_customer ON clientes_erasures(customer_id, created);
CREATE INDEX IF NOT EXISTS clientes_erasures_open ON clientes_erasures(profile_id, status, updated);

-- Notas fiscais emitidas para a ficha (vínculo informado por quem emite:
-- Vendas, NFapi, integração). O documento em si fica com o emissor.
CREATE TABLE IF NOT EXISTS clientes_fiscal_documents (
  profile_id TEXT NOT NULL,
  module_id TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  -- nfe | nfce | nfse
  model TEXT NOT NULL,
  series TEXT NOT NULL DEFAULT '',
  number TEXT NOT NULL DEFAULT '',
  access_key TEXT NOT NULL DEFAULT '',
  issued_at INTEGER NOT NULL,
  retain_until INTEGER NOT NULL,
  created INTEGER NOT NULL,
  PRIMARY KEY (profile_id, module_id, ref_id)
);
CREATE INDEX IF NOT EXISTS clientes_fiscal_customer ON clientes_fiscal_documents(customer_id, issued_at);

-- Guarda fiscal depois da exclusão: os dados de destinatário exigidos pelas
-- notas emitidas, cifrados (MASTER_KEY), fora da ficha e da tela da equipe.
-- Somem sozinhos em retain_until.
CREATE TABLE IF NOT EXISTS clientes_fiscal_holds (
  customer_id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  sealed TEXT NOT NULL,
  retain_until INTEGER NOT NULL,
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS clientes_fiscal_holds_due ON clientes_fiscal_holds(retain_until);
