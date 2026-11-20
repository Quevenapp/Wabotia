CREATE TABLE os_objects (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  contact_id TEXT NOT NULL,
  type_id TEXT NOT NULL,
  type_revision INTEGER NOT NULL CHECK (type_revision > 0),
  type_snapshot_json TEXT NOT NULL CHECK (
    json_valid(type_snapshot_json) AND json_type(type_snapshot_json) = 'object'
    AND length(CAST(type_snapshot_json AS BLOB)) <= 8192
  ),
  values_json TEXT NOT NULL DEFAULT '{}' CHECK (
    json_valid(values_json) AND json_type(values_json) = 'object'
    AND length(CAST(values_json AS BLOB)) <= 16384
  ),
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  UNIQUE (profile_id, id),
  FOREIGN KEY (contact_id, profile_id) REFERENCES contacts(id, profile_id) ON DELETE RESTRICT
);
CREATE INDEX os_objects_contact ON os_objects(profile_id, contact_id, archived, created DESC, id DESC);
CREATE INDEX os_objects_contact_type ON os_objects(profile_id, contact_id, type_id, archived, created DESC, id DESC);

CREATE TABLE os_object_history (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  object_id TEXT NOT NULL,
  object_version INTEGER NOT NULL CHECK (object_version > 0),
  kind TEXT NOT NULL,
  actor TEXT NOT NULL,
  changed_fields_json TEXT NOT NULL DEFAULT '[]' CHECK (
    json_valid(changed_fields_json) AND json_type(changed_fields_json) = 'array'
  ),
  created INTEGER NOT NULL,
  FOREIGN KEY (profile_id, object_id) REFERENCES os_objects(profile_id, id) ON DELETE RESTRICT
);
CREATE INDEX os_object_history_page ON os_object_history(profile_id, object_id, created DESC, id DESC);

ALTER TABLE os_orders ADD COLUMN object_id TEXT REFERENCES os_objects(id) ON DELETE RESTRICT;
ALTER TABLE os_orders ADD COLUMN object_snapshot_json TEXT CHECK (
  (object_id IS NULL AND object_snapshot_json IS NULL) OR (
    object_id IS NOT NULL AND type_id <> 'service_order' AND object_snapshot_json IS NOT NULL
    AND json_valid(object_snapshot_json) AND json_type(object_snapshot_json) = 'object'
    AND length(CAST(object_snapshot_json AS BLOB)) <= 32768
  )
);
CREATE INDEX os_orders_object_history ON os_orders(profile_id, object_id, created DESC, id DESC) WHERE object_id IS NOT NULL;
CREATE INDEX os_orders_object_completed ON os_orders(profile_id, object_id, delivered_at DESC, number DESC, id DESC)
  WHERE object_id IS NOT NULL AND status = 'delivered';

CREATE TABLE os2_receipts (
  profile_id TEXT NOT NULL,
  actor_key TEXT NOT NULL,
  operation TEXT NOT NULL,
  request_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  object_id TEXT,
  order_id TEXT,
  result_version INTEGER NOT NULL CHECK (result_version > 0),
  created INTEGER NOT NULL,
  PRIMARY KEY (profile_id, actor_key, operation, request_id),
  CHECK (object_id IS NOT NULL OR order_id IS NOT NULL)
);
