-- Requests to add or withdraw class hours on an already-approved/active
-- monthly schedule (teacher-submitted, admin-approved — or admin-direct).

CREATE TABLE schedule_amendments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  schedule_id INTEGER NOT NULL,
  student_id TEXT NOT NULL,
  type TEXT NOT NULL,                      -- 'add' | 'remove'
  sessions TEXT NOT NULL,                  -- JSON array of {date,time}
  rate_per_session REAL NOT NULL,
  credits_used REAL NOT NULL DEFAULT 0,
  charge_amount REAL NOT NULL DEFAULT 0,
  payment_link_id INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'awaiting_payment' | 'applied' | 'rejected' | 'cancelled'
  note TEXT,
  reject_reason TEXT,
  created_by TEXT,
  approved_by TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  approved_at DATETIME,
  applied_at DATETIME
);

CREATE INDEX idx_schedule_amendments_schedule ON schedule_amendments(schedule_id);
CREATE INDEX idx_schedule_amendments_status ON schedule_amendments(status);
