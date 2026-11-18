-- Dados clínicos nunca são filhos exportáveis da ordem administrativa.
CREATE TABLE saude_policy (
  profile_id TEXT PRIMARY KEY REFERENCES profiles(id),
  retention_days INTEGER CHECK(retention_days IS NULL OR retention_days BETWEEN 1 AND 36500),
  deletion_enabled INTEGER NOT NULL DEFAULT 0 CHECK(deletion_enabled IN (0,1)),
  version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE saude_subjects (
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('human','animal')),
  payload_enc TEXT,
  created INTEGER NOT NULL,
  last_activity INTEGER NOT NULL,
  retain_until INTEGER,
  legal_hold INTEGER NOT NULL DEFAULT 0 CHECK(legal_hold IN (0,1)),
  state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','deleting','deleted')),
  version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(profile_id,id)
);
CREATE TABLE saude_episodes (
  profile_id TEXT NOT NULL,
  id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  created INTEGER NOT NULL,
  PRIMARY KEY(profile_id,id),
  UNIQUE(profile_id,order_id),
  FOREIGN KEY(profile_id,subject_id) REFERENCES saude_subjects(profile_id,id),
  FOREIGN KEY(profile_id,order_id) REFERENCES os_orders(profile_id,id)
);
CREATE INDEX saude_episodes_subject ON saude_episodes(profile_id,subject_id,id);
CREATE TABLE saude_records (
  profile_id TEXT NOT NULL,
  id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  episode_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('evolution','prescription','exam_request','exam_result')),
  payload_enc TEXT NOT NULL,
  author TEXT NOT NULL,
  created INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  signed_at INTEGER,
  digest TEXT,
  addendum_of TEXT,
  request_id TEXT,
  PRIMARY KEY(profile_id,id),
  FOREIGN KEY(profile_id,subject_id) REFERENCES saude_subjects(profile_id,id),
  FOREIGN KEY(profile_id,episode_id) REFERENCES saude_episodes(profile_id,id),
  FOREIGN KEY(profile_id,addendum_of) REFERENCES saude_records(profile_id,id),
  FOREIGN KEY(profile_id,request_id) REFERENCES saude_records(profile_id,id),
  CHECK((signed_at IS NULL AND digest IS NULL) OR (signed_at IS NOT NULL AND digest IS NOT NULL))
);
CREATE INDEX saude_records_subject ON saude_records(profile_id,subject_id,id);
CREATE TABLE saude_revisions (
  profile_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  payload_enc TEXT NOT NULL,
  author TEXT NOT NULL,
  created INTEGER NOT NULL,
  PRIMARY KEY(profile_id,record_id,version),
  FOREIGN KEY(profile_id,subject_id) REFERENCES saude_subjects(profile_id,id)
);
CREATE TRIGGER saude_signed_immutable BEFORE UPDATE ON saude_records
WHEN OLD.signed_at IS NOT NULL
BEGIN SELECT RAISE(ABORT,'saude_signed_immutable'); END;
CREATE TRIGGER saude_record_guard BEFORE DELETE ON saude_records
WHEN NOT EXISTS(SELECT 1 FROM saude_subjects WHERE profile_id=OLD.profile_id AND id=OLD.subject_id AND state='deleting')
BEGIN SELECT RAISE(ABORT,'saude_retention'); END;
CREATE TRIGGER saude_revision_immutable BEFORE UPDATE ON saude_revisions
BEGIN SELECT RAISE(ABORT,'saude_revision_immutable'); END;
