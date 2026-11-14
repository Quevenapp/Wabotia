-- Fila de espera com senha (docs/FILA-SENHAS.md). Additive except for the
-- pairing_requests rebuild, which only widens the client CHECK to 'senhapp'.
CREATE TABLE queues (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  name TEXT NOT NULL,
  prefix_normal TEXT NOT NULL DEFAULT 'N',
  prefix_preferential TEXT NOT NULL DEFAULT 'P',
  normals_per_preferential INTEGER NOT NULL DEFAULT 2,
  normals_since_preferential INTEGER,
  priority INTEGER NOT NULL DEFAULT 0,
  wait_mode TEXT NOT NULL DEFAULT 'average' CHECK(wait_mode IN ('average','fixed')),
  service_minutes INTEGER NOT NULL DEFAULT 10,
  channels TEXT NOT NULL DEFAULT '["whatsapp","kiosk"]',
  preferential_notice TEXT NOT NULL DEFAULT '',
  whatsapp_line_id TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX queues_profile ON queues(profile_id,enabled,sort);

CREATE TABLE counters (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  name TEXT NOT NULL,
  queue_ids TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'closed' CHECK(status IN ('open','paused','closed')),
  user_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX counters_profile ON counters(profile_id,enabled);

CREATE TABLE queue_tickets (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  queue_id TEXT NOT NULL REFERENCES queues(id),
  service_day TEXT NOT NULL,
  prefix TEXT NOT NULL,
  seq INTEGER NOT NULL,
  code TEXT NOT NULL,
  preferential INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL CHECK(source IN ('whatsapp','kiosk','staff')),
  source_key TEXT,
  issued_by TEXT,
  conversation_id TEXT,
  phone TEXT,
  status TEXT NOT NULL DEFAULT 'waiting' CHECK(status IN ('waiting','called','serving','done','no_show','cancelled')),
  counter_id TEXT,
  target_counter_id TEXT,
  served_by TEXT,
  call_count INTEGER NOT NULL DEFAULT 0,
  notified_ahead INTEGER NOT NULL DEFAULT 0,
  cancel_reason TEXT,
  transferred_from_queue_id TEXT,
  public_token TEXT NOT NULL UNIQUE,
  link_code TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  called_at INTEGER,
  started_at INTEGER,
  finished_at INTEGER,
  updated INTEGER NOT NULL,
  UNIQUE(profile_id,queue_id,service_day,prefix,seq)
);
CREATE INDEX queue_tickets_waiting ON queue_tickets(profile_id,queue_id,status,created_at);
CREATE INDEX queue_tickets_day ON queue_tickets(profile_id,service_day,status);
CREATE INDEX queue_tickets_phone ON queue_tickets(profile_id,phone,created_at);
CREATE INDEX queue_tickets_conversation ON queue_tickets(conversation_id,status);
CREATE INDEX queue_tickets_counter ON queue_tickets(counter_id,status);
CREATE UNIQUE INDEX queue_tickets_source ON queue_tickets(source_key) WHERE source_key IS NOT NULL;

CREATE TABLE queue_blocklist (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  phone TEXT NOT NULL,
  reason TEXT NOT NULL CHECK(reason IN ('auto_no_show','auto_too_many','manual')),
  note TEXT NOT NULL DEFAULT '',
  blocked_by TEXT NOT NULL,
  created INTEGER NOT NULL,
  expires_at INTEGER,
  lifted_at INTEGER,
  lifted_by TEXT
);
CREATE INDEX queue_blocklist_phone ON queue_blocklist(profile_id,phone,lifted_at);

CREATE TABLE queue_displays (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  name TEXT NOT NULL,
  queue_ids TEXT NOT NULL DEFAULT '[]',
  token_hash TEXT NOT NULL UNIQUE,
  revoked INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL
);

ALTER TABLE conversations ADD COLUMN queue_prompt_expires_at INTEGER;
ALTER TABLE conversations ADD COLUMN queue_prompt_step TEXT;
ALTER TABLE conversations ADD COLUMN queue_prompt_queue_id TEXT;
ALTER TABLE conversations ADD COLUMN queue_prompt_session TEXT;
ALTER TABLE conversations ADD COLUMN queue_prompt_source TEXT;
ALTER TABLE conversations ADD COLUMN queue_menu_session TEXT;

-- SQLite cannot alter a CHECK: rebuild pairing_requests with 'senhapp'.
CREATE TABLE pairing_requests_next (
  id TEXT PRIMARY KEY,
  client TEXT NOT NULL CHECK(client IN ('vinki','fagoo','senhapp')),
  instance_name TEXT NOT NULL,
  device_hash TEXT NOT NULL UNIQUE,
  user_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','consumed','denied','revoked')),
  expires INTEGER NOT NULL,
  next_poll_at INTEGER NOT NULL DEFAULT 0,
  profile_id TEXT REFERENCES profiles(id),
  app_id TEXT REFERENCES applications(id),
  key_id TEXT REFERENCES api_keys(id),
  credential TEXT,
  grants TEXT NOT NULL DEFAULT '{}',
  approved_by TEXT,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
INSERT INTO pairing_requests_next SELECT id,client,instance_name,device_hash,user_hash,status,expires,next_poll_at,profile_id,app_id,key_id,credential,grants,approved_by,created,updated FROM pairing_requests;
DROP TABLE pairing_requests;
ALTER TABLE pairing_requests_next RENAME TO pairing_requests;
CREATE INDEX pairing_expiration ON pairing_requests(status,expires);
