ALTER TABLE contacts ADD COLUMN document TEXT;
ALTER TABLE contacts ADD COLUMN person_type TEXT
  CHECK(person_type IS NULL OR person_type IN ('F','J','E'));
ALTER TABLE contacts ADD COLUMN erp_contact_id TEXT;
ALTER TABLE contacts ADD COLUMN erp_version INTEGER;
ALTER TABLE contacts ADD COLUMN mirror_json TEXT
  CHECK(mirror_json IS NULL OR json_valid(mirror_json));
ALTER TABLE contacts ADD COLUMN local_patch_cipher TEXT;
ALTER TABLE contacts ADD COLUMN identity_state TEXT NOT NULL DEFAULT 'active'
  CHECK(identity_state IN ('active','restricted','erasing','erased'));

CREATE UNIQUE INDEX contacts_identity_scope
  ON contacts(id,profile_id,namespace);
CREATE UNIQUE INDEX contacts_erp_identity
  ON contacts(profile_id,erp_contact_id)
  WHERE erp_contact_id IS NOT NULL;
CREATE INDEX contacts_document_identity
  ON contacts(profile_id,namespace,document);

ALTER TABLE conversations ADD COLUMN verified_phone TEXT;
ALTER TABLE conversations ADD COLUMN customer_link_state TEXT NOT NULL
  DEFAULT 'pending'
  CHECK(customer_link_state IN
    ('ready','pending','ambiguous','blocked','excluded'));

CREATE TABLE customer_phones (
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  namespace TEXT NOT NULL,
  phone TEXT NOT NULL,
  contact_id TEXT,
  state TEXT NOT NULL
    CHECK(state IN ('ready','pending','ambiguous')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  PRIMARY KEY(profile_id,namespace,phone),
  FOREIGN KEY(contact_id,profile_id,namespace)
    REFERENCES contacts(id,profile_id,namespace),
  CHECK(length(phone) BETWEEN 8 AND 15
    AND phone NOT GLOB '*[^0-9]*'),
  CHECK((state='ready' AND contact_id IS NOT NULL)
    OR (state<>'ready' AND contact_id IS NULL))
);

CREATE TABLE customer_phone_candidates (
  profile_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  phone TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  origin TEXT NOT NULL
    CHECK(origin IN ('legacy','local','observed','mirror')),
  PRIMARY KEY(profile_id,namespace,phone,contact_id),
  FOREIGN KEY(contact_id,profile_id,namespace)
    REFERENCES contacts(id,profile_id,namespace),
  CHECK(length(phone) BETWEEN 8 AND 15
    AND phone NOT GLOB '*[^0-9]*')
);
CREATE INDEX customer_phone_candidates_contact
  ON customer_phone_candidates(profile_id,contact_id,phone);

CREATE TABLE customer_progress (
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  namespace TEXT NOT NULL,
  task TEXT NOT NULL,
  cursor_json TEXT NOT NULL DEFAULT '{}'
    CHECK(json_valid(cursor_json)),
  complete INTEGER NOT NULL DEFAULT 0 CHECK(complete IN (0,1)),
  updated INTEGER NOT NULL,
  PRIMARY KEY(profile_id,namespace,task)
);

INSERT INTO customer_phone_candidates
  (profile_id,namespace,phone,contact_id,origin)
SELECT profile_id,namespace,phone,id,'legacy'
FROM contacts
WHERE length(phone) BETWEEN 8 AND 15
  AND phone NOT GLOB '*[^0-9]*';

INSERT INTO customer_phones
  (profile_id,namespace,phone,contact_id,state)
SELECT profile_id,namespace,phone,
  CASE WHEN count(*)=1 THEN min(contact_id) ELSE NULL END,
  CASE WHEN count(*)=1 THEN 'ready' ELSE 'ambiguous' END
FROM customer_phone_candidates
GROUP BY profile_id,namespace,phone;
