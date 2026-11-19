ALTER TABLE connections
  ADD COLUMN channel TEXT NOT NULL DEFAULT 'whatsapp'
  CHECK(channel IN (
    'whatsapp','instagram','facebook','tiktok',
    'googlebusiness','telegram','email'
  ));

ALTER TABLE connections
  ADD COLUMN account_label TEXT NOT NULL DEFAULT '';

ALTER TABLE conversations
  ADD COLUMN channel TEXT
  CHECK(channel IS NULL OR channel IN (
    'whatsapp','instagram','facebook','tiktok',
    'googlebusiness','telegram','email'
  ));

ALTER TABLE conversations
  ADD COLUMN account_label TEXT NOT NULL DEFAULT '';

ALTER TABLE conversations
  ADD COLUMN channel_account_id TEXT;

ALTER TABLE conversations
  ADD COLUMN channel_subject_id TEXT;

ALTER TABLE conversations
  ADD COLUMN channel_context TEXT NOT NULL DEFAULT '{}'
  CHECK(json_valid(channel_context));

CREATE UNIQUE INDEX connections_id_profile
  ON connections(id,profile_id);

CREATE UNIQUE INDEX meta_accounts_id_profile
  ON meta_accounts(id,profile_id);

CREATE INDEX conversations_channel_recent
  ON conversations(profile_id,channel,updated DESC,id DESC);

CREATE INDEX connections_profile_channel
  ON connections(profile_id,channel,status);
