-- migration_007: run / pause command per CIRA CORE device, set from the dashboard (admin).
-- Idempotent: safe to re-run.
-- The CIRA flow (Python box) polls GET /api/core/command?device_id=... about once a second and, while
-- run = false, sends no fruit events and reports state "paused" in its heartbeat. CORE's own Start/Stop
-- button is not touched: this is a gate inside the flow.

CREATE TABLE IF NOT EXISTS device_commands (
  device_id   TEXT PRIMARY KEY,
  run         BOOLEAN NOT NULL DEFAULT true,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  BIGINT REFERENCES users(id) ON DELETE SET NULL
);
