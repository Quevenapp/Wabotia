-- Cobrança no núcleo (docs/COBRANCA.md). Uma conta de provedor por área; as
-- credenciais ficam cifradas em secrets ("payment-account:<id>").
CREATE TABLE IF NOT EXISTS payment_accounts (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  -- E-mail do pagador quando o contato não tem um (o Pix do Mercado Pago exige).
  payer_email TEXT NOT NULL DEFAULT '',
  -- Conta do provedor confirmada no último teste (nome, id), sem segredos.
  checked TEXT,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
-- Cobrança ligada a uma conversa e, quando houver, a um registro de módulo.
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  -- pix | link
  method TEXT NOT NULL,
  module_id TEXT,
  ref_id TEXT,
  description TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'BRL',
  -- created | paid | expired | cancelled | refunded
  status TEXT NOT NULL DEFAULT 'created',
  -- Pix: id do pagamento no provedor; link: id da preferência.
  provider_ref TEXT,
  -- Pagamento confirmado no provedor (também no link de pagamento).
  provider_payment_id TEXT,
  provider_status TEXT,
  pix_code TEXT,
  pix_qr TEXT,
  url TEXT,
  trigger TEXT NOT NULL,
  actor TEXT NOT NULL,
  source_key TEXT UNIQUE,
  expires_at INTEGER NOT NULL,
  paid_at INTEGER,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS payments_conversation ON payments(conversation_id, created);
CREATE INDEX IF NOT EXISTS payments_open ON payments(profile_id, status, expires_at);
CREATE INDEX IF NOT EXISTS payments_module ON payments(module_id, ref_id);
