-- migration_002: objects that exist in the live DEV database but were missing from schema_core.sql.
-- Idempotent: safe to run on a fresh database (after schema_core.sql) or on the current one.
-- device_status is written by scripts/mqtt_status.py; dashboards must read device_status_live only.

CREATE TABLE IF NOT EXISTS device_status (
  device_id TEXT PRIMARY KEY,
  source_type TEXT,
  state TEXT,
  detail JSONB,
  last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE fruit_events
  ADD COLUMN IF NOT EXISTS track_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_events_track ON fruit_events (track_id);

CREATE OR REPLACE VIEW device_status_live AS
SELECT
  device_id,
  source_type,
  CASE
    WHEN now() - last_seen < interval '6 seconds' THEN state
    ELSE 'offline'
  END AS state,
  last_seen,
  round(extract(epoch FROM now() - last_seen)) AS age_sec
FROM device_status;
