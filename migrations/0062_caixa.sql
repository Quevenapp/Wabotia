-- Caixa (módulo "caixa", docs/CAIXA.md): caixas do balcão, sessões de
-- abertura e fechamento, sangria e suprimento. As vendas ficam em
-- vendas_sales (módulo "vendas") com session_id; os totais da sessão são
-- calculados a partir delas.

CREATE TABLE IF NOT EXISTS caixa_registers (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS caixa_registers_profile ON caixa_registers(profile_id, position);

CREATE TABLE IF NOT EXISTS caixa_sessions (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  register_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  -- open, closed
  status TEXT NOT NULL,
  opened_by TEXT NOT NULL,
  opened_at INTEGER NOT NULL,
  -- Troco inicial.
  opening_cents INTEGER NOT NULL DEFAULT 0,
  opening_note TEXT NOT NULL DEFAULT '',
  closed_by TEXT,
  closed_at INTEGER,
  -- Dinheiro contado no fechamento, esperado e diferença (contado - esperado).
  counted_cents INTEGER,
  expected_cash_cents INTEGER,
  difference_cents INTEGER,
  -- Resumo congelado no fechamento (formas de pagamento, vendas, devoluções).
  summary TEXT,
  closing_note TEXT NOT NULL DEFAULT '',
  source_key TEXT NOT NULL,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
-- Um caixa tem no máximo uma sessão aberta.
CREATE UNIQUE INDEX IF NOT EXISTS caixa_sessions_open ON caixa_sessions(register_id) WHERE status = 'open';
CREATE UNIQUE INDEX IF NOT EXISTS caixa_sessions_number ON caixa_sessions(profile_id, number);
CREATE UNIQUE INDEX IF NOT EXISTS caixa_sessions_source ON caixa_sessions(profile_id, source_key);
CREATE INDEX IF NOT EXISTS caixa_sessions_register ON caixa_sessions(profile_id, register_id, opened_at);

CREATE TABLE IF NOT EXISTS caixa_counters (
  profile_id TEXT PRIMARY KEY,
  last INTEGER NOT NULL
);

-- Sangria (retirada) e suprimento (reforço de troco).
CREATE TABLE IF NOT EXISTS caixa_moves (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  -- withdrawal (sangria), supply (suprimento)
  kind TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  key TEXT NOT NULL,
  actor TEXT NOT NULL,
  created INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS caixa_moves_key ON caixa_moves(profile_id, key);
CREATE INDEX IF NOT EXISTS caixa_moves_session ON caixa_moves(profile_id, session_id, created);
