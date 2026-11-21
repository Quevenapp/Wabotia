-- 0280_erp_bling_webhook.sql
-- Aviso do Bling (webhook) para uma área do ERP: o Worker confere a assinatura
-- (HMAC-SHA256 do corpo com o segredo do aplicativo da área) e grava só o
-- essencial do evento; o objeto da área lê na próxima acordada, confere a
-- empresa vinculada e adianta a coleta daquela entidade. Repetição do mesmo
-- evento não duplica (chave por área e id do evento). Nada do corpo bruto
-- nem do segredo é guardado. Só adição.

CREATE TABLE IF NOT EXISTS erp_bling_webhook_event (
  profile_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  entity TEXT NOT NULL,
  action TEXT NOT NULL,
  source_id TEXT,
  company_id TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  consumed_at INTEGER,
  PRIMARY KEY (profile_id, event_id)
);

CREATE INDEX IF NOT EXISTS erp_bling_webhook_event_pending
  ON erp_bling_webhook_event (profile_id, consumed_at, received_at);
