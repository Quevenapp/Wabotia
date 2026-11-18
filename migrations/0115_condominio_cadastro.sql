-- Cadastro isolado por área. Instantes em ms UTC; fim de vínculo exclusivo.
CREATE TABLE cond_blocks (
 profile_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL,
 PRIMARY KEY(profile_id,id), UNIQUE(profile_id,name)
);
CREATE TABLE cond_units (
 profile_id TEXT NOT NULL, id TEXT NOT NULL, block_id TEXT NOT NULL, number TEXT NOT NULL,
 fraction_ppb INTEGER CHECK(fraction_ppb BETWEEN 1 AND 1000000000),
 PRIMARY KEY(profile_id,id), UNIQUE(profile_id,block_id,number),
 FOREIGN KEY(profile_id,block_id) REFERENCES cond_blocks(profile_id,id)
);
CREATE TABLE cond_people (
 profile_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL,
 PRIMARY KEY(profile_id,id)
);
CREATE TABLE cond_phones (
 profile_id TEXT NOT NULL, id TEXT NOT NULL, person_id TEXT NOT NULL, phone TEXT NOT NULL,
 verified_by TEXT NOT NULL, starts_at INTEGER NOT NULL, ends_at INTEGER,
 PRIMARY KEY(profile_id,id), CHECK(ends_at IS NULL OR ends_at>=starts_at),
 FOREIGN KEY(profile_id,person_id) REFERENCES cond_people(profile_id,id)
);
CREATE UNIQUE INDEX cond_phone_current ON cond_phones(profile_id,phone) WHERE ends_at IS NULL;
CREATE TABLE cond_memberships (
 profile_id TEXT NOT NULL, id TEXT NOT NULL, person_id TEXT NOT NULL, unit_id TEXT NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('proprietario','inquilino','dependente','funcionario')),
 starts_at INTEGER NOT NULL, ends_at INTEGER, verified_by TEXT NOT NULL,
 notices INTEGER NOT NULL DEFAULT 0 CHECK(notices IN (0,1)),
 PRIMARY KEY(profile_id,id), CHECK(ends_at IS NULL OR ends_at>=starts_at),
 FOREIGN KEY(profile_id,person_id) REFERENCES cond_people(profile_id,id),
 FOREIGN KEY(profile_id,unit_id) REFERENCES cond_units(profile_id,id)
);
CREATE INDEX cond_membership_person ON cond_memberships(profile_id,person_id,starts_at,ends_at);
CREATE INDEX cond_membership_unit ON cond_memberships(profile_id,unit_id,starts_at,ends_at);
CREATE TABLE cond_assets (
 profile_id TEXT NOT NULL, id TEXT NOT NULL, unit_id TEXT NOT NULL, person_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('vehicle','animal')), label TEXT NOT NULL, detail TEXT NOT NULL,
 PRIMARY KEY(profile_id,id),
 FOREIGN KEY(profile_id,unit_id) REFERENCES cond_units(profile_id,id),
 FOREIGN KEY(profile_id,person_id) REFERENCES cond_people(profile_id,id)
);
CREATE TABLE cond_access (
 profile_id TEXT NOT NULL, id TEXT NOT NULL, conversation_id TEXT NOT NULL, phone TEXT NOT NULL,
 person_id TEXT NOT NULL, selected_unit_id TEXT, expires_at INTEGER NOT NULL, claim_url TEXT,
 PRIMARY KEY(profile_id,id),
 FOREIGN KEY(profile_id,person_id) REFERENCES cond_people(profile_id,id),
 FOREIGN KEY(profile_id,selected_unit_id) REFERENCES cond_units(profile_id,id)
);
CREATE TABLE cond_works (
 profile_id TEXT NOT NULL, id TEXT NOT NULL, unit_id TEXT NOT NULL, person_id TEXT NOT NULL,
 membership_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('ocorrencia','encomenda','visitante')),
 created_at INTEGER NOT NULL, source_key TEXT NOT NULL,
 PRIMARY KEY(profile_id,id), UNIQUE(profile_id,source_key),
 FOREIGN KEY(profile_id,unit_id) REFERENCES cond_units(profile_id,id),
 FOREIGN KEY(profile_id,person_id) REFERENCES cond_people(profile_id,id),
 FOREIGN KEY(profile_id,membership_id) REFERENCES cond_memberships(profile_id,id)
);
CREATE INDEX cond_works_unit ON cond_works(profile_id,unit_id,id);
