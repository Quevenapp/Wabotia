CREATE TABLE channel_comments (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  connection_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK(channel IN ('instagram','facebook')),
  account_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  remote_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  parent_id TEXT,
  conversation_id TEXT NOT NULL,
  message_id TEXT NOT NULL REFERENCES messages(id),
  post_context TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(post_context)),
  hidden INTEGER NOT NULL DEFAULT 0 CHECK(hidden IN (0,1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
  occurred_at INTEGER,
  private_command_id TEXT,
  private_attempted_at INTEGER,
  private_state TEXT NOT NULL DEFAULT 'available' CHECK(private_state IN ('available','reserved','sent','failed','unknown')),
  private_thread_id TEXT,
  private_conversation_id TEXT,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  UNIQUE(connection_id,remote_id),
  FOREIGN KEY(conversation_id,profile_id) REFERENCES conversations(id,profile_id),
  FOREIGN KEY(private_conversation_id,profile_id) REFERENCES conversations(id,profile_id),
  CHECK(private_state='available' OR private_command_id IS NOT NULL)
);
CREATE INDEX channel_comments_conversation ON channel_comments(profile_id,conversation_id,created,id);
CREATE TABLE telegram_callbacks (
  token_hash TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  connection_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  menu_token TEXT NOT NULL,
  option_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  expires INTEGER NOT NULL,
  used_query_id TEXT,
  used_at INTEGER,
  created INTEGER NOT NULL,
  FOREIGN KEY(conversation_id,profile_id) REFERENCES conversations(id,profile_id)
);
CREATE INDEX telegram_callbacks_expiry ON telegram_callbacks(profile_id,expires);
CREATE TABLE tiktok_send_slots (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  connection_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  outbox_id TEXT UNIQUE REFERENCES outbox(id),
  provider_message_id TEXT,
  state TEXT NOT NULL CHECK(state IN ('reserved','attempted','sent','unknown','released','external')),
  counted_at INTEGER NOT NULL,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  FOREIGN KEY(conversation_id,profile_id) REFERENCES conversations(id,profile_id)
);
CREATE UNIQUE INDEX tiktok_send_provider ON tiktok_send_slots(connection_id,provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE INDEX tiktok_send_window ON tiktok_send_slots(profile_id,conversation_id,counted_at,state);
