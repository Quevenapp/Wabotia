ALTER TABLE os_orders
ADD COLUMN commercial_json TEXT NOT NULL DEFAULT '{}'
CHECK (json_valid(commercial_json) AND json_type(commercial_json) = 'object');
ALTER TABLE agenda_appointments
ADD COLUMN commercial_json TEXT NOT NULL DEFAULT '{}'
CHECK (json_valid(commercial_json) AND json_type(commercial_json) = 'object');
ALTER TABLE entrega_deliveries
ADD COLUMN commercial_json TEXT NOT NULL DEFAULT '{}'
CHECK (json_valid(commercial_json) AND json_type(commercial_json) = 'object');

CREATE TABLE module_erp_policy (
  profile_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  config_json TEXT NOT NULL CHECK (json_valid(config_json) AND json_type(config_json) = 'object'),
  updated_ms INTEGER NOT NULL,
  updated_by TEXT NOT NULL
);
CREATE TABLE module_erp_activation (
  profile_id TEXT NOT NULL,
  module_id TEXT NOT NULL,
  epoch INTEGER NOT NULL CHECK (epoch > 0),
  enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
  first_enabled_ms INTEGER,
  enabled_since_ms INTEGER,
  updated_ms INTEGER NOT NULL,
  PRIMARY KEY (profile_id, module_id),
  CHECK ((enabled = 0 AND enabled_since_ms IS NULL) OR (enabled = 1 AND enabled_since_ms IS NOT NULL))
);
INSERT INTO module_erp_activation (
  profile_id, module_id, epoch, enabled, first_enabled_ms, enabled_since_ms, updated_ms
)
SELECT profile_id, module_id, 1, enabled,
  CASE WHEN enabled = 1 THEN CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) ELSE NULL END,
  CASE WHEN enabled = 1 THEN CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) ELSE NULL END,
  CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
