CREATE TABLE monitors (
  username TEXT PRIMARY KEY,
  initialized_at INTEGER,
  baseline_id TEXT NOT NULL DEFAULT '0',
  latest_id TEXT NOT NULL DEFAULT '0',
  api_checked_until INTEGER,
  x_user_id TEXT,
  last_poll_at INTEGER,
  last_success_at INTEGER,
  last_error TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE alerts (
  username TEXT NOT NULL,
  post_id TEXT NOT NULL,
  text TEXT NOT NULL,
  url TEXT NOT NULL,
  published_at TEXT NOT NULL,
  queued_at INTEGER NOT NULL,
  sent_at INTEGER,
  discord_message_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  PRIMARY KEY (username, post_id)
);

CREATE INDEX alerts_pending ON alerts(username, sent_at, next_attempt_at);
