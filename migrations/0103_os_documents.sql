CREATE TABLE os_documents (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  mime_type TEXT NOT NULL CHECK (length(mime_type) BETWEEN 1 AND 120),
  expected_bytes INTEGER NOT NULL
    CHECK (expected_bytes BETWEEN 1 AND 10485760),
  byte_length INTEGER,
  sha256 TEXT,
  r2_key TEXT,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'ready', 'aborted')),
  upload_attempt TEXT,
  upload_request_key TEXT,
  upload_lease_until INTEGER,
  upload_expires_at INTEGER NOT NULL,
  source_message_id TEXT,
  source_media_id TEXT,
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
  CHECK (state <> 'ready' OR
         (r2_key IS NOT NULL AND
          byte_length = expected_bytes AND
          sha256 IS NOT NULL)),
  UNIQUE (profile_id, order_id, id),
  UNIQUE (profile_id, r2_key),
  UNIQUE (profile_id, order_id, source_media_id),
  FOREIGN KEY (profile_id, order_id)
    REFERENCES os_orders(profile_id, id)
);

CREATE INDEX os_documents_order_page
  ON os_documents(profile_id, order_id, archived_at, created, id);

CREATE INDEX os_documents_pending
  ON os_documents(profile_id, upload_expires_at, id)
  WHERE state = 'pending';

CREATE INDEX os_documents_source
  ON os_documents(profile_id, source_message_id);
