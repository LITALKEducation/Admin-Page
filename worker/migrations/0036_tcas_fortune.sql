CREATE TABLE tcas_fortune_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0,
  maintenance INTEGER NOT NULL DEFAULT 0,
  daily_limit INTEGER NOT NULL DEFAULT 5,
  burst_limit INTEGER NOT NULL DEFAULT 3,
  model TEXT NOT NULL DEFAULT 'gemini-3.1-flash-lite',
  max_output_tokens INTEGER NOT NULL DEFAULT 1200,
  share_enabled INTEGER NOT NULL DEFAULT 1,
  ask_litalk_enabled INTEGER NOT NULL DEFAULT 1,
  prompt_additions TEXT NOT NULL DEFAULT '',
  categories_json TEXT NOT NULL DEFAULT '["current_preparation","current_focus","challenge","exam_energy","faculty_preparation","tgat","tpat","a_level"]',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO tcas_fortune_settings (id) VALUES (1);

CREATE TABLE tcas_fortune_rate_limits (
  key TEXT NOT NULL,
  window TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (key, window)
);

CREATE TABLE tcas_fortune_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event TEXT NOT NULL,
  question_type TEXT,
  language TEXT,
  country TEXT,
  latency_ms INTEGER,
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_tcas_fortune_events_created ON tcas_fortune_events(created_at);
