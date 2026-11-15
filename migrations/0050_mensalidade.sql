-- Mensalidade (módulo "mensalidade", docs/MENSALIDADE.md): planos, assinaturas
-- e parcelas. Valores em centavos inteiros; datas de vencimento AAAA-MM-DD no
-- horário de Brasília.

CREATE TABLE IF NOT EXISTS mensalidade_plans (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  name TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  -- monthly | quarterly | yearly
  period TEXT NOT NULL DEFAULT 'monthly',
  -- Dia de vencimento padrão (1 a 31; no mês curto vale o último dia).
  due_day INTEGER NOT NULL DEFAULT 10,
  active INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mensalidade_plans_profile ON mensalidade_plans(profile_id, active, name);

CREATE TABLE IF NOT EXISTS mensalidade_subscriptions (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  contact_id TEXT,
  conversation_id TEXT,
  customer_name TEXT NOT NULL DEFAULT '',
  -- Só dígitos, com DDI (5511999998888): liga a assinatura à conversa.
  phone TEXT NOT NULL DEFAULT '',
  -- Periodicidade copiada do plano na criação.
  period TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  discount_cents INTEGER NOT NULL DEFAULT 0,
  due_day INTEGER NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT,
  -- active | paused | ended
  status TEXT NOT NULL DEFAULT 'active',
  -- Primeira data que ainda gera parcela (sobe ao retomar uma pausa).
  bill_from TEXT NOT NULL,
  -- Horizonte (AAAA-MM-DD) até onde as parcelas já foram conferidas.
  checked_until TEXT,
  notes TEXT NOT NULL DEFAULT '',
  paused_at INTEGER,
  ended_at INTEGER,
  created_by TEXT NOT NULL,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mensalidade_subscriptions_status ON mensalidade_subscriptions(profile_id, status, checked_until);
CREATE INDEX IF NOT EXISTS mensalidade_subscriptions_phone ON mensalidade_subscriptions(profile_id, phone);
CREATE INDEX IF NOT EXISTS mensalidade_subscriptions_conversation ON mensalidade_subscriptions(conversation_id);

CREATE TABLE IF NOT EXISTS mensalidade_installments (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  -- Mês de competência (AAAA-MM): uma parcela por período, sem repetição.
  period_key TEXT NOT NULL,
  due_date TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  -- open | paid | overdue | cancelled | waived
  status TEXT NOT NULL DEFAULT 'open',
  -- Cobrança do núcleo (tabela payments) em uso e o que o cliente recebeu.
  payment_id TEXT,
  payment_status TEXT,
  payment_expires_at INTEGER,
  pix_code TEXT,
  pay_url TEXT,
  -- Sobe a cada nova cobrança da parcela (chave de idempotência).
  charge_seq INTEGER NOT NULL DEFAULT 0,
  charged_at INTEGER,
  -- Avisos: antes do vencimento, no dia, e de atraso (com limite).
  notice_before_at INTEGER,
  notice_due_at INTEGER,
  overdue_notices INTEGER NOT NULL DEFAULT 0,
  overdue_notice_at INTEGER,
  notice_error TEXT,
  -- Baixa: provider (webhook) ou manual (pessoa), por quem e quando.
  paid_at INTEGER,
  paid_via TEXT,
  paid_by TEXT,
  paid_note TEXT NOT NULL DEFAULT '',
  waived_at INTEGER,
  waived_by TEXT,
  cancelled_at INTEGER,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  UNIQUE (subscription_id, period_key)
);
CREATE INDEX IF NOT EXISTS mensalidade_installments_due ON mensalidade_installments(profile_id, status, due_date);
CREATE INDEX IF NOT EXISTS mensalidade_installments_subscription ON mensalidade_installments(subscription_id, due_date);
CREATE INDEX IF NOT EXISTS mensalidade_installments_payment ON mensalidade_installments(payment_id);

-- Marcas por área (último aviso ao administrador sobre a cobrança, etc.).
CREATE TABLE IF NOT EXISTS mensalidade_flags (
  profile_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT,
  updated INTEGER NOT NULL,
  PRIMARY KEY (profile_id, key)
);

-- Escolha pendente no chat (lista numerada na linha QR): expira sozinha.
CREATE TABLE IF NOT EXISTS mensalidade_prompts (
  conversation_id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  options TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created INTEGER NOT NULL
);
