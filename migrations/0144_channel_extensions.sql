CREATE TABLE channel_delivery_state (
  outbox_id TEXT PRIMARY KEY REFERENCES outbox(id),
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  connection_id TEXT NOT NULL,
  resource_key TEXT NOT NULL,
  operation TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  attempted_at INTEGER,
  not_before INTEGER NOT NULL DEFAULT 0,
  result_context TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(result_context)),
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX channel_delivery_resource ON channel_delivery_state(profile_id,resource_key,created,outbox_id);
CREATE INDEX channel_delivery_due ON channel_delivery_state(profile_id,not_before,outbox_id);
CREATE TABLE channel_public_grants (
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  permission TEXT NOT NULL CHECK(permission='google.reply'),
  granted_by TEXT NOT NULL,
  created INTEGER NOT NULL,
  PRIMARY KEY(profile_id,user_id,permission)
);
