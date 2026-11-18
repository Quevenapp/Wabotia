-- Defesa em profundidade: a aplicação valida a política e o SQL revalida a guarda.
CREATE TABLE saude_mutations (
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  mutation_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_json TEXT NOT NULL,
  PRIMARY KEY(profile_id,mutation_key)
);
-- Asserção transitória dentro do batch: CAS sem efeito aborta a transação inteira.
CREATE TABLE saude_assert (
  profile_id TEXT PRIMARY KEY REFERENCES profiles(id),
  ok INTEGER NOT NULL CHECK(ok=1)
);
CREATE TRIGGER saude_delete_guard BEFORE UPDATE OF state ON saude_subjects
WHEN NEW.state='deleting' AND OLD.state='active' AND (
  OLD.legal_hold=1 OR OLD.retain_until IS NULL OR
  OLD.retain_until > CAST((julianday('now')-2440587.5)*86400000 AS INTEGER) OR
  NOT EXISTS(SELECT 1 FROM saude_policy WHERE profile_id=OLD.profile_id AND deletion_enabled=1 AND retention_days IS NOT NULL) OR
  EXISTS(SELECT 1 FROM saude_policy WHERE profile_id=OLD.profile_id AND OLD.last_activity+retention_days*86400000 > CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)) OR
  EXISTS(SELECT 1 FROM saude_attachments WHERE profile_id=OLD.profile_id AND subject_id=OLD.id AND lease_until > CAST((julianday('now')-2440587.5)*86400000 AS INTEGER))
)
BEGIN SELECT RAISE(ABORT,'saude_retention'); END;
CREATE TRIGGER saude_subject_no_delete BEFORE DELETE ON saude_subjects
BEGIN SELECT RAISE(ABORT,'saude_tombstone_required'); END;
CREATE TRIGGER saude_revision_guard BEFORE DELETE ON saude_revisions
WHEN NOT EXISTS(SELECT 1 FROM saude_subjects WHERE profile_id=OLD.profile_id AND id=OLD.subject_id AND state='deleting')
BEGIN SELECT RAISE(ABORT,'saude_retention'); END;
CREATE TRIGGER saude_attachment_guard BEFORE DELETE ON saude_attachments
WHEN NOT EXISTS(SELECT 1 FROM saude_subjects WHERE profile_id=OLD.profile_id AND id=OLD.subject_id AND state='deleting')
BEGIN SELECT RAISE(ABORT,'saude_retention'); END;
