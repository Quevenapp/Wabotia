-- Token de revisão só escrito pela extensão; a API genérica não aceita esta coluna.
ALTER TABLE os_tasks ADD COLUMN juridico_revision INTEGER NOT NULL DEFAULT 0;
CREATE TABLE jur_deadlines (
  profile_id TEXT NOT NULL, id TEXT NOT NULL, order_id TEXT NOT NULL, task_id TEXT NOT NULL,
  calendar_id TEXT NOT NULL, calendar_revision INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
  title TEXT NOT NULL, assignee TEXT NOT NULL, rule_json TEXT NOT NULL CHECK(json_valid(rule_json)),
  due_at INTEGER NOT NULL, calculated_due_at INTEGER NOT NULL, previous_due_at INTEGER,
  alert_at INTEGER NOT NULL, review TEXT NOT NULL CHECK(review IN ('pending','confirmed','error')),
  error_code TEXT, confirmed_by TEXT, confirmed_at INTEGER, completion_evidence TEXT,
  created_by TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL,
  PRIMARY KEY(profile_id,id), UNIQUE(profile_id,order_id,task_id),
  FOREIGN KEY(profile_id,order_id,task_id) REFERENCES os_tasks(profile_id,order_id,id),
  FOREIGN KEY(profile_id,calendar_id,calendar_revision) REFERENCES jur_calendar_versions(profile_id,calendar_id,revision)
);
CREATE INDEX jur_deadlines_calendar ON jur_deadlines(profile_id,calendar_id,calendar_revision,id);
CREATE INDEX jur_deadlines_due ON jur_deadlines(profile_id,due_at,id);
CREATE INDEX jur_deadlines_assignee ON jur_deadlines(profile_id,assignee,due_at,id);
CREATE INDEX jur_deadlines_order ON jur_deadlines(profile_id,order_id,due_at,id);
CREATE TABLE jur_calculations (
  profile_id TEXT NOT NULL, deadline_id TEXT NOT NULL, revision INTEGER NOT NULL,
  calendar_revision INTEGER NOT NULL, memory_json TEXT NOT NULL CHECK(json_valid(memory_json)),
  error_code TEXT, created_by TEXT NOT NULL, created INTEGER NOT NULL,
  PRIMARY KEY(profile_id,deadline_id,revision),
  FOREIGN KEY(profile_id,deadline_id) REFERENCES jur_deadlines(profile_id,id)
);
-- Mantém sigilo e impede que a rota comum reprograme ou reabra um prazo jurídico.
CREATE TRIGGER jur_task_guard BEFORE UPDATE ON os_tasks
WHEN EXISTS(SELECT 1 FROM jur_deadlines d WHERE d.profile_id=OLD.profile_id AND d.order_id=OLD.order_id AND d.task_id=OLD.id)
AND (NEW.profile_id<>OLD.profile_id OR NEW.order_id<>OLD.order_id OR NEW.id<>OLD.id
  OR NEW.sensitive<>1 OR NEW.client_visible<>0 OR NEW.audience<>'staff' OR NEW.remind_at IS NOT NULL
  OR NEW.assignee IS NOT OLD.assignee OR NEW.title<>OLD.title OR NEW.description<>OLD.description
  OR NEW.archived_at IS NOT OLD.archived_at
  OR (OLD.state<>'open' AND (NEW.state<>OLD.state OR NEW.due_at IS NOT OLD.due_at))
  OR (NEW.due_at IS NOT OLD.due_at AND NEW.juridico_revision<>OLD.juridico_revision+1))
BEGIN SELECT RAISE(ABORT,'juridico_task_protected'); END;
CREATE TRIGGER jur_task_no_delete BEFORE DELETE ON os_tasks
WHEN EXISTS(SELECT 1 FROM jur_deadlines d WHERE d.profile_id=OLD.profile_id AND d.order_id=OLD.order_id AND d.task_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'juridico_task_protected'); END;
