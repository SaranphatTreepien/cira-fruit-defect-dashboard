-- migration_006: dashboard login + new alert-rule groups.
-- Idempotent: safe to re-run.
-- Users are dashboard accounts only (CIRA CORE and the Python scripts talk to the DB directly).

CREATE TABLE IF NOT EXISTS users (
  id             BIGSERIAL PRIMARY KEY,
  email          TEXT NOT NULL UNIQUE,            -- stored lower-case
  name           TEXT NOT NULL,
  role           TEXT NOT NULL CHECK (role IN ('admin', 'viewer')),
  password_hash  TEXT NOT NULL,                   -- scrypt$<salt hex>$<hash hex>
  active         BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at  TIMESTAMPTZ
);

-- One row per signed-in browser. The cookie holds a random token; only its SHA-256 is stored.
CREATE TABLE IF NOT EXISTS user_sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions (user_id);

-- Who acknowledged an alert (acked_by keeps the display name for history).
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS acked_by_user BIGINT REFERENCES users(id) ON DELETE SET NULL;

-- New rule groups: alert when the model_version in incoming events changes, daily Telegram report.
UPDATE settings
SET value = '{"model_change": {"enabled": true}, "daily_report": {"enabled": true, "hour": 18, "minute": 0}}'::jsonb || value,
    updated_at = now()
WHERE key = 'alert_rules' AND NOT (value ? 'model_change' AND value ? 'daily_report');
