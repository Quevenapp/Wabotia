CREATE TABLE saude_attachments (
  profile_id TEXT NOT NULL,
  id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  episode_id TEXT NOT NULL,
  payload_enc TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  expected_bytes INTEGER NOT NULL CHECK(expected_bytes BETWEEN 1 AND 10485760),
  sensitive INTEGER NOT NULL DEFAULT 1 CHECK(sensitive=1),
  client_visible INTEGER NOT NULL DEFAULT 0 CHECK(client_visible=0),
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','ready')),
  version INTEGER NOT NULL DEFAULT 1,
  created INTEGER NOT NULL,
  author TEXT NOT NULL,
  upload_key TEXT,
  attempt TEXT,
  lease_until INTEGER,
  r2_key TEXT,
  sha256 TEXT,
  PRIMARY KEY(profile_id,id),
  FOREIGN KEY(profile_id,subject_id) REFERENCES saude_subjects(profile_id,id),
  FOREIGN KEY(profile_id,episode_id) REFERENCES saude_episodes(profile_id,id)
);
CREATE INDEX saude_attachments_subject ON saude_attachments(profile_id,subject_id,id);
-- Inclui tentativas abandonadas: nenhum objeto perde a referência de descarte.
CREATE TABLE saude_objects (
  profile_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  attachment_id TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  PRIMARY KEY(profile_id,r2_key),
  FOREIGN KEY(profile_id,subject_id) REFERENCES saude_subjects(profile_id,id)
);
CREATE TABLE saude_access_audit (
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  id TEXT NOT NULL,
  subject_id TEXT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  resources_json TEXT NOT NULL,
  created INTEGER NOT NULL,
  PRIMARY KEY(profile_id,id)
);
CREATE INDEX saude_audit_subject ON saude_access_audit(profile_id,subject_id,id);
CREATE TRIGGER saude_audit_no_update BEFORE UPDATE ON saude_access_audit
BEGIN SELECT RAISE(ABORT,'saude_audit_immutable'); END;
CREATE TRIGGER saude_audit_no_delete BEFORE DELETE ON saude_access_audit
BEGIN SELECT RAISE(ABORT,'saude_audit_immutable'); END;
CREATE TRIGGER saude_attachment_immutable BEFORE UPDATE ON saude_attachments
WHEN OLD.state='ready'
BEGIN SELECT RAISE(ABORT,'saude_attachment_immutable'); END;
