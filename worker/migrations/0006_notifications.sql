-- In-app notification center: system-generated alerts (schedule/amendment
-- approvals, payments, credit changes) and admin-composed messages, fanned
-- out to a role, a specific person, a specific student, or everyone.

CREATE TABLE notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT,
  link_url TEXT,
  category TEXT NOT NULL DEFAULT 'custom',
  -- 'staff_identity' | 'role' | 'all_staff' | 'student' | 'all_students' | 'all'
  audience_type TEXT NOT NULL,
  -- staff email/sub for 'staff_identity', 'admin'|'teacher' for 'role',
  -- student id for 'student'; NULL for 'all_staff' / 'all_students' / 'all'
  audience_value TEXT,
  created_by TEXT,          -- sender identity (NULL = system-generated)
  created_by_name TEXT,     -- display label shown to recipients
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_notifications_audience ON notifications(audience_type, audience_value);
CREATE INDEX idx_notifications_created ON notifications(created_at);

-- Per-recipient read state, keyed by whatever identity read it (staff email
-- or student id) — needed because a single broadcast row can have many
-- readers with different read states.
CREATE TABLE notification_reads (
  notification_id INTEGER NOT NULL,
  reader_identity TEXT NOT NULL,
  read_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (notification_id, reader_identity)
);
