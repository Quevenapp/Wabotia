-- Frete e transportadoras da Expedição (src/erp/frete): provedores (Correios,
-- Melhor Envio) com interruptor desligado por padrão e sandbox, os ajustes da
-- área, as cotações, o serviço escolhido para o pedido, os envios contratados
-- (etiqueta oficial e código de rastreio) e os eventos do rastreio.
-- As credenciais ficam no cofre do núcleo (tabela secrets, cifradas, id
-- erp-frete:<provedor>:<área>), nunca aqui. O valor do frete, o prazo e o
-- rastreio do pedido ficam no ERP da área (pedido e expedição).
-- Só tabelas e índices novos; nada é apagado nem reescrito.

CREATE TABLE IF NOT EXISTS erp_frete_providers (
  profile_id TEXT NOT NULL,
  -- correios | melhorenvio
  provider TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  -- 1: ambiente de testes do provedor (homologação dos Correios, sandbox do Melhor Envio).
  sandbox INTEGER NOT NULL DEFAULT 1,
  -- Opções não secretas (serviços, contrato, e-mail técnico), JSON.
  options TEXT NOT NULL DEFAULT '{}',
  checked_at INTEGER,
  check_ok INTEGER,
  check_message TEXT,
  updated INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  PRIMARY KEY (profile_id, provider)
);

CREATE TABLE IF NOT EXISTS erp_frete_settings (
  profile_id TEXT PRIMARY KEY,
  -- Aviso ao cliente pelo WhatsApp a cada mudança no rastreio: desligado por padrão.
  notify_whatsapp INTEGER NOT NULL DEFAULT 0,
  -- CEP de origem quando não é o da empresa (8 dígitos).
  origin_postal_code TEXT,
  updated INTEGER NOT NULL,
  updated_by TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS erp_frete_quotes (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  -- Pedido de venda no ERP da área.
  document_id TEXT NOT NULL,
  origin_postal_code TEXT NOT NULL,
  destination_postal_code TEXT NOT NULL,
  -- Volumes cotados (mm e g) e os serviços devolvidos, JSON.
  volumes TEXT NOT NULL,
  options TEXT NOT NULL,
  created INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  expires INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS erp_frete_quotes_document ON erp_frete_quotes(profile_id, document_id, created);

CREATE TABLE IF NOT EXISTS erp_frete_choices (
  profile_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  quote_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  sandbox INTEGER NOT NULL,
  service_code TEXT NOT NULL,
  service_name TEXT NOT NULL,
  company TEXT,
  price_cents INTEGER NOT NULL,
  delivery_days INTEGER,
  -- 1: o valor e o prazo entraram no pedido; 0: ficaram só aqui (motivo em apply_message).
  applied INTEGER NOT NULL DEFAULT 0,
  apply_message TEXT,
  chosen INTEGER NOT NULL,
  chosen_by TEXT NOT NULL,
  PRIMARY KEY (profile_id, document_id)
);

CREATE TABLE IF NOT EXISTS erp_frete_shipments (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  order_number INTEGER NOT NULL,
  provider TEXT NOT NULL,
  sandbox INTEGER NOT NULL,
  service_code TEXT NOT NULL,
  service_name TEXT NOT NULL,
  price_cents INTEGER,
  -- contracting | uncertain | contracted | cancelling | cancelled | failed
  status TEXT NOT NULL,
  provider_ref TEXT,
  tracking_code TEXT,
  -- Etiqueta oficial guardada no R2 da instalação (MEDIA).
  label_key TEXT,
  label_at INTEGER,
  -- Rastreio: situação normalizada, última consulta, próxima consulta e falhas seguidas.
  tracking_status TEXT,
  tracking_at INTEGER,
  tracking_next INTEGER,
  tracking_failures INTEGER NOT NULL DEFAULT 0,
  -- Quando o pedido foi marcado como expedido na Expedição (só então o alarme rastreia).
  shipped_at INTEGER,
  delivered_at INTEGER,
  -- Para o aviso pelo WhatsApp: o celular do cadastro (só dígitos, com DDI) e o nome do cliente.
  notify_phone TEXT,
  customer_name TEXT,
  error TEXT,
  created INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  updated INTEGER NOT NULL
);
-- Um envio vivo por pedido: contratar de novo só depois de cancelado ou recusado.
CREATE UNIQUE INDEX IF NOT EXISTS erp_frete_shipments_active ON erp_frete_shipments(profile_id, document_id)
  WHERE status IN ('contracting','uncertain','contracted','cancelling');
CREATE INDEX IF NOT EXISTS erp_frete_shipments_due ON erp_frete_shipments(profile_id, tracking_next)
  WHERE status = 'contracted' AND shipped_at IS NOT NULL AND delivered_at IS NULL;

CREATE TABLE IF NOT EXISTS erp_frete_events (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  shipment_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  happened_at INTEGER NOT NULL,
  code TEXT NOT NULL,
  -- Situação normalizada (label_created, posted, in_transit, out_for_delivery, waiting_pickup, delivered, exception, returned, cancelled).
  status TEXT NOT NULL,
  description TEXT NOT NULL,
  location TEXT,
  created INTEGER NOT NULL,
  -- 1: o cliente foi avisado pelo WhatsApp (ou o aviso foi tentado).
  notified INTEGER NOT NULL DEFAULT 0,
  UNIQUE (shipment_id, happened_at, code, description)
);
CREATE INDEX IF NOT EXISTS erp_frete_events_document ON erp_frete_events(profile_id, document_id, happened_at);
