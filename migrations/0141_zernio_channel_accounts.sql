CREATE TABLE zernio_channel_accounts (
  connection_id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  integration_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK(channel IN (
    'instagram','facebook','tiktok','googlebusiness'
  )),
  account_id TEXT NOT NULL,
  provider_profile_id TEXT,
  account_label TEXT NOT NULL DEFAULT '',
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  UNIQUE(profile_id,channel,account_id),
  UNIQUE(integration_id,channel,account_id),
  FOREIGN KEY(connection_id,profile_id)
    REFERENCES connections(id,profile_id),
  FOREIGN KEY(integration_id,profile_id)
    REFERENCES meta_accounts(id,profile_id)
);

CREATE INDEX zernio_channel_accounts_integration
  ON zernio_channel_accounts(integration_id,channel,account_id);
