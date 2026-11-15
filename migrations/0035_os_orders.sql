-- Ordem de Serviço (módulo "os", docs/ORDEM-DE-SERVICO.md). Não reutiliza os
-- protocolos (tickets): uma ordem é o serviço sobre um item do cliente, com
-- orçamento, aprovação e retirada.

-- Numeração sequencial por área. O número sai de um único UPSERT com
-- RETURNING, então pedidos simultâneos nunca recebem o mesmo número.
CREATE TABLE IF NOT EXISTS os_counters (
  profile_id TEXT PRIMARY KEY,
  last INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS os_orders (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  -- received | analyzing | quoted | approved | declined | in_progress | ready | delivered | cancelled
  status TEXT NOT NULL DEFAULT 'received',
  conversation_id TEXT,
  contact_id TEXT,
  customer_name TEXT NOT NULL DEFAULT '',
  -- Só dígitos, com DDI (5511999998888), para o acompanhamento pelo WhatsApp.
  phone TEXT NOT NULL DEFAULT '',
  item TEXT NOT NULL,
  problem TEXT NOT NULL,
  -- Observações internas: nunca vão ao cliente.
  notes TEXT NOT NULL DEFAULT '',
  assignee TEXT,
  due_at INTEGER,
  -- agent (conversa) | panel | customer (passo web) | api
  source TEXT NOT NULL,
  source_key TEXT UNIQUE,
  terms_text TEXT,
  terms_accepted_at INTEGER,
  -- Orçamento: itens em JSON [{description,quantity,unit_cents}], total em centavos.
  quote_items TEXT,
  quote_total_cents INTEGER,
  quote_note TEXT,
  quote_valid_days INTEGER,
  quote_valid_until INTEGER,
  quote_sent_at INTEGER,
  -- Sobe a cada envio: botões de um envio anterior deixam de valer.
  quote_version INTEGER NOT NULL DEFAULT 0,
  -- approved | declined, por quem (pessoa, aplicação ou customer:<telefone>) e como.
  decision TEXT,
  decided_at INTEGER,
  decided_by TEXT,
  decided_via TEXT,
  ready_at INTEGER,
  delivered_at INTEGER,
  warranty_until INTEGER,
  -- Aviso de ordem parada e lembrete de retirada já feitos para o estado atual.
  stale_notified_at INTEGER,
  pickup_reminded_at INTEGER,
  created_by TEXT NOT NULL,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  UNIQUE (profile_id, number)
);
CREATE INDEX IF NOT EXISTS os_orders_status ON os_orders(profile_id, status, updated);
CREATE INDEX IF NOT EXISTS os_orders_phone ON os_orders(profile_id, phone);
CREATE INDEX IF NOT EXISTS os_orders_conversation ON os_orders(conversation_id, status);

-- Histórico: quem mudou o estado (ou o orçamento) e quando.
CREATE TABLE IF NOT EXISTS os_history (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  -- status | quote | opened | edit
  kind TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  actor TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS os_history_order ON os_history(order_id, created);
