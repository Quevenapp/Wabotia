ALTER TABLE os_orders
  ADD COLUMN type_id TEXT NOT NULL DEFAULT 'service_order';

ALTER TABLE os_orders
  ADD COLUMN stage TEXT;

ALTER TABLE os_orders
  ADD COLUMN type_number INTEGER
  CHECK (type_number IS NULL OR
         type_number BETWEEN 1 AND 2147483647);

ALTER TABLE os_orders
  ADD COLUMN extra_json TEXT NOT NULL DEFAULT '{}'
  CHECK (json_valid(extra_json) AND json_type(extra_json) = 'object');

ALTER TABLE os_orders
  ADD COLUMN type_snapshot_json TEXT
  CHECK (type_snapshot_json IS NULL OR
         (json_valid(type_snapshot_json) AND
          json_type(type_snapshot_json) = 'object'));

ALTER TABLE os_orders
  ADD COLUMN row_version INTEGER NOT NULL DEFAULT 1
  CHECK (row_version > 0);

ALTER TABLE os_orders
  ADD COLUMN stage_approval_json TEXT
  CHECK (stage_approval_json IS NULL OR
         (json_valid(stage_approval_json) AND
          json_type(stage_approval_json) = 'object'));

CREATE UNIQUE INDEX os_orders_profile_id
  ON os_orders(profile_id, id);

CREATE UNIQUE INDEX os_orders_type_number
  ON os_orders(profile_id, type_id, COALESCE(type_number, number));

CREATE INDEX os_orders_type_list
  ON os_orders(profile_id, type_id, number DESC);

CREATE INDEX os_orders_type_stage
  ON os_orders(profile_id, type_id, stage, number DESC);

CREATE INDEX os_orders_customer_type
  ON os_orders(profile_id, phone, type_id, number DESC);

CREATE TABLE os_type_counters (
  profile_id TEXT NOT NULL,
  type_id TEXT NOT NULL,
  last INTEGER NOT NULL
    CHECK (last BETWEEN 0 AND 2147483647),
  PRIMARY KEY (profile_id, type_id)
);

ALTER TABLE os_history ADD COLUMN from_stage TEXT;
ALTER TABLE os_history ADD COLUMN to_stage TEXT;
ALTER TABLE os_history ADD COLUMN entity_kind TEXT;
ALTER TABLE os_history ADD COLUMN entity_id TEXT;
ALTER TABLE os_history ADD COLUMN entity_version INTEGER;
ALTER TABLE os_history ADD COLUMN mutation_key TEXT;

ALTER TABLE os_history
  ADD COLUMN changed_fields_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(changed_fields_json) AND
         json_type(changed_fields_json) = 'array');

CREATE INDEX os_history_profile_order_page
  ON os_history(profile_id, order_id, created, id);

CREATE UNIQUE INDEX os_history_mutation
  ON os_history(profile_id, mutation_key)
  WHERE mutation_key IS NOT NULL;

-- Referência opaca para a definição fixada de uma abertura. ref_id de passos
-- web aparece em eventos e não pode carregar definições de campos privados.
CREATE TABLE os_open_definitions (
  profile_id TEXT NOT NULL,
  id TEXT NOT NULL,
  type_id TEXT NOT NULL,
  type_revision INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  created INTEGER NOT NULL,
  PRIMARY KEY (profile_id, id)
);
