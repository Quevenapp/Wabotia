-- Vendas e orçamento (módulo "vendas", docs/VENDAS.md): orçamentos, vendas,
-- devoluções e documentos fiscais. As linhas guardam uma cópia do produto
-- (nome, preço, códigos e dados fiscais do momento), então o catálogo pode
-- mudar sem alterar o que já foi orçado ou vendido.

-- Numeração por área: kind = 'quote' ou 'sale'.
CREATE TABLE IF NOT EXISTS vendas_counters (
  profile_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  last INTEGER NOT NULL,
  PRIMARY KEY (profile_id, kind)
);

CREATE TABLE IF NOT EXISTS vendas_quotes (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  -- draft, sent, approved, declined, expired, converted, cancelled
  status TEXT NOT NULL,
  conversation_id TEXT,
  contact_id TEXT,
  customer_name TEXT NOT NULL DEFAULT '',
  customer_phone TEXT NOT NULL DEFAULT '',
  customer_document TEXT NOT NULL DEFAULT '',
  lines TEXT NOT NULL,
  item_count INTEGER NOT NULL DEFAULT 0,
  subtotal_cents INTEGER NOT NULL,
  discount_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL,
  valid_days INTEGER,
  valid_until INTEGER,
  -- Texto ao cliente e observações internas.
  note TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  -- Sobe a cada envio: botões e links antigos deixam de valer.
  version INTEGER NOT NULL DEFAULT 0,
  sent_at INTEGER,
  sent_via TEXT,
  web_step_id TEXT,
  decided_at INTEGER,
  decided_by TEXT,
  decided_via TEXT,
  decision_note TEXT NOT NULL DEFAULT '',
  sale_id TEXT,
  source_key TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS vendas_quotes_number ON vendas_quotes(profile_id, number);
CREATE UNIQUE INDEX IF NOT EXISTS vendas_quotes_source ON vendas_quotes(profile_id, source_key);
CREATE INDEX IF NOT EXISTS vendas_quotes_status ON vendas_quotes(profile_id, status, valid_until);
CREATE INDEX IF NOT EXISTS vendas_quotes_conversation ON vendas_quotes(profile_id, conversation_id, status);

CREATE TABLE IF NOT EXISTS vendas_sales (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  -- awaiting_payment, completed, cancelled, returned
  status TEXT NOT NULL,
  -- panel, caixa, quote, api
  source TEXT NOT NULL,
  quote_id TEXT,
  -- Sessão do Caixa em que a venda foi feita (módulo "caixa").
  session_id TEXT,
  conversation_id TEXT,
  contact_id TEXT,
  customer_name TEXT NOT NULL DEFAULT '',
  customer_phone TEXT NOT NULL DEFAULT '',
  customer_document TEXT NOT NULL DEFAULT '',
  lines TEXT NOT NULL,
  item_count INTEGER NOT NULL DEFAULT 0,
  subtotal_cents INTEGER NOT NULL,
  -- Desconto total (linhas + venda) e só o da venda.
  discount_cents INTEGER NOT NULL DEFAULT 0,
  sale_discount_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL,
  -- [{method, amount_cents}]: o que o cliente entregou em cada forma.
  payments TEXT NOT NULL DEFAULT '[]',
  paid_cents INTEGER NOT NULL DEFAULT 0,
  change_cents INTEGER NOT NULL DEFAULT 0,
  -- Cobrança do Mercado Pago (ctx.charge) quando a forma é pix ou link.
  payment_id TEXT,
  payment_status TEXT,
  -- Pix copia e cola e link da cobrança, para o caixa mostrar na tela.
  payment_pix_code TEXT,
  payment_url TEXT,
  needs_refund INTEGER NOT NULL DEFAULT 0,
  refunded_cents INTEGER NOT NULL DEFAULT 0,
  -- none, pending, authorized, error, cancelled
  fiscal_status TEXT NOT NULL DEFAULT 'none',
  note TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  source_key TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  completed_at INTEGER,
  cancelled_at INTEGER,
  cancelled_by TEXT,
  cancel_reason TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS vendas_sales_number ON vendas_sales(profile_id, number);
CREATE UNIQUE INDEX IF NOT EXISTS vendas_sales_source ON vendas_sales(profile_id, source_key);
CREATE INDEX IF NOT EXISTS vendas_sales_status ON vendas_sales(profile_id, status, created);
CREATE INDEX IF NOT EXISTS vendas_sales_session ON vendas_sales(profile_id, session_id);
CREATE INDEX IF NOT EXISTS vendas_sales_conversation ON vendas_sales(profile_id, conversation_id);
CREATE UNIQUE INDEX IF NOT EXISTS vendas_sales_quote ON vendas_sales(profile_id, quote_id) WHERE quote_id IS NOT NULL;

-- Devoluções (parciais ou totais) de vendas concluídas. Com session_id, o
-- dinheiro devolvido sai do caixa daquela sessão.
CREATE TABLE IF NOT EXISTS vendas_returns (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  sale_id TEXT NOT NULL,
  session_id TEXT,
  lines TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  method TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  source_key TEXT NOT NULL,
  actor TEXT NOT NULL,
  created INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS vendas_returns_source ON vendas_returns(profile_id, source_key);
CREATE INDEX IF NOT EXISTS vendas_returns_sale ON vendas_returns(profile_id, sale_id);
CREATE INDEX IF NOT EXISTS vendas_returns_session ON vendas_returns(profile_id, session_id);

-- Notas fiscais (NF-e modelo 55, NFC-e modelo 65). A emissão fica atrás de
-- um provedor (src/modules/vendas/fiscal.ts); nenhum está integrado ainda.
CREATE TABLE IF NOT EXISTS vendas_fiscal_documents (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  sale_id TEXT NOT NULL,
  model TEXT NOT NULL,
  environment TEXT NOT NULL,
  series INTEGER,
  number INTEGER,
  -- pending, processing, authorized, rejected, cancelled, error
  status TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_ref TEXT,
  access_key TEXT,
  protocol TEXT,
  xml_url TEXT,
  pdf_url TEXT,
  message TEXT NOT NULL DEFAULT '',
  -- Cópia do documento montado no envio (docs/VENDAS.md, "Nota fiscal").
  request TEXT NOT NULL,
  source_key TEXT NOT NULL,
  actor TEXT NOT NULL,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS vendas_fiscal_source ON vendas_fiscal_documents(profile_id, source_key);
CREATE INDEX IF NOT EXISTS vendas_fiscal_sale ON vendas_fiscal_documents(profile_id, sale_id);
