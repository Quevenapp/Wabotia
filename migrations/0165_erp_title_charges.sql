-- Cobrança de conta a receber do ERP (src/erp/conversa/charges.ts): o Pix ou
-- o link de pagamento da Cobrança (tabela payments, módulo 'erp') ligado a uma
-- conta a receber em aberto, e o que a confirmação do provedor fez com ela.
-- Só tabelas novas; nada é apagado nem reescrito.
CREATE TABLE IF NOT EXISTS erp_title_charges (
  -- O mesmo id da cobrança em payments.
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  -- Conta a receber no ERP (erp_finance__title.id) e a versão dela quando a
  -- cobrança foi gerada: baixa à mão depois disso vira pendência, não baixa.
  title_id TEXT NOT NULL,
  title_version INTEGER,
  -- pix | link
  method TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  description TEXT NOT NULL,
  -- O que falta fazer no Financeiro:
  --   aguardando: cobrança aberta, nada a fazer
  --   baixar:     pago e com a baixa automática ligada (o alarme baixa)
  --   sugestao:   pago, esperando a pessoa confirmar a baixa com um clique
  --   baixada:    a conta foi baixada por esta cobrança (settlement_id)
  --   pendencia:  pago, mas a conta já tinha sido baixada ou mudada à mão
  --   estornar:   estornado no provedor depois da baixa (o alarme reabre)
  --   reaberta:   a baixa desta cobrança foi estornada no Financeiro
  --   encerrada:  vencida, cancelada ou estornada antes de baixar
  settle_state TEXT NOT NULL DEFAULT 'aguardando',
  settlement_id TEXT,
  -- Motivo da pendência ou da última falha, em português.
  note TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER,
  -- Quem gerou (pessoa) e quem confirmou a sugestão de baixa.
  actor TEXT NOT NULL,
  confirmed_by TEXT,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS erp_title_charges_title ON erp_title_charges(profile_id, title_id, created);
CREATE INDEX IF NOT EXISTS erp_title_charges_work ON erp_title_charges(profile_id, settle_state, next_at);

-- Preferência do Financeiro "Baixar sozinho as contas pagas por Pix ou link":
-- nasce desligada. Conta financeira e forma de pagamento da baixa.
CREATE TABLE IF NOT EXISTS erp_title_charge_settings (
  profile_id TEXT PRIMARY KEY,
  auto_settle INTEGER NOT NULL DEFAULT 0,
  account_id TEXT,
  payment_method_id TEXT,
  -- Administrador que ligou a baixa automática (a baixa sai em nome dele).
  enabled_by TEXT,
  enabled_at INTEGER,
  updated_by TEXT NOT NULL,
  updated INTEGER NOT NULL
);

-- Registro de quem ligou, desligou ou mudou a preferência, e de cada baixa,
-- pendência e reabertura feita pela cobrança.
CREATE TABLE IF NOT EXISTS erp_title_charge_audit (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  charge_id TEXT,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}',
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS erp_title_charge_audit_profile ON erp_title_charge_audit(profile_id, created);
