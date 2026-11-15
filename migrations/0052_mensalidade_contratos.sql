-- Contratação de plano pelo WhatsApp (docs/MENSALIDADE.md, "Contratar pelo
-- WhatsApp"): o contrato pendente guarda o plano, quem paga e a cobrança.
-- Pagador, assinatura e primeira parcela só nascem com o pagamento confirmado
-- pelo provedor; nenhum telefone é vinculado a partir de documento digitado.
CREATE TABLE IF NOT EXISTS mensalidade_contracts (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  plan_name TEXT NOT NULL DEFAULT '',
  conversation_id TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  -- Pagador cujo telefone autorizado é o da conversa (já cadastrado), ou o
  -- criado/achado no pagamento.
  payer_id TEXT,
  -- 0: no pagamento o documento já era de outro pagador; o telefone não foi
  -- vinculado (a equipe confirma).
  payer_linked INTEGER NOT NULL DEFAULT 1,
  document TEXT,
  document_type TEXT,
  name TEXT NOT NULL DEFAULT '',
  amount_cents INTEGER NOT NULL,
  method TEXT NOT NULL DEFAULT 'pix',
  payment_id TEXT,
  payment_status TEXT,
  payment_expires_at INTEGER,
  pix_code TEXT,
  pay_url TEXT,
  charge_seq INTEGER NOT NULL DEFAULT 0,
  -- pending | paid | expired | cancelled
  status TEXT NOT NULL DEFAULT 'pending',
  subscription_id TEXT,
  installment_id TEXT,
  paid_at INTEGER,
  actor TEXT NOT NULL,
  source_key TEXT UNIQUE,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mensalidade_contracts_profile ON mensalidade_contracts(profile_id, status, created);
CREATE INDEX IF NOT EXISTS mensalidade_contracts_conversation ON mensalidade_contracts(conversation_id, status);
