CREATE TABLE os_entries (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (length(kind) BETWEEN 1 AND 64),
  text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 4000),
  quantity_milli INTEGER
    CHECK (quantity_milli IS NULL OR
           quantity_milli BETWEEN 0 AND 1000000000000),
  unit TEXT NOT NULL DEFAULT '' CHECK (length(unit) <= 32),
  occurred_at INTEGER NOT NULL,
  replaces_id TEXT,
  client_visible INTEGER NOT NULL DEFAULT 0
    CHECK (client_visible IN (0, 1)),
  sensitive INTEGER NOT NULL DEFAULT 0
    CHECK (sensitive IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by TEXT NOT NULL,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  archived_at INTEGER,
  CHECK (sensitive = 0 OR client_visible = 0),
  UNIQUE (profile_id, order_id, id),
  FOREIGN KEY (profile_id, order_id)
    REFERENCES os_orders(profile_id, id),
  FOREIGN KEY (profile_id, order_id, replaces_id)
    REFERENCES os_entries(profile_id, order_id, id)
);

CREATE INDEX os_entries_order_page
  ON os_entries(profile_id, order_id, archived_at, occurred_at, id);

CREATE INDEX os_entries_kind
  ON os_entries(profile_id, order_id, kind, occurred_at, id);

CREATE INDEX os_entries_replaces
  ON os_entries(profile_id, order_id, replaces_id);
