-- Extensão independente: nenhuma alteração nas tabelas do motor.
CREATE TABLE ensino_classes (
  profile_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL,
  school_year TEXT NOT NULL, start_date TEXT NOT NULL, end_date TEXT NOT NULL,
  teacher_id TEXT NOT NULL, type_id TEXT NOT NULL, capacity INTEGER NOT NULL CHECK(capacity BETWEEN 1 AND 100),
  schedule_json TEXT NOT NULL, periods_json TEXT NOT NULL, rule_json TEXT NOT NULL,
  justified_counts INTEGER NOT NULL CHECK(justified_counts IN (0,1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), created INTEGER NOT NULL,
  PRIMARY KEY(profile_id,id), CHECK(start_date<=end_date)
);
CREATE INDEX ensino_classes_teacher ON ensino_classes(profile_id,teacher_id,id);

CREATE TABLE ensino_enrollments (
  profile_id TEXT NOT NULL, id TEXT NOT NULL, class_id TEXT NOT NULL, order_id TEXT NOT NULL,
  start_date TEXT NOT NULL, end_date TEXT NOT NULL, ended INTEGER NOT NULL DEFAULT 0 CHECK(ended IN (0,1)),
  PRIMARY KEY(profile_id,id), UNIQUE(profile_id,class_id,order_id),
  UNIQUE(profile_id,class_id,id), CHECK(start_date<=end_date),
  FOREIGN KEY(profile_id,class_id) REFERENCES ensino_classes(profile_id,id),
  FOREIGN KEY(profile_id,order_id) REFERENCES os_orders(profile_id,id)
);
CREATE INDEX ensino_enrollments_order ON ensino_enrollments(profile_id,order_id,class_id);
CREATE TRIGGER ensino_capacity BEFORE INSERT ON ensino_enrollments BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM (SELECT NEW.start_date day UNION SELECT start_date FROM ensino_enrollments
      WHERE profile_id=NEW.profile_id AND class_id=NEW.class_id AND start_date BETWEEN NEW.start_date AND NEW.end_date) dates
    WHERE (SELECT count(*) FROM ensino_enrollments e WHERE e.profile_id=NEW.profile_id
      AND e.class_id=NEW.class_id AND e.start_date<=dates.day AND e.end_date>=dates.day)
      >= (SELECT capacity FROM ensino_classes WHERE profile_id=NEW.profile_id AND id=NEW.class_id))
    THEN RAISE(ABORT,'ensino_capacity') END;
END;

-- Uma autorização explícita, sem duplicar o cadastro de pessoas do motor.
-- Versão/telefone da pessoa têm de continuar iguais em CADA leitura/envio.
CREATE TABLE ensino_guardians (
  profile_id TEXT NOT NULL, id TEXT NOT NULL, order_id TEXT NOT NULL, person_id TEXT NOT NULL,
  person_version INTEGER NOT NULL, phone_hash TEXT NOT NULL, valid_until TEXT NOT NULL,
  revoked_at INTEGER, verified_by TEXT NOT NULL, created INTEGER NOT NULL,
  PRIMARY KEY(profile_id,id),
  FOREIGN KEY(profile_id,order_id,person_id) REFERENCES os_people(profile_id,order_id,id)
);
CREATE INDEX ensino_guardians_phone ON ensino_guardians(profile_id,phone_hash,revoked_at,order_id);

-- O CHECK faz o lote inteiro falhar quando o CAS anterior não alterou uma linha.
-- Conteúdo escolar não é copiado para audit/events/os_history.
CREATE TABLE ensino_audit (
  profile_id TEXT NOT NULL, id TEXT NOT NULL, class_id TEXT NOT NULL, entity_id TEXT NOT NULL,
  operation TEXT NOT NULL, actor_id TEXT NOT NULL, version INTEGER NOT NULL,
  request_hash TEXT NOT NULL, changed INTEGER NOT NULL CHECK(changed=1), created INTEGER NOT NULL,
  PRIMARY KEY(profile_id,id),
  FOREIGN KEY(profile_id,class_id) REFERENCES ensino_classes(profile_id,id)
);
