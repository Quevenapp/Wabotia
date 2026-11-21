-- Obrigações fiscais em arquivo (src/erp/sped): o pedido de envio ao contador
-- de um arquivo (SPED Fiscal, EFD-Contribuições ou SINTEGRA) que espera o
-- pacote do contador do mesmo período ficar pronto com o arquivo dentro. O
-- envio em si é o do contador (erp_contador_sends, migração 0195). O arquivo
-- fica no objeto do ERP da área (versão 29) e no R2. Só tabela nova.
CREATE TABLE IF NOT EXISTS erp_sped_pending_sends (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  -- Arquivo no objeto do ERP (erp_sped__file.id) e o pacote do contador do período.
  file_id TEXT NOT NULL,
  package_id TEXT NOT NULL,
  period_from TEXT NOT NULL,
  period_to TEXT NOT NULL,
  -- whatsapp | email | null (o canal do cadastro do contador)
  channel TEXT,
  actor TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  via_bot TEXT,
  -- esperando | enviando | enviado | falhou
  status TEXT NOT NULL DEFAULT 'esperando',
  error TEXT,
  -- erp_contador_sends.id quando saiu.
  send_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS erp_sped_pending_sends_profile ON erp_sped_pending_sends(profile_id, status, created);
