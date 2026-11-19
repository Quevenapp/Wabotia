CREATE TABLE customer_channel_ids (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  channel TEXT NOT NULL CHECK(channel IN (
    'whatsapp','instagram','facebook','tiktok',
    'googlebusiness','telegram','email'
  )),
  account_id TEXT NOT NULL,
  subject_namespace TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  username TEXT NOT NULL DEFAULT '',
  contact_id TEXT,
  connection_id TEXT,
  proof_conversation_id TEXT,
  state TEXT NOT NULL CHECK(state IN (
    'ready','pending','ambiguous','blocked','erased'
  )),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  UNIQUE(
    profile_id,namespace,channel,account_id,
    subject_namespace,subject_id
  ),
  UNIQUE(id,profile_id),
  FOREIGN KEY(contact_id,profile_id,namespace)
    REFERENCES contacts(id,profile_id,namespace),
  FOREIGN KEY(connection_id,profile_id)
    REFERENCES connections(id,profile_id),
  FOREIGN KEY(proof_conversation_id,profile_id)
    REFERENCES conversations(id,profile_id),
  CHECK(state <> 'ready' OR (
    contact_id IS NOT NULL AND proof_conversation_id IS NOT NULL
  ))
);

CREATE INDEX customer_channel_ids_contact
  ON customer_channel_ids(profile_id,contact_id,channel);

ALTER TABLE conversations
  ADD COLUMN channel_identity_id TEXT
  REFERENCES customer_channel_ids(id);

ALTER TABLE contacts ADD COLUMN merged_into TEXT;
ALTER TABLE contacts ADD COLUMN merge_id TEXT;

CREATE INDEX contacts_merge_target
  ON contacts(profile_id,namespace,merged_into);

CREATE TABLE customer_merges (
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL CHECK(state IN ('applied','undone')),
  before_cipher TEXT NOT NULL,
  after_hash TEXT NOT NULL,
  source_version INTEGER NOT NULL,
  target_version INTEGER NOT NULL,
  created INTEGER NOT NULL,
  undone_at INTEGER,
  undone_by TEXT,
  undo_command_id TEXT,
  undo_request_hash TEXT,
  PRIMARY KEY(profile_id,id),
  UNIQUE(profile_id,command_id),
  UNIQUE(profile_id,undo_command_id),
  FOREIGN KEY(source_id,profile_id,namespace)
    REFERENCES contacts(id,profile_id,namespace),
  FOREIGN KEY(target_id,profile_id,namespace)
    REFERENCES contacts(id,profile_id,namespace),
  CHECK(source_id <> target_id),
  CHECK(
    (state='applied' AND undone_at IS NULL)
    OR
    (state='undone' AND undone_at IS NOT NULL)
  )
);

CREATE INDEX customer_merges_contacts
  ON customer_merges(profile_id,source_id,target_id,created);
