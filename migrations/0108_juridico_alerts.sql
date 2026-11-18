-- Caixa interna durável. Inserção é a entrega no painel, não um envio ao WhatsApp.
CREATE TABLE jur_alerts (
  profile_id TEXT NOT NULL, id TEXT NOT NULL, deadline_id TEXT NOT NULL, revision INTEGER NOT NULL,
  recipient TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('fatal','recalculated','calculation_error')),
  created INTEGER NOT NULL, acknowledged_at INTEGER,
  PRIMARY KEY(profile_id,id), UNIQUE(profile_id,deadline_id,revision,kind),
  FOREIGN KEY(profile_id,deadline_id) REFERENCES jur_deadlines(profile_id,id)
);
CREATE INDEX jur_alerts_recipient ON jur_alerts(profile_id,recipient,acknowledged_at,created,id);
