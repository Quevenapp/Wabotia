-- Checkpoint técnico, sem conteúdo da tarefa; uma linha por área.
CREATE TABLE os_task_reminder_cursors (
  profile_id TEXT PRIMARY KEY REFERENCES profiles(id),
  remind_at INTEGER,
  task_id TEXT,
  CHECK ((remind_at IS NULL AND task_id IS NULL) OR
         (remind_at IS NOT NULL AND task_id IS NOT NULL))
);
