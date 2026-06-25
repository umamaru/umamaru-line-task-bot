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
