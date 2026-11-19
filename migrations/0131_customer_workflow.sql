CREATE TABLE customer_jobs (
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  contact_id TEXT,
  kind TEXT NOT NULL CHECK(kind IN
    ('enrich','promote','bind','sync','resolve_phone','section','erase')),
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN
    ('pending','running','paused','conflict','done','retained','cancelled')),
  command_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  expected_version INTEGER,
  expected_erp_version INTEGER,
  payload_cipher TEXT,
  result_cipher TEXT,
  error_code TEXT,
  cursor_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(cursor_json)),
  attempts INTEGER NOT NULL DEFAULT 0,
  retry_at INTEGER NOT NULL,
  lease_until INTEGER,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  PRIMARY KEY(profile_id,id),
  UNIQUE(profile_id,command_id),
  FOREIGN KEY(contact_id,profile_id,namespace)
    REFERENCES contacts(id,profile_id,namespace)
);
CREATE INDEX customer_jobs_due
  ON customer_jobs(profile_id,state,retry_at,created,id);
CREATE INDEX customer_jobs_contact
  ON customer_jobs(profile_id,contact_id,created,id);
CREATE UNIQUE INDEX customer_jobs_one_running
  ON customer_jobs(profile_id,contact_id)
  WHERE state='running' AND contact_id IS NOT NULL;

CREATE TABLE customer_records (
  profile_id TEXT NOT NULL,
  module_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  record_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  conversation_id TEXT,
  linked_by TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  PRIMARY KEY(profile_id,module_id,kind,record_id),
  FOREIGN KEY(contact_id,profile_id)
    REFERENCES contacts(id,profile_id),
  FOREIGN KEY(conversation_id,profile_id)
    REFERENCES conversations(id,profile_id)
);
CREATE INDEX customer_records_contact
  ON customer_records
    (profile_id,contact_id,module_id,kind,occurred_at DESC,record_id DESC);

CREATE TABLE customer_sections (
  profile_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  module_id TEXT NOT NULL,
  section_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  PRIMARY KEY(profile_id,contact_id,module_id,section_id),
  FOREIGN KEY(contact_id,profile_id)
    REFERENCES contacts(id,profile_id)
);

CREATE TABLE customer_assert (
  id TEXT PRIMARY KEY,
  ok INTEGER NOT NULL CHECK(ok=1)
);
