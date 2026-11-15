-- Pedido: pedidos, histórico e a pergunta aberta no WhatsApp.

-- Numeração sequencial por área. O número sai de um único UPSERT com
-- RETURNING, então pedidos simultâneos nunca recebem o mesmo número.
CREATE TABLE IF NOT EXISTS pedido_counters (
  profile_id TEXT PRIMARY KEY,
  last INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pedido_orders (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  -- awaiting_payment | received | preparing | ready | out_for_delivery | delivered | cancelled
  status TEXT NOT NULL,
  -- Quando entrou no estado atual (quadro da cozinha e alertas).
  status_at INTEGER NOT NULL,
  conversation_id TEXT,
  contact_id TEXT,
  customer_name TEXT NOT NULL DEFAULT '',
  -- Só dígitos, com DDI.
  phone TEXT NOT NULL DEFAULT '',
  -- cart (página do carrinho) | catalog (carrinho do catálogo da Meta) | panel | api
  source TEXT NOT NULL,
  source_key TEXT UNIQUE,
  web_step_id TEXT,
  -- Linhas como o cliente confirmou, em JSON: [{item_id, slot, name,
  -- quantity, unit_cents, options:[{group_id, group, id, name, price_cents}],
  -- note, total_cents}]. Valores em centavos.
  lines TEXT NOT NULL,
  item_count INTEGER NOT NULL,
  subtotal_cents INTEGER NOT NULL,
  delivery_fee_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL,
  -- pickup | delivery
  fulfillment TEXT NOT NULL,
  -- Entrega: JSON {street, district, complement, reference}.
  address TEXT,
  -- Observação do cliente (vai para a comanda).
  note TEXT NOT NULL DEFAULT '',
  -- Observações internas da equipe (não vão ao cliente).
  notes TEXT NOT NULL DEFAULT '',
  eta_minutes INTEGER,
  -- pix | link | cash | card; NULL enquanto o cliente escolhe.
  payment_method TEXT,
  -- choosing | pending (na entrega ou retirada) | awaiting (cobrança aberta)
  -- | paid | expired | failed | refunded | cancelled
  payment_status TEXT NOT NULL,
  -- Cobrança do núcleo (payments.id) do pagamento online.
  payment_id TEXT,
  payment_due_at INTEGER,
  payment_error TEXT,
  paid_at INTEGER,
  -- provider (webhook confirmado) ou quem deu baixa (pessoa ou aplicação).
  paid_by TEXT,
  change_for_cents INTEGER,
  -- Pago depois de cancelado: estornar pelo painel do provedor.
  needs_refund INTEGER NOT NULL DEFAULT 0,
  cancel_reason TEXT,
  cancelled_by TEXT,
  -- Alerta de pedido parado já dado para o estado atual.
  stale_notified_at INTEGER,
  confirmed_at INTEGER,
  preparing_at INTEGER,
  ready_at INTEGER,
  dispatched_at INTEGER,
  delivered_at INTEGER,
  cancelled_at INTEGER,
  created_by TEXT NOT NULL,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  UNIQUE (profile_id, number)
);
CREATE INDEX IF NOT EXISTS pedido_orders_status ON pedido_orders(profile_id, status, status_at);
CREATE INDEX IF NOT EXISTS pedido_orders_conversation ON pedido_orders(conversation_id, status);
CREATE INDEX IF NOT EXISTS pedido_orders_phone ON pedido_orders(profile_id, phone);
CREATE INDEX IF NOT EXISTS pedido_orders_payment ON pedido_orders(payment_id);
CREATE INDEX IF NOT EXISTS pedido_orders_created ON pedido_orders(profile_id, created);

-- Histórico: quem mudou o estado ou o pagamento, e quando.
CREATE TABLE IF NOT EXISTS pedido_history (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  -- created | status | payment | edit
  kind TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  actor TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pedido_history_order ON pedido_history(order_id, created);

-- Pergunta aberta no WhatsApp (uma por conversa): forma de pagamento,
-- troco, ou retirada/entrega e endereço do carrinho do catálogo da Meta.
CREATE TABLE IF NOT EXISTS pedido_chats (
  conversation_id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  -- payment | change | fulfillment | address
  step TEXT NOT NULL,
  order_id TEXT,
  -- Rascunho do carrinho do catálogo (linhas, valores) e opções mostradas.
  data TEXT NOT NULL DEFAULT '{}',
  expires_at INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
