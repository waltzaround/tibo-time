ALTER TABLE alerts ADD COLUMN analysis_json TEXT;
ALTER TABLE alerts ADD COLUMN analysis_model TEXT;
ALTER TABLE alerts ADD COLUMN analyzed_at INTEGER;
ALTER TABLE alerts ADD COLUMN dismissed_at INTEGER;

DROP INDEX alerts_pending;
CREATE INDEX alerts_pending ON alerts(username, sent_at, dismissed_at, next_attempt_at);
