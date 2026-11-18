CREATE TABLE jur_calendars (
  profile_id TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0),
  name TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL,
  PRIMARY KEY(profile_id,id), FOREIGN KEY(profile_id) REFERENCES profiles(id)
);
CREATE TABLE jur_calendar_versions (
  profile_id TEXT NOT NULL, calendar_id TEXT NOT NULL, revision INTEGER NOT NULL,
  definition_json TEXT NOT NULL CHECK(json_valid(definition_json)),
  seeded INTEGER NOT NULL CHECK(seeded IN (0,1)), created_by TEXT NOT NULL, created INTEGER NOT NULL,
  request_key TEXT NOT NULL,
  PRIMARY KEY(profile_id,calendar_id,revision), UNIQUE(profile_id,request_key),
  FOREIGN KEY(profile_id,calendar_id) REFERENCES jur_calendars(profile_id,id)
);
