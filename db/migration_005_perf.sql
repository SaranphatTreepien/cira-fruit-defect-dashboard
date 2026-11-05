-- migration_005: indexes for queries polled by the dashboard / watcher every few seconds.
-- Idempotent: safe to re-run.

-- "latest N events by insert time" (ingest latency on Live page, watcher latency/writer checks)
CREATE INDEX IF NOT EXISTS idx_events_created ON fruit_events (created_at DESC);
