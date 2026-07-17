-- On-site / group event check-in (extends the per-booking QR from 0015).
-- One QR per EVENT that many students scan; each scanner identifies
-- themselves by student id (prefilled from their portal cookie), so this
-- covers workshops, camps, and any on-site gathering that isn't a booked
-- 1-on-1 slot.

CREATE TABLE checkin_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,          -- ISO timestamp, compared in JS
  created_by TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE event_attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL,
  student_id TEXT NOT NULL,
  checked_in_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(event_id, student_id)       -- rescans are idempotent per student
);

CREATE INDEX idx_event_attendance_event ON event_attendance(event_id);
