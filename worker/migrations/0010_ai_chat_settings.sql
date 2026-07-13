-- Admin-editable instructions appended to the AI chat assistant's system
-- prompt (both the staff panel and the public student/parent portal).
-- Single-row settings table — the CHECK pins it to exactly one row.
CREATE TABLE ai_chat_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  instructions TEXT NOT NULL DEFAULT '',
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_by TEXT
);

INSERT INTO ai_chat_settings (id, instructions) VALUES (1, '');
