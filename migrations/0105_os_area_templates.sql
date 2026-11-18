CREATE TABLE os_area_template_applications (
  profile_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  template_version INTEGER NOT NULL CHECK (template_version > 0),
  manifest_hash TEXT NOT NULL,
  seen_ids_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(seen_ids_json) AND
           json_type(seen_ids_json) = 'array'),
  seen_paths_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(seen_paths_json) AND
           json_type(seen_paths_json) = 'array'),
  applied_by TEXT NOT NULL,
  applied_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, template_id)
);

CREATE INDEX os_area_template_applications_date
  ON os_area_template_applications(profile_id, applied_at);
