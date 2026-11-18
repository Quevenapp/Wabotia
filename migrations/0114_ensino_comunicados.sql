CREATE TABLE ensino_notices (
  profile_id TEXT NOT NULL, id TEXT NOT NULL, class_id TEXT NOT NULL,
  text TEXT NOT NULL, audience_date TEXT NOT NULL, published_at INTEGER, created_by TEXT NOT NULL,
  PRIMARY KEY(profile_id,id), FOREIGN KEY(profile_id,class_id) REFERENCES ensino_classes(profile_id,id)
);
CREATE TABLE ensino_deliveries (
  profile_id TEXT NOT NULL, notice_id TEXT NOT NULL, phone_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','queued','cancelled','blocked')),
  conversation_id TEXT, message_id TEXT, error_code TEXT, attempts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(profile_id,notice_id,phone_hash),
  FOREIGN KEY(profile_id,notice_id) REFERENCES ensino_notices(profile_id,id)
);
CREATE INDEX ensino_deliveries_pending ON ensino_deliveries(profile_id,status,notice_id,phone_hash);
CREATE TABLE ensino_access (
  profile_id TEXT NOT NULL, id TEXT NOT NULL, conversation_id TEXT NOT NULL,
  session TEXT NOT NULL, phone_hash TEXT NOT NULL, expires INTEGER NOT NULL,
  PRIMARY KEY(profile_id,id)
);
CREATE TABLE ensino_access_log (
  profile_id TEXT NOT NULL, id TEXT NOT NULL, access_id TEXT NOT NULL, created INTEGER NOT NULL,
  PRIMARY KEY(profile_id,id), FOREIGN KEY(profile_id,access_id) REFERENCES ensino_access(profile_id,id)
);
