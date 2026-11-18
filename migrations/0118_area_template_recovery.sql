-- Resultado e publicações pendentes confirmados junto da configuração.
CREATE TABLE os_area_template_receipts (
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  operation_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK(json_valid(result_json)),
  events_json TEXT NOT NULL CHECK(json_valid(events_json)),
  published INTEGER NOT NULL DEFAULT 0 CHECK(published IN (0,1)),
  PRIMARY KEY(profile_id, operation_id)
);
