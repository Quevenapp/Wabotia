CREATE TABLE cond_notices (
 profile_id TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
 audience TEXT NOT NULL CHECK(audience IN ('all','block','units')), target_json TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved','sending','sent')),
 approved_by TEXT, created_at INTEGER NOT NULL,
 PRIMARY KEY(profile_id,id)
);
CREATE TABLE cond_notice_recipients (
 profile_id TEXT NOT NULL, notice_id TEXT NOT NULL, phone TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','queued','failed','skipped')),
 attempts INTEGER NOT NULL DEFAULT 0, error_code TEXT,
 PRIMARY KEY(profile_id,notice_id,phone),
 FOREIGN KEY(profile_id,notice_id) REFERENCES cond_notices(profile_id,id)
);
CREATE INDEX cond_notice_pending ON cond_notice_recipients(profile_id,status,notice_id,phone);
