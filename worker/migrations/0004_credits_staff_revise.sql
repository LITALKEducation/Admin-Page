-- Staff display names, class-hour credits, schedule revision/edit support,
-- and public file links.

-- Maps a login identity (the string a request's token carries — an email
-- when the Auth0 email Action is set up, otherwise an auth0|... sub) to a
-- human name, so the UI can show names instead of raw subs.
CREATE TABLE staff (
  identity TEXT PRIMARY KEY,          -- matches AuthUser.email
  name TEXT,
  is_admin INTEGER NOT NULL DEFAULT 0,
  last_seen DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Class-hour credit ledger (1 credit = 1 hour = 1 session). Positive rows
-- add credit (e.g. an admin trimming a paid schedule); negative rows spend
-- it (a new schedule consuming credit before charging money). A student's
-- balance is SUM(hours).
CREATE TABLE student_credits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id TEXT NOT NULL,
  hours REAL NOT NULL,               -- signed: + earned, - spent
  reason TEXT,
  schedule_id INTEGER,               -- schedule that earned/spent it, if any
  created_by TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_student_credits_student ON student_credits(student_id);

-- credits_applied: hours currently reserved from the ledger for this
-- schedule (spent up front, released if it never gets paid).
-- revise_note: an admin's "please revise" message shown to the teacher.
ALTER TABLE monthly_schedules ADD COLUMN credits_applied REAL NOT NULL DEFAULT 0;
ALTER TABLE monthly_schedules ADD COLUMN revise_note TEXT;

-- Opaque token for a shareable public download link (NULL until requested).
ALTER TABLE student_files ADD COLUMN public_token TEXT;
CREATE UNIQUE INDEX idx_student_files_public_token ON student_files(public_token);
