-- migration_003: alert engine storage.
-- Written by scripts/alert_watcher.py; read/acknowledged by the dashboard (/api/alerts).
-- Idempotent: safe to re-run.

-- Every machine state change (started / playing / offline ...). device_status keeps only the latest
-- state, so this table is the on/off history.
CREATE TABLE IF NOT EXISTS device_state_log (
  id          BIGSERIAL PRIMARY KEY,
  ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
  device_id   TEXT NOT NULL,
  from_state  TEXT,
  to_state    TEXT NOT NULL,
  age_sec     NUMERIC
);
CREATE INDEX IF NOT EXISTS idx_device_state_log_device_ts ON device_state_log (device_id, ts DESC);

-- One row per alert occurrence. A condition that stays true keeps one open row (same dedup_key)
-- until it clears, then resolved_at is set.
CREATE TABLE IF NOT EXISTS alerts (
  id            BIGSERIAL PRIMARY KEY,
  ts            TIMESTAMPTZ NOT NULL DEFAULT now(),
  rule          TEXT NOT NULL,                 -- device_offline/online, internet_down/up, mqtt_down/up, db_down, writer_down, defect_rate_high, no_events, latency_high, watcher_start/stop
  level         TEXT NOT NULL CHECK (level IN ('info', 'warning', 'critical')),
  device_id     TEXT,
  title         TEXT NOT NULL,
  detail        TEXT,
  data          JSONB,
  dedup_key     TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'ack')),
  acked_at      TIMESTAMPTZ,
  acked_by      TEXT,
  resolved_at   TIMESTAMPTZ,
  -- For Telegram/LINE later: the notifier picks rows with notify_status = 'pending'.
  notify_status TEXT NOT NULL DEFAULT 'pending' CHECK (notify_status IN ('pending', 'sent', 'skipped', 'failed')),
  notified_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_alerts_ts ON alerts (ts DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_notify ON alerts (notify_status) WHERE notify_status = 'pending';
-- At most one open (unresolved) alert per condition.
CREATE UNIQUE INDEX IF NOT EXISTS uq_alerts_open ON alerts (dedup_key) WHERE resolved_at IS NULL;

-- Default thresholds; the dashboard edits this row in the existing settings table.
INSERT INTO settings (key, value, updated_at)
VALUES ('alert_rules', '{
  "defect_rate":  { "enabled": true, "threshold_pct": 70, "window_min": 10, "min_events": 30 },
  "no_events":    { "enabled": true, "after_sec": 60 },
  "latency":      { "enabled": true, "avg_sec": 10 },
  "device":       { "enabled": true, "notify_online": true },
  "mqtt":         { "enabled": true },
  "internet":     { "enabled": true },
  "writer":       { "enabled": true }
}'::jsonb, now())
ON CONFLICT (key) DO NOTHING;

-- Rule groups added later: add them to an existing row without touching edited values.
UPDATE settings
SET value = '{"internet": {"enabled": true}, "writer": {"enabled": true}}'::jsonb || value, updated_at = now()
WHERE key = 'alert_rules' AND NOT (value ? 'internet' AND value ? 'writer');
