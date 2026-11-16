-- Entrega (módulo "entrega"): acompanhamento da entrega em tempo real.
-- Uma linha por entrega (pedido do Pedido, visita, entrega avulsa). A posição
-- do entregador fica só na própria linha (última posição e um rastro curto),
-- gravada uma vez por lote enviado pelo app, e é apagada depois da retenção
-- (docs/ENTREGA.md, "Privacidade").
CREATE TABLE entrega_deliveries(
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  -- Origem: pedido (pedido do módulo Pedido), manual (avulsa), os (visita).
  source TEXT NOT NULL,
  source_ref TEXT,
  source_key TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  conversation_id TEXT,
  customer_name TEXT NOT NULL DEFAULT '',
  address_text TEXT NOT NULL DEFAULT '',
  -- Destino: geocodificado no aparelho, marcado pela equipe ou enviado pelo
  -- cliente no WhatsApp (dest_source app|panel|customer).
  dest_lat REAL,
  dest_lng REAL,
  dest_source TEXT,
  courier_id TEXT,
  -- Primeiro nome mostrado ao cliente ("Ana está chegando").
  courier_name TEXT NOT NULL DEFAULT '',
  -- pending (sem entregador) → assigned → en_route → delivered; cancelled
  -- em qualquer ponto antes de entregue.
  status TEXT NOT NULL,
  assigned_at INTEGER,
  started_at INTEGER,
  arriving_at INTEGER,
  delivered_at INTEGER,
  cancelled_at INTEGER,
  ended_at INTEGER,
  cancel_reason TEXT,
  last_lat REAL,
  last_lng REAL,
  last_accuracy REAL,
  last_speed REAL,
  last_at INTEGER,
  last_battery INTEGER,
  -- Últimos pontos [[t,lat,lng],…] (até 12), para a velocidade média.
  trail TEXT NOT NULL DEFAULT '[]',
  points INTEGER NOT NULL DEFAULT 0,
  distance_m INTEGER,
  eta_at INTEGER,
  updates_sent INTEGER NOT NULL DEFAULT 0,
  next_update_at INTEGER,
  -- Avisos já enviados: {"started":…, "arriving":…, "delivered":…, "signal":…}.
  notified TEXT NOT NULL DEFAULT '{}',
  track_step_id TEXT,
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  purged_at INTEGER
);
CREATE INDEX entrega_deliveries_status ON entrega_deliveries(profile_id,status,created);
CREATE INDEX entrega_deliveries_courier ON entrega_deliveries(profile_id,courier_id,status);
CREATE INDEX entrega_deliveries_conversation ON entrega_deliveries(conversation_id,status);
-- Uma entrega em andamento por registro de origem (o mesmo pedido não sai
-- duas vezes); depois de entregue ou cancelada, pode haver outra.
CREATE UNIQUE INDEX entrega_deliveries_source_active
  ON entrega_deliveries(profile_id,source,source_ref)
  WHERE source_ref IS NOT NULL AND status IN ('pending','assigned','en_route');
CREATE INDEX entrega_deliveries_purge ON entrega_deliveries(profile_id,purged_at,ended_at);

CREATE TABLE entrega_history(
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  status TEXT NOT NULL,
  actor TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created INTEGER NOT NULL
);
CREATE INDEX entrega_history_delivery ON entrega_history(delivery_id,created);
