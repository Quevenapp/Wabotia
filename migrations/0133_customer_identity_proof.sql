-- Candidatos cadastrais não são credenciais. Provas são criadas somente na
-- confirmação de uma entrada autenticada, e conservadas após revogação.
CREATE TABLE customer_phone_proofs (
  profile_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  phone TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  created INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1)),
  PRIMARY KEY(profile_id,namespace,phone,contact_id),
  FOREIGN KEY(contact_id,profile_id,namespace) REFERENCES contacts(id,profile_id,namespace),
  FOREIGN KEY(conversation_id,profile_id) REFERENCES conversations(id,profile_id)
);
CREATE INDEX customer_phone_proofs_contact ON customer_phone_proofs(profile_id,contact_id,phone);
ALTER TABLE conversations ADD COLUMN customer_identity_proof TEXT;
CREATE INDEX conversations_verified_identity ON conversations(profile_id,verified_phone);
CREATE INDEX conversations_identity_page ON conversations(profile_id,external_namespace,id);
CREATE INDEX contacts_identity_page ON contacts(profile_id,namespace,id);
-- Busca exata de candidatos legados formatados; a validação continua no
-- normalizador único, que também distingue a origem internacional explícita.
CREATE INDEX contacts_legacy_phone ON contacts(profile_id,namespace,
  replace(replace(replace(replace(replace(replace(phone,' ',''),'.',''),'-',''),'(',''),')',''),'+',''));

CREATE TRIGGER customer_candidate_removed AFTER DELETE ON customer_phone_candidates
BEGIN
  UPDATE customer_phone_proofs SET revoked=1
    WHERE profile_id=OLD.profile_id AND namespace=OLD.namespace AND phone=OLD.phone AND contact_id=OLD.contact_id;
END;
CREATE TRIGGER customer_proof_revoked AFTER UPDATE OF revoked ON customer_phone_proofs
WHEN NEW.revoked=1 AND OLD.revoked=0
BEGIN
  UPDATE customer_phones SET contact_id=NULL,state='pending',version=version+1
    WHERE profile_id=NEW.profile_id AND namespace=NEW.namespace AND phone=NEW.phone AND contact_id=NEW.contact_id;
  UPDATE conversations SET customer_identity_proof=NULL,customer_link_state='pending'
    WHERE profile_id=NEW.profile_id AND verified_phone=NEW.phone
      AND customer_identity_proof=NEW.contact_id AND customer_link_state NOT IN ('blocked','excluded');
END;
CREATE TRIGGER customer_phone_changed AFTER UPDATE OF state,contact_id ON customer_phones
WHEN NEW.state IS NOT OLD.state OR NEW.contact_id IS NOT OLD.contact_id
BEGIN
  UPDATE conversations SET customer_identity_proof=NULL,customer_link_state='pending'
    WHERE profile_id=NEW.profile_id AND verified_phone=NEW.phone
      AND external_namespace NOT LIKE 'app:%' AND customer_link_state NOT IN ('blocked','excluded');
END;
CREATE TRIGGER customer_restricted AFTER UPDATE OF identity_state ON contacts
WHEN NEW.identity_state!='active'
BEGIN
  UPDATE conversations SET customer_identity_proof=NULL,customer_link_state='excluded'
    WHERE profile_id=NEW.profile_id AND customer_link_state!='blocked' AND
      (customer_identity_proof=NEW.id OR id IN
        (SELECT conversation_id FROM conversation_contacts WHERE profile_id=NEW.profile_id AND contact_id=NEW.id));
END;
CREATE TRIGGER customer_identity_blocked AFTER UPDATE OF customer_link_state ON conversations
WHEN NEW.customer_link_state='blocked' AND OLD.customer_link_state!='blocked'
BEGIN
  -- Também guarda a revogação quando o vínculo legado ainda não foi reparado.
  INSERT INTO customer_phone_proofs(profile_id,namespace,phone,contact_id,conversation_id,created,revoked)
    SELECT NEW.profile_id,'team',NEW.verified_phone,k.id,NEW.id,NEW.updated,1 FROM contacts k
      WHERE NEW.verified_phone IS NOT NULL AND k.profile_id=NEW.profile_id AND k.namespace='team'
        AND k.id=coalesce(OLD.customer_identity_proof,
          (SELECT contact_id FROM customer_records WHERE profile_id=NEW.profile_id AND record_id=NEW.id||':'||NEW.session
            AND ((module_id='conversations' AND kind='session') OR (module_id='core' AND kind='conversation')) LIMIT 1),
          (SELECT contact_id FROM customer_phones WHERE profile_id=NEW.profile_id AND namespace='team' AND phone=NEW.verified_phone))
    ON CONFLICT(profile_id,namespace,phone,contact_id) DO UPDATE SET revoked=1;
  UPDATE customer_phone_proofs SET revoked=1
    WHERE profile_id=NEW.profile_id AND namespace='team' AND contact_id IN
      (SELECT contact_id FROM customer_phone_proofs WHERE profile_id=NEW.profile_id AND namespace='team'
        AND phone=NEW.verified_phone AND revoked=1);
  UPDATE customer_phones SET state='pending',contact_id=NULL,version=version+1
    WHERE profile_id=NEW.profile_id AND namespace='team' AND phone=NEW.verified_phone AND state='ready';
  UPDATE conversations SET customer_identity_proof=NULL WHERE id=NEW.id;
END;
CREATE INDEX customer_records_session_identity ON customer_records(profile_id,record_id,module_id,kind);
CREATE INDEX messages_customer_identity ON messages(conversation_id,direction,created,id);
-- Invalidações que exigem recuperação sobrevivem à interrupção do executor.
CREATE TRIGGER customer_identity_pending AFTER UPDATE OF customer_link_state ON conversations
WHEN NEW.customer_link_state='pending' AND OLD.customer_link_state!='pending'
BEGIN
  INSERT INTO customer_progress(profile_id,namespace,task,cursor_json,complete,updated)
    VALUES(NEW.profile_id,CASE WHEN NEW.external_namespace LIKE 'app:%' THEN NEW.external_namespace ELSE 'team' END,
      'identity.conversations.v2','{}',0,NEW.updated)
    ON CONFLICT(profile_id,namespace,task) DO UPDATE SET cursor_json='{}',complete=0,updated=excluded.updated;
END;
CREATE TRIGGER customer_application_linked AFTER INSERT ON conversation_contacts
BEGIN
  INSERT INTO customer_progress(profile_id,namespace,task,cursor_json,complete,updated)
    SELECT NEW.profile_id,external_namespace,'identity.conversations.v2','{}',0,NEW.created FROM conversations
      WHERE id=NEW.conversation_id AND profile_id=NEW.profile_id AND external_namespace LIKE 'app:%'
    ON CONFLICT(profile_id,namespace,task) DO UPDATE SET cursor_json='{}',complete=0,updated=excluded.updated;
END;
CREATE TRIGGER customer_identity_owner_changed AFTER UPDATE OF customer_identity_proof ON conversations
WHEN NEW.customer_identity_proof IS NOT OLD.customer_identity_proof AND NEW.external_namespace NOT LIKE 'app:%'
BEGIN
  DELETE FROM conversation_contacts WHERE conversation_id=NEW.id AND profile_id=NEW.profile_id
    AND linked_by='identity' AND contact_id IS NOT NEW.customer_identity_proof;
END;
