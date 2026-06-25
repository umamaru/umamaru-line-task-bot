CREATE TABLE IF NOT EXISTS pending_inputs (
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  task_id INTEGER NOT NULL,
  input_type TEXT NOT NULL CHECK (input_type IN ('hold_comment')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (group_id, user_id),
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);
