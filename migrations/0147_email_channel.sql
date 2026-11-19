CREATE TABLE email_channel_addresses (
  connection_id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  address TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 0 CHECK(active IN (0,1)),
  verified_at INTEGER,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  FOREIGN KEY(connection_id,profile_id) REFERENCES connections(id,profile_id)
);
CREATE TABLE email_channel_inbox (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  connection_id TEXT NOT NULL,
  event_key TEXT NOT NULL UNIQUE,
  sender TEXT NOT NULL,
  recipient TEXT NOT NULL,
  rfc_message_id TEXT,
  raw_hash TEXT NOT NULL,
  raw_key TEXT,
  raw_size INTEGER NOT NULL CHECK(raw_size>=0 AND raw_size<=26214400),
  state TEXT NOT NULL CHECK(state IN ('pending','processing','processed','automatic','blocked','quarantine','error')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
  lease_until INTEGER,
  next_at INTEGER NOT NULL,
  error_code TEXT,
  conversation_id TEXT,
  message_id TEXT REFERENCES messages(id),
  metadata TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata)),
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  FOREIGN KEY(conversation_id,profile_id) REFERENCES conversations(id,profile_id)
);
CREATE UNIQUE INDEX email_channel_message_identity ON email_channel_inbox(connection_id,sender,rfc_message_id) WHERE rfc_message_id IS NOT NULL AND state<>'quarantine';
CREATE INDEX email_channel_pending ON email_channel_inbox(profile_id,state,next_at,id);
CREATE INDEX email_channel_boxes ON email_channel_inbox(profile_id,connection_id,state,created DESC,id);
CREATE TABLE email_channel_blocks (
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  connection_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('address','domain')),
  value TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  created INTEGER NOT NULL,
  PRIMARY KEY(connection_id,kind,value)
);
CREATE TABLE email_channel_probes (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  connection_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  expires INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','received','expired','failed')),
  received_at INTEGER,
  created INTEGER NOT NULL,
  UNIQUE(profile_id,command_id)
);
