CREATE TABLE os_tasks (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  description TEXT NOT NULL DEFAULT ''
    CHECK (length(description) <= 4000),
  assignee TEXT,
  audience TEXT NOT NULL DEFAULT 'staff'
    CHECK (audience IN ('staff', 'customer')),
  due_at INTEGER,
  remind_at INTEGER,
  state TEXT NOT NULL DEFAULT 'open'
    CHECK (state IN ('open', 'done', 'cancelled')),
  notified_at INTEGER,
  completed_at INTEGER,
  client_visible INTEGER NOT NULL DEFAULT 0
    CHECK (client_visible IN (0, 1)),
  sensitive INTEGER NOT NULL DEFAULT 0
    CHECK (sensitive IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by TEXT NOT NULL,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  archived_at INTEGER,
  CHECK (sensitive = 0 OR client_visible = 0),
  CHECK (audience <> 'customer' OR
         (client_visible = 1 AND sensitive = 0)),
  CHECK (remind_at IS NULL OR
         (due_at IS NOT NULL AND remind_at <= due_at)),
  UNIQUE (profile_id, order_id, id),
  FOREIGN KEY (profile_id, order_id)
    REFERENCES os_orders(profile_id, id)
);

CREATE INDEX os_tasks_order_page
  ON os_tasks(profile_id, order_id, archived_at, created, id);

CREATE INDEX os_tasks_due
  ON os_tasks(profile_id, remind_at, id)
  WHERE state = 'open' AND archived_at IS NULL
        AND notified_at IS NULL AND remind_at IS NOT NULL;

CREATE INDEX os_tasks_assignee
  ON os_tasks(profile_id, assignee, state, due_at);
