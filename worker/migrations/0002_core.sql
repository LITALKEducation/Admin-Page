-- Core admin data, migrated off Google Sheets: students, study logs,
-- payments, bookings, and Stripe payment links.

CREATE TABLE students (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  nickname TEXT,
  email TEXT,
  phone TEXT,
  course TEXT,
  created_by TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE study_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id TEXT NOT NULL,
  log_date TEXT NOT NULL,            -- YYYY-MM-DD
  feedback TEXT,
  video_url TEXT,
  created_by TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_study_logs_student ON study_logs(student_id);
CREATE INDEX idx_study_logs_date ON study_logs(log_date);

CREATE TABLE payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id TEXT,                   -- NULL for non-student Stripe customers
  amount REAL NOT NULL,              -- THB
  method TEXT,
  paid_date TEXT NOT NULL,           -- YYYY-MM-DD
  proof_url TEXT,
  source TEXT NOT NULL DEFAULT 'manual',   -- 'manual' | 'stripe'
  stripe_payment_link_id TEXT,
  stripe_session_id TEXT UNIQUE,     -- webhook idempotency key
  recorded_by TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_payments_student ON payments(student_id);
CREATE INDEX idx_payments_date ON payments(paid_date);

CREATE TABLE bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id TEXT NOT NULL,
  booking_date TEXT NOT NULL,        -- YYYY-MM-DD
  booking_time TEXT NOT NULL,        -- HH:MM (start of a 1-hour slot)
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'booked',   -- 'booked' | 'cancelled'
  created_by TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(booking_date, booking_time)       -- slot conflict guard
);

CREATE INDEX idx_bookings_student ON bookings(student_id);
CREATE INDEX idx_bookings_date ON bookings(booking_date);

CREATE TABLE payment_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stripe_payment_link_id TEXT NOT NULL UNIQUE,
  url TEXT NOT NULL,
  student_id TEXT,
  customer_name TEXT,                -- display name (student name or free-text customer)
  description TEXT,
  amount REAL NOT NULL,              -- THB
  currency TEXT NOT NULL DEFAULT 'thb',
  status TEXT NOT NULL DEFAULT 'active',   -- 'active' | 'paid' | 'deactivated'
  created_by TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_payment_links_status ON payment_links(status);