FROM profile_modules;
CREATE TABLE module_erp_sources (
  profile_id TEXT NOT NULL,
  module_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  enqueued_seq INTEGER NOT NULL DEFAULT 0,
  applied_seq INTEGER NOT NULL DEFAULT 0,
  state_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(state_json) AND json_type(state_json) = 'object'),
  links_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(links_json) AND json_type(links_json) = 'array'),
  confirmed_ms INTEGER,
  PRIMARY KEY (profile_id, module_id, source_id),
  CHECK (enqueued_seq >= applied_seq AND applied_seq >= 0)
);
CREATE TABLE module_erp_aliases (
  profile_id TEXT NOT NULL, module_id TEXT NOT NULL,
  record_kind TEXT NOT NULL, record_id TEXT NOT NULL,
  source_id TEXT NOT NULL, component TEXT NOT NULL,
  PRIMARY KEY (profile_id, module_id, record_kind, record_id),
  FOREIGN KEY (profile_id, module_id, source_id) REFERENCES module_erp_sources(profile_id, module_id, source_id)
);
CREATE TABLE module_erp_events (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL, module_id TEXT NOT NULL, source_id TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq > 0),
  source_revision INTEGER NOT NULL CHECK (source_revision > 0),
  command_id TEXT NOT NULL UNIQUE, event_key TEXT NOT NULL, occurred_ms INTEGER NOT NULL,
  event_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND json_type(payload_json) = 'object'),
  UNIQUE (profile_id, module_id, source_id, seq), UNIQUE (profile_id, event_key),
  FOREIGN KEY (profile_id, module_id, source_id) REFERENCES module_erp_sources(profile_id, module_id, source_id)
);
CREATE TABLE module_erp_requests (
  event_id TEXT PRIMARY KEY REFERENCES module_erp_events(id), actor_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  expected_json TEXT NOT NULL CHECK (json_valid(expected_json) AND json_type(expected_json) = 'object'),
  body_json TEXT NOT NULL CHECK (json_valid(body_json) AND json_type(body_json) = 'object'),
  prepared_ms INTEGER NOT NULL
);
CREATE TABLE module_erp_delivery (
  event_id TEXT PRIMARY KEY REFERENCES module_erp_events(id),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','sending','waiting_manual','blocked','failed','done')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0), next_attempt_ms INTEGER NOT NULL,
  lease_token TEXT, lease_until_ms INTEGER, error_code TEXT, error_message TEXT,
  receipt_json TEXT CHECK (receipt_json IS NULL OR (json_valid(receipt_json) AND json_type(receipt_json) = 'object')),
  completed_ms INTEGER,
  CHECK ((lease_token IS NULL) = (lease_until_ms IS NULL))
);
CREATE INDEX module_erp_delivery_due ON module_erp_delivery(state, next_attempt_ms, lease_until_ms);
CREATE INDEX module_erp_events_source ON module_erp_events(profile_id, module_id, source_id, seq);
CREATE TABLE module_erp_catalog_links (
  profile_id TEXT NOT NULL, module_id TEXT NOT NULL, record_kind TEXT NOT NULL, record_id TEXT NOT NULL,
  component TEXT NOT NULL DEFAULT '', erp_item_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0), updated_ms INTEGER NOT NULL, updated_by TEXT NOT NULL,
  PRIMARY KEY (profile_id, module_id, record_kind, record_id, component)
);
CREATE TABLE module_erp_catalog_cache (
  profile_id TEXT NOT NULL, erp_item_id TEXT NOT NULL, warehouse_id TEXT NOT NULL DEFAULT '',
  catalog_version TEXT NOT NULL,
  quantity_json TEXT CHECK (quantity_json IS NULL OR json_valid(quantity_json)), observed_ms INTEGER NOT NULL,
  PRIMARY KEY (profile_id, erp_item_id, warehouse_id)
);
CREATE TABLE module_commercial_receipts (
  profile_id TEXT NOT NULL, receipt_key TEXT NOT NULL, owner_module TEXT NOT NULL, source_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('receive','reverse')),
  evidence TEXT NOT NULL CHECK (evidence IN ('provider','manual')), reverses_key TEXT,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  method TEXT NOT NULL CHECK (method IN ('cash','pix','card','other','unknown')),
  occurred_ms INTEGER NOT NULL, actor_id TEXT, evidence_hash TEXT NOT NULL,
  PRIMARY KEY (profile_id, receipt_key), UNIQUE (profile_id, reverses_key),
  FOREIGN KEY (profile_id, reverses_key) REFERENCES module_commercial_receipts(profile_id, receipt_key),
  CHECK ((kind = 'receive' AND reverses_key IS NULL) OR (kind = 'reverse' AND reverses_key IS NOT NULL)),
  CHECK (evidence <> 'manual' OR actor_id IS NOT NULL)
);
CREATE TABLE module_erp_allocations (
  profile_id TEXT NOT NULL, receipt_key TEXT NOT NULL, allocation_key TEXT NOT NULL,
  module_id TEXT NOT NULL, source_id TEXT NOT NULL, component TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  PRIMARY KEY (profile_id, receipt_key, allocation_key),
  FOREIGN KEY (profile_id, receipt_key) REFERENCES module_commercial_receipts(profile_id, receipt_key),
  FOREIGN KEY (profile_id, module_id, source_id) REFERENCES module_erp_sources(profile_id, module_id, source_id)
);
CREATE TRIGGER module_erp_events_no_update BEFORE UPDATE ON module_erp_events
BEGIN SELECT RAISE(ABORT, 'module_erp_event_immutable'); END;
CREATE TRIGGER module_erp_events_no_delete BEFORE DELETE ON module_erp_events
BEGIN SELECT RAISE(ABORT, 'module_erp_event_immutable'); END;
CREATE TRIGGER module_erp_requests_no_update BEFORE UPDATE ON module_erp_requests
BEGIN SELECT RAISE(ABORT, 'module_erp_request_immutable'); END;
CREATE TRIGGER module_erp_requests_no_delete BEFORE DELETE ON module_erp_requests
BEGIN SELECT RAISE(ABORT, 'module_erp_request_immutable'); END;
CREATE TRIGGER module_commercial_receipts_no_update BEFORE UPDATE ON module_commercial_receipts
BEGIN SELECT RAISE(ABORT, 'module_commercial_receipt_immutable'); END;
CREATE TRIGGER module_commercial_receipts_no_delete BEFORE DELETE ON module_commercial_receipts
BEGIN SELECT RAISE(ABORT, 'module_commercial_receipt_immutable'); END;
CREATE TRIGGER module_erp_allocations_no_update BEFORE UPDATE ON module_erp_allocations
BEGIN SELECT RAISE(ABORT, 'module_erp_allocation_immutable'); END;
CREATE TRIGGER module_erp_allocations_no_delete BEFORE DELETE ON module_erp_allocations
BEGIN SELECT RAISE(ABORT, 'module_erp_allocation_immutable'); END;
