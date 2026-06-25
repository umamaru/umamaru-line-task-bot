CREATE TABLE IF NOT EXISTS groups (
  group_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id TEXT NOT NULL,
  message_id TEXT NOT NULL UNIQUE,
  source_user_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('request', 'check')),
  title TEXT NOT NULL,
  due_text TEXT,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'hold', 'done')),
  hold_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY (group_id) REFERENCES groups(group_id)
);

CREATE INDEX IF NOT EXISTS idx_tasks_group_status
  ON tasks(group_id, status, id);

CREATE TABLE IF NOT EXISTS pending_inputs (
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  task_id INTEGER NOT NULL,
  input_type TEXT NOT NULL CHECK (input_type IN ('hold_comment')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (group_id, user_id),
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);

CREATE TABLE IF NOT EXISTS pending_actions (
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  task_group_id TEXT NOT NULL,
  task_id INTEGER NOT NULL,
  action_type TEXT NOT NULL CHECK (action_type IN ('report_comment')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (group_id, user_id),
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);
