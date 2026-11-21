-- Documentos do ERP por e-mail (src/erp/email): cada envio de proposta,
-- pedido de venda, pedido de compra, NF-e, NFC-e ou conta a receber, com o
-- assunto, o texto e os nomes dos anexos fixados no envio (os arquivos não
-- ficam aqui: no reenvio o documento é lido de novo). Só tabela nova; nada é
-- apagado nem reescrito.
CREATE TABLE IF NOT EXISTS erp_email_sends (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  -- proposta | pedido | compra | nota | nfce | conta
  doc_type TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  -- "Pedido de venda nº 123", fixado no envio.
  doc_label TEXT NOT NULL,
  -- Cliente ou fornecedor do documento no ERP.
  erp_contact_id TEXT,
  to_address TEXT NOT NULL,
  -- JSON: endereços em cópia.
  cc TEXT NOT NULL DEFAULT '[]',
  reply_to TEXT,
  from_name TEXT,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  -- JSON: [{nome, tipo, tamanho}].
  attachments TEXT NOT NULL DEFAULT '[]',
  -- JSON: escolhas do envio (xml, pagamento), repetidas no reenvio.
  options TEXT NOT NULL DEFAULT '{}',
  -- 1: fora do cadastro (endereço digitado).
  outside_record INTEGER NOT NULL DEFAULT 0,
  -- 1: envio automático da NF-e ao autorizar.
  auto INTEGER NOT NULL DEFAULT 0,
  -- Envio repetido por "Reenviar".
  resend_of TEXT,
  actor TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  via_bot TEXT,
  -- email_log.id do envio.
  email_log_id TEXT,
  -- enviando | enviado | na_fila | devolvido | falhou
  status TEXT NOT NULL,
  error TEXT,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS erp_email_sends_doc ON erp_email_sends(profile_id, doc_type, doc_id, created);
-- Envio automático da NF-e: no máximo um por emissão.
CREATE UNIQUE INDEX IF NOT EXISTS erp_email_sends_auto ON erp_email_sends(profile_id, doc_type, doc_id) WHERE auto = 1;
