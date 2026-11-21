-- Régua de cobrança do ERP (src/erp/regua/): quem ligou, os dias, os canais,
-- a forma de pagamento da mensagem e o horário comercial, por área.
-- Desligada por padrão (sem linha = desligada). Dia em branco (NULL) usa a
-- preferência de Contas a receber do ERP; as etapas e a situação de cada
-- envio ficam no motor do ERP (erp_finance__dunning_step, esquema 34). Só
-- tabelas novas; nada é apagado nem reescrito.
CREATE TABLE IF NOT EXISTS erp_regua_settings (
  profile_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  -- Dias antes do vencimento (0: sem aviso antes), no dia (0/1) e dias depois.
  days_before INTEGER,
  on_due INTEGER,
  days_after INTEGER,
  whatsapp INTEGER NOT NULL DEFAULT 1,
  email INTEGER NOT NULL DEFAULT 0,
  -- auto (a da conta) | pix | link | boleto | sem
  payment TEXT NOT NULL DEFAULT 'auto',
  hour_from INTEGER NOT NULL DEFAULT 8,
  hour_to INTEGER NOT NULL DEFAULT 18,
  business_days INTEGER NOT NULL DEFAULT 1,
  -- O administrador que ligou: as mensagens saem em nome dele.
  enabled_by TEXT,
  enabled_at INTEGER,
  updated_by TEXT,
  updated INTEGER,
  -- Próxima rodada do alarme da área (ms); a rodada não repete antes disso.
  next_round INTEGER,
  -- A última rodada (ms) e, se ela não conseguiu rodar, o motivo em português.
  last_round INTEGER,
  last_error TEXT
);

-- Quem ligou, desligou ou mudou a régua, com o antes e o depois.
CREATE TABLE IF NOT EXISTS erp_regua_audit (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  detail TEXT NOT NULL,
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS erp_regua_audit_profile ON erp_regua_audit(profile_id, created);
