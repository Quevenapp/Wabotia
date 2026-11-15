-- Suporte pago (módulo "suporte", docs/SUPORTE.md): conversa de liberação do
-- atendimento humano, compras de suporte avulso e liberações registradas.
-- Depende da Mensalidade para identificar o pagador e vender planos mensais.

-- Uma conversa de liberação por vez em cada conversa do WhatsApp.
CREATE TABLE IF NOT EXISTS suporte_sessions (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  -- active | released | awaiting_team | closed
  status TEXT NOT NULL DEFAULT 'active',
  -- ask_document | ask_name | choose_offer | choose_method | pay_installment | awaiting_payment
  step TEXT NOT NULL,
  -- Por que pedimos o documento: identify (achar o pagador) | purchase (comprar)
  purpose TEXT NOT NULL DEFAULT 'identify',
  attempts INTEGER NOT NULL DEFAULT 0,
  payer_id TEXT,
  -- phone | document
  matched_by TEXT,
  phone_linked INTEGER,
  document TEXT,
  name TEXT,
  -- package | plan | installment
  offer_kind TEXT,
  offer_ref TEXT,
  method TEXT,
  purchase_id TEXT,
  installment_id TEXT,
  -- Opções numeradas mostradas por último (linha QR): [{id,title}]
  options TEXT NOT NULL DEFAULT '[]',
  release_id TEXT,
  expires_at INTEGER NOT NULL,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS suporte_sessions_conversation ON suporte_sessions(conversation_id, status, updated);
CREATE INDEX IF NOT EXISTS suporte_sessions_installment ON suporte_sessions(installment_id, status);

-- Suporte avulso comprado pela conversa.
CREATE TABLE IF NOT EXISTS suporte_purchases (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  session_id TEXT,
  payer_id TEXT,
  document TEXT,
  name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  package_id TEXT NOT NULL,
  package_name TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  -- ticket (até o protocolo fechar) | hours
  mode TEXT NOT NULL,
  hours INTEGER,
  method TEXT NOT NULL,
  payment_id TEXT,
  pix_code TEXT,
  pay_url TEXT,
  payment_expires_at INTEGER,
  -- pending | paid | expired | cancelled | refunded
  status TEXT NOT NULL DEFAULT 'pending',
  paid_at INTEGER,
  source_key TEXT UNIQUE,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS suporte_purchases_profile ON suporte_purchases(profile_id, status, created);
CREATE INDEX IF NOT EXISTS suporte_purchases_payment ON suporte_purchases(payment_id);

-- Quem foi liberado para o atendimento humano, como, por qual pagador e até quando.
CREATE TABLE IF NOT EXISTS suporte_releases (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  session_id TEXT,
  phone TEXT NOT NULL DEFAULT '',
  payer_id TEXT,
  payer_name TEXT NOT NULL DEFAULT '',
  -- subscription | installment | package | courtesy | team
  kind TEXT NOT NULL,
  ref_id TEXT,
  -- O telefone era autorizado pelo pagador (0: veio pelo documento).
  phone_linked INTEGER NOT NULL DEFAULT 1,
  -- Fim da liberação (ms); NULL com until_ticket=1: até o protocolo fechar.
  valid_until INTEGER,
  until_ticket INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  actor TEXT NOT NULL,
  -- active | ended
  status TEXT NOT NULL DEFAULT 'active',
  ended_at INTEGER,
  ended_by TEXT,
  source_key TEXT UNIQUE,
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS suporte_releases_conversation ON suporte_releases(conversation_id, status, created);
CREATE INDEX IF NOT EXISTS suporte_releases_profile ON suporte_releases(profile_id, created);
