CREATE TABLE fruit_types (
  code TEXT PRIMARY KEY,
  name_th TEXT,
  icon TEXT
);

CREATE TABLE defect_types (
  code TEXT PRIMARY KEY,
  name_th TEXT,
  group_no INT
);

CREATE TABLE models (
  model_version TEXT PRIMARY KEY,
  model_source TEXT NOT NULL CHECK (model_source IN ('mock','quick','team')),
  precision REAL, recall REAL, map REAL, threshold REAL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE run_sessions (
  session_id TEXT PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  stopped_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'running',
  params JSONB
);

CREATE TABLE fruit_events (
  event_id TEXT PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL,
  fruit_type TEXT REFERENCES fruit_types(code),
  external_result TEXT CHECK (external_result IN ('good','defect')),
  defect_type TEXT REFERENCES defect_types(code),
  nir_result TEXT,
  confidence REAL,
  camera_view TEXT,
  model_version TEXT REFERENCES models(model_version),
  model_source TEXT,
  session_id TEXT REFERENCES run_sessions(session_id),
  synced BOOLEAN NOT NULL DEFAULT false,
  raw JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_events_ts ON fruit_events (ts DESC);
CREATE INDEX idx_events_unsynced ON fruit_events (synced) WHERE synced = false;

CREATE TABLE system_logs (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  level TEXT NOT NULL DEFAULT 'info',
  source TEXT,
  message TEXT
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO fruit_types VALUES
  ('apple','แอปเปิล','🍎'),
  ('orange','ส้ม','🍊');

INSERT INTO models (model_version, model_source) VALUES
  ('mock','mock'),
  ('quick-v0.1','quick');