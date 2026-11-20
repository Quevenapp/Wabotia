-- ERP pela conversa (src/erp/conversa): cada envio de um documento do ERP
-- (proposta, pedido, nota fiscal, conta a receber) pelo WhatsApp da própria
-- área. Só tabela nova; nada é apagado nem reescrito.
--
-- O estado de entrega não é copiado aqui: vem do outbox (dedupe
-- 'erp-conversa:<id>' e derivados) e de messages.delivery_status.
CREATE TABLE IF NOT EXISTS erp_whatsapp_sends (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  -- proposta | pedido | nota | conta
  doc_type TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  -- "Pedido de venda nº 123", fixado no envio.
  doc_label TEXT NOT NULL,
  -- Cliente do documento no ERP (erp_catalog.record).
  erp_contact_id TEXT,
  -- Telefone de destino, só dígitos com DDI.
  phone TEXT NOT NULL,
  -- 1: número digitado, fora do cadastro do cliente.
  outside_record INTEGER NOT NULL DEFAULT 0,
  connection_id TEXT NOT NULL,
  conversation_id TEXT,
  actor TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  -- Bot que propôs (a pessoa confirmou), quando houver.
  via_bot TEXT,
  -- arquivo | link | modelo | link_copiado
  mode TEXT NOT NULL,
  -- Anexos gravados em media (JSON: ids).
  media_ids TEXT NOT NULL DEFAULT '[]',
  web_step_id TEXT,
  text TEXT NOT NULL,
  -- O que a página do link mostra (JSON: título, situação e linhas curtas),
  -- fixado no envio: só aquele documento.
  page TEXT NOT NULL DEFAULT '{}',
  -- preparado | enviado | link | falhou
  status TEXT NOT NULL,
  error TEXT,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS erp_whatsapp_sends_doc ON erp_whatsapp_sends(profile_id, doc_type, doc_id, created);
CREATE INDEX IF NOT EXISTS erp_whatsapp_sends_step ON erp_whatsapp_sends(web_step_id);
