CREATE TABLE os_people (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (length(role) BETWEEN 1 AND 64),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  contact_id TEXT,
  phone TEXT NOT NULL DEFAULT '' CHECK (length(phone) <= 40),
  email TEXT NOT NULL DEFAULT '' CHECK (length(email) <= 254),
  note TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 2000),
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
    REFERENCES os_orders(profile_id, id)
);

CREATE INDEX os_people_order_page
  ON os_people(profile_id, order_id, archived_at, created, id);

CREATE INDEX os_people_contact
  ON os_people(profile_id, contact_id, order_id);

CREATE INDEX os_people_phone
  ON os_people(profile_id, phone, order_id);
