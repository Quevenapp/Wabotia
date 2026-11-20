ALTER TABLE os_orders ADD COLUMN stage_required_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(stage_required_json) AND json_type(stage_required_json) = 'array');

CREATE TABLE os_field_index_state (
  profile_id TEXT NOT NULL,
  type_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('building', 'ready')),
  cursor_number INTEGER NOT NULL DEFAULT 0 CHECK (cursor_number >= 0),
  ceiling_number INTEGER NOT NULL DEFAULT 0 CHECK (ceiling_number >= 0),
  excluded_count INTEGER NOT NULL DEFAULT 0 CHECK (excluded_count >= 0),
  updated INTEGER NOT NULL,
  PRIMARY KEY (profile_id, type_id)
);
CREATE TABLE os_order_field_index (
  profile_id TEXT NOT NULL,
  type_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  field_key TEXT NOT NULL,
  value_kind TEXT NOT NULL CHECK (value_kind IN ('text', 'choice', 'date', 'integer', 'decimal', 'boolean')),
  value_text TEXT,
  value_number REAL,
  order_id TEXT NOT NULL,
  order_number INTEGER NOT NULL,
  order_version INTEGER NOT NULL CHECK (order_version > 0),
  PRIMARY KEY (profile_id, type_id, generation, field_key, order_id),
  FOREIGN KEY (profile_id, order_id) REFERENCES os_orders(profile_id, id) ON DELETE CASCADE,
  CHECK (
    (value_kind IN ('text', 'choice', 'date') AND value_text IS NOT NULL AND value_number IS NULL)
    OR (value_kind IN ('integer', 'decimal', 'boolean') AND value_text IS NULL AND value_number IS NOT NULL)
  )
);
CREATE INDEX os_order_field_text ON os_order_field_index(
  profile_id, type_id, generation, field_key, value_text, order_number DESC, order_id DESC
) WHERE value_text IS NOT NULL;
CREATE INDEX os_order_field_number ON os_order_field_index(
  profile_id, type_id, generation, field_key, value_number, order_number DESC, order_id DESC
) WHERE value_number IS NOT NULL;
CREATE INDEX os_order_field_order ON os_order_field_index(profile_id, order_id, generation);
