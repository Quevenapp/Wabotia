ALTER TABLE mensalidade_payers
  ADD COLUMN contact_id TEXT REFERENCES contacts(id);
ALTER TABLE cond_people
  ADD COLUMN contact_id TEXT REFERENCES contacts(id);
ALTER TABLE ensino_guardians
  ADD COLUMN contact_id TEXT REFERENCES contacts(id);
ALTER TABLE ensino_enrollments
  ADD COLUMN billing_contact_id TEXT REFERENCES contacts(id);

CREATE INDEX mensalidade_payers_contact
  ON mensalidade_payers(profile_id,contact_id);
CREATE INDEX cond_people_contact
  ON cond_people(profile_id,contact_id);
CREATE INDEX ensino_guardians_contact
  ON ensino_guardians(profile_id,contact_id);
CREATE INDEX ensino_enrollments_billing_contact
  ON ensino_enrollments(profile_id,billing_contact_id);

CREATE TABLE saude_contact_links (
  profile_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  relation TEXT NOT NULL CHECK(relation IN ('self','responsible','tutor')),
  PRIMARY KEY(profile_id,subject_id,contact_id,relation),
  FOREIGN KEY(profile_id,subject_id)
    REFERENCES saude_subjects(profile_id,id),
  FOREIGN KEY(contact_id,profile_id)
    REFERENCES contacts(id,profile_id)
);

CREATE TABLE cond_person_functions (
  profile_id TEXT NOT NULL,
  id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  unit_id TEXT,
  role TEXT NOT NULL CHECK(role IN
    ('sindico','zelador','porteiro','prestador','visitante_recorrente')),
  starts_at INTEGER NOT NULL,
  ends_at INTEGER,
  verified_by TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  PRIMARY KEY(profile_id,id),
  CHECK(ends_at IS NULL OR ends_at > starts_at),
  CHECK(role<>'visitante_recorrente' OR unit_id IS NOT NULL),
  FOREIGN KEY(profile_id,person_id)
    REFERENCES cond_people(profile_id,id),
  FOREIGN KEY(profile_id,unit_id)
    REFERENCES cond_units(profile_id,id)
);
CREATE INDEX cond_person_functions_person
  ON cond_person_functions(profile_id,person_id,starts_at,id);

CREATE TABLE cond_portaria_details (
  profile_id TEXT NOT NULL,
  work_id TEXT NOT NULL,
  visitor_person_id TEXT,
  delivery_source TEXT
    CHECK(delivery_source IN ('marketplace','correios','outro')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  PRIMARY KEY(profile_id,work_id),
  FOREIGN KEY(profile_id,work_id)
    REFERENCES cond_works(profile_id,id),
  FOREIGN KEY(profile_id,visitor_person_id)
    REFERENCES cond_people(profile_id,id)
);

CREATE TABLE cond_unit_subscriptions (
  profile_id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  PRIMARY KEY(profile_id,unit_id,subscription_id),
  FOREIGN KEY(profile_id,unit_id)
    REFERENCES cond_units(profile_id,id),
  FOREIGN KEY(subscription_id)
    REFERENCES mensalidade_subscriptions(id)
);
