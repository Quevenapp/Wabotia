CREATE TABLE reviews (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  connection_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  remote_id TEXT NOT NULL,
  rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
  text TEXT NOT NULL DEFAULT '',
  author_name TEXT NOT NULL DEFAULT '',
  author_picture TEXT NOT NULL DEFAULT '',
  permalink TEXT NOT NULL DEFAULT '',
  published_at INTEGER,
  provider_updated_at INTEGER,
  state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','deleted')),
  reply_text TEXT NOT NULL DEFAULT '',
  reply_at INTEGER,
  replied_by TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
  last_event_key TEXT NOT NULL,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  UNIQUE(connection_id,remote_id)
);
CREATE INDEX reviews_list ON reviews(profile_id,connection_id,state,updated DESC,id DESC);
CREATE TABLE channel_sync_state (
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  connection_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind='google.reviews'),
  activation_at INTEGER NOT NULL,
  cursor TEXT,
  next_at INTEGER NOT NULL,
  last_complete_at INTEGER,
  last_error_code TEXT,
  updated INTEGER NOT NULL,
  PRIMARY KEY(profile_id,connection_id,kind)
);
