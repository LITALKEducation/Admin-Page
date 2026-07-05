-- Student check menu, monthly schedules with admin approval, and
-- per-teacher student visibility.

-- Soft-delete for students: "deleting" a student removes them from the app
-- only — their Auth0 login account is intentionally left untouched.
ALTER TABLE students ADD COLUMN deleted_at DATETIME;

-- Which students each teacher may see (admin-managed). A teacher with no
-- rows here sees every student (legacy behaviour); once the admin assigns at
-- least one student to a teacher, that teacher sees only the listed students.
CREATE TABLE teacher_students (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  teacher_email TEXT NOT NULL,
  student_id TEXT NOT NULL,
  created_by TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(teacher_email, student_id)
);

CREATE INDEX idx_teacher_students_teacher ON teacher_students(teacher_email);

-- Monthly class schedules: a teacher plans a month of sessions for one
-- student ('pending'), an admin approves it ('approved', optionally creating
-- a Stripe payment link to forward to the parent), and a successful payment
-- activates it ('active'), which materialises the sessions as bookings.
CREATE TABLE monthly_schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id TEXT NOT NULL,
  month TEXT NOT NULL,                     -- YYYY-MM
  rate_per_session REAL NOT NULL,          -- THB per session
  total_amount REAL NOT NULL,              -- rate_per_session * session count
  note TEXT,
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'approved' | 'active' | 'rejected' | 'cancelled'
  payment_link_id INTEGER,                 -- payment_links.id created on approval
  created_by TEXT,                         -- teacher email
  approved_by TEXT,
  approved_at DATETIME,
  activated_at DATETIME,
  reject_reason TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_schedules_student ON monthly_schedules(student_id);
CREATE INDEX idx_schedules_status ON monthly_schedules(status);

CREATE TABLE schedule_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  schedule_id INTEGER NOT NULL,
  session_date TEXT NOT NULL,              -- YYYY-MM-DD
  session_time TEXT NOT NULL,              -- HH:MM
  UNIQUE(schedule_id, session_date, session_time)
);

CREATE INDEX idx_schedule_sessions_schedule ON schedule_sessions(schedule_id);
