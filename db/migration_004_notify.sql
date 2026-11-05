-- migration_004: delivery bookkeeping for Telegram notifications (scripts/alert_watcher.py).
-- Idempotent: safe to re-run.

ALTER TABLE alerts ADD COLUMN IF NOT EXISTS notify_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS notify_error TEXT;

-- Telegram settings group (min_level: info | warning | critical).
UPDATE settings
SET value = '{"telegram": {"enabled": true, "min_level": "info"}}'::jsonb || value, updated_at = now()
WHERE key = 'alert_rules' AND NOT (value ? 'telegram');
