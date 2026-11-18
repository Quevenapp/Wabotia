CREATE TABLE cond_assemblies (
 profile_id TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, call_text TEXT NOT NULL,
 starts_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','closed')),
 minutes TEXT NOT NULL DEFAULT '', notice_id TEXT,
 PRIMARY KEY(profile_id,id), FOREIGN KEY(profile_id,notice_id) REFERENCES cond_notices(profile_id,id)
);
CREATE TABLE cond_agenda (
 profile_id TEXT NOT NULL, id TEXT NOT NULL, assembly_id TEXT NOT NULL, title TEXT NOT NULL,
 options_json TEXT NOT NULL, weighted INTEGER NOT NULL DEFAULT 0 CHECK(weighted IN (0,1)),
 block_debt INTEGER NOT NULL DEFAULT 0 CHECK(block_debt IN (0,1)),
 closes_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','open','closed','annulled')),
 annul_reason TEXT NOT NULL DEFAULT '', opened_at INTEGER,
 PRIMARY KEY(profile_id,id), UNIQUE(profile_id,assembly_id,id),
 FOREIGN KEY(profile_id,assembly_id) REFERENCES cond_assemblies(profile_id,id)
);
CREATE TABLE cond_attendance (
 profile_id TEXT NOT NULL, assembly_id TEXT NOT NULL, unit_id TEXT NOT NULL, person_id TEXT NOT NULL,
 arrived_at INTEGER NOT NULL, left_at INTEGER,
 PRIMARY KEY(profile_id,assembly_id,unit_id,person_id),
 FOREIGN KEY(profile_id,assembly_id) REFERENCES cond_assemblies(profile_id,id),
 FOREIGN KEY(profile_id,unit_id) REFERENCES cond_units(profile_id,id),
 FOREIGN KEY(profile_id,person_id) REFERENCES cond_people(profile_id,id)
);
CREATE TABLE cond_proxies (
 profile_id TEXT NOT NULL, id TEXT NOT NULL, assembly_id TEXT NOT NULL, agenda_id TEXT,
 unit_id TEXT NOT NULL, grantor_id TEXT NOT NULL, person_id TEXT NOT NULL,
 evidence TEXT NOT NULL, expires_at INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','revoked')),
 reviewed_by TEXT, PRIMARY KEY(profile_id,id),
 FOREIGN KEY(profile_id,assembly_id) REFERENCES cond_assemblies(profile_id,id),
 FOREIGN KEY(profile_id,assembly_id,agenda_id) REFERENCES cond_agenda(profile_id,assembly_id,id),
 FOREIGN KEY(profile_id,unit_id) REFERENCES cond_units(profile_id,id),
 FOREIGN KEY(profile_id,grantor_id) REFERENCES cond_people(profile_id,id),
 FOREIGN KEY(profile_id,person_id) REFERENCES cond_people(profile_id,id)
);
CREATE TABLE cond_electors (
 profile_id TEXT NOT NULL, agenda_id TEXT NOT NULL, unit_id TEXT NOT NULL, person_id TEXT NOT NULL,
 membership_id TEXT, proxy_id TEXT, weight INTEGER NOT NULL CHECK(weight BETWEEN 1 AND 1000000000),
 debt_status TEXT NOT NULL CHECK(debt_status IN ('unknown','regular','overdue')),
 debt_evidence TEXT NOT NULL DEFAULT '', reviewed_by TEXT NOT NULL,
 PRIMARY KEY(profile_id,agenda_id,unit_id),
 CHECK((membership_id IS NULL)!=(proxy_id IS NULL)),
 FOREIGN KEY(profile_id,agenda_id) REFERENCES cond_agenda(profile_id,id),
 FOREIGN KEY(profile_id,unit_id) REFERENCES cond_units(profile_id,id),
 FOREIGN KEY(profile_id,person_id) REFERENCES cond_people(profile_id,id),
 FOREIGN KEY(profile_id,membership_id) REFERENCES cond_memberships(profile_id,id),
 FOREIGN KEY(profile_id,proxy_id) REFERENCES cond_proxies(profile_id,id)
);
CREATE TABLE cond_votes (
 profile_id TEXT NOT NULL, id TEXT NOT NULL, agenda_id TEXT NOT NULL, unit_id TEXT NOT NULL,
 person_id TEXT NOT NULL, actor_id TEXT NOT NULL, choice TEXT NOT NULL,
 weight INTEGER NOT NULL CHECK(weight>0), created_at INTEGER NOT NULL, request_key TEXT NOT NULL,
 PRIMARY KEY(profile_id,id), UNIQUE(profile_id,agenda_id,unit_id), UNIQUE(profile_id,request_key),
 FOREIGN KEY(profile_id,agenda_id,unit_id) REFERENCES cond_electors(profile_id,agenda_id,unit_id),
 FOREIGN KEY(profile_id,person_id) REFERENCES cond_people(profile_id,id)
);
CREATE TABLE cond_audit (
 profile_id TEXT NOT NULL, id TEXT NOT NULL, entity_id TEXT NOT NULL, action TEXT NOT NULL,
 actor_id TEXT NOT NULL, created_at INTEGER NOT NULL,
 PRIMARY KEY(profile_id,id)
);
