-- Mesas: mesas e comandas da área, a conta aberta de cada uma (com os
-- pedidos lançados pelo garçom, que são pedidos do Pedido ligados à conta),
-- os pagamentos da conta e o histórico.

-- Mesa ou comanda cadastrada. O estado (livre, ocupada, fechando) vem da
-- conta aberta, não daqui.
CREATE TABLE IF NOT EXISTS mesas_tables (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  name TEXT NOT NULL,
  -- table (mesa) | card (comanda individual)
  kind TEXT NOT NULL DEFAULT 'table',
  -- Ambiente: "Salão", "Varanda"...
  section TEXT NOT NULL DEFAULT '',
  seats INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS mesas_tables_name ON mesas_tables(profile_id, name);

-- Conta da mesa: aberta pelo garçom, fechada com o pagamento.
CREATE TABLE IF NOT EXISTS mesas_tabs (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  -- Número sequencial da conta na área (comprovante, busca).
  number INTEGER NOT NULL,
  table_id TEXT NOT NULL,
  -- Nome da mesa quando a conta foi lida pela última vez (a mesa pode ser
  -- apagada ou renomeada depois de fechada).
  table_name TEXT NOT NULL,
  -- open (ocupada) | closing (pediu a conta) | closed | cancelled | merged
  status TEXT NOT NULL,
  guests INTEGER NOT NULL DEFAULT 0,
  customer_name TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  -- Garçom responsável (quem abriu, ou quem assumiu).
  waiter_id TEXT,
  -- Taxa de serviço: ligada nesta conta e o percentual (em décimos de ponto
  -- percentual: 100 = 10%), copiado da configuração ao abrir.
  service INTEGER NOT NULL DEFAULT 1,
  service_permille INTEGER NOT NULL DEFAULT 0,
  -- Valores gravados ao fechar (na conta aberta, calculados na leitura).
  subtotal_cents INTEGER,
  service_cents INTEGER,
  total_cents INTEGER,
  paid_cents INTEGER,
  merged_into TEXT,
  cancel_reason TEXT,
  opened_by TEXT NOT NULL,
  opened_at INTEGER NOT NULL,
  bill_requested_at INTEGER,
  closed_by TEXT,
  closed_at INTEGER,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  UNIQUE (profile_id, number)
);
-- Uma conta aberta por mesa: abrir a mesma mesa duas vezes falha aqui.
CREATE UNIQUE INDEX IF NOT EXISTS mesas_tabs_open ON mesas_tabs(table_id) WHERE status IN ('open', 'closing');
CREATE INDEX IF NOT EXISTS mesas_tabs_status ON mesas_tabs(profile_id, status, closed_at);

CREATE TABLE IF NOT EXISTS mesas_counters (
  profile_id TEXT PRIMARY KEY,
  last INTEGER NOT NULL
);

-- Pagamentos da conta (parciais ou o fechamento). Registrados pela equipe:
-- dinheiro, cartão na maquininha, Pix da loja ou outro.
CREATE TABLE IF NOT EXISTS mesas_payments (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  tab_id TEXT NOT NULL,
  -- cash | card | pix | other
  method TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  -- Dinheiro: quanto o cliente entregou e o troco.
  tendered_cents INTEGER,
  change_cents INTEGER,
  note TEXT NOT NULL DEFAULT '',
  -- ok | void (lançamento desfeito)
  status TEXT NOT NULL DEFAULT 'ok',
  created_by TEXT NOT NULL,
  created INTEGER NOT NULL,
  voided_by TEXT,
  voided_at INTEGER,
  void_reason TEXT
);
CREATE INDEX IF NOT EXISTS mesas_payments_tab ON mesas_payments(tab_id, created);

-- Histórico da conta: abertura, envios para a cozinha, transferência,
-- junção, conta pedida, pagamentos e fechamento.
CREATE TABLE IF NOT EXISTS mesas_history (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  tab_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  actor TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mesas_history_tab ON mesas_history(tab_id, created);
