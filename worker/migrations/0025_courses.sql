-- Paid courses (คอร์สเรียน). A course bundles one or more published quizzes
-- / lessons (see 0024_quizzes.sql) behind a one-time Stripe payment: a student
-- pays, the checkout webhook records an enrollment, and enrollment unlocks the
-- course's quizzes in the portal. Standalone published quizzes that belong to
-- no course stay free and open as before.
--
-- Authoring mirrors the blog/quiz editorial model: any staff can create a
-- course, an admin publishes it.
CREATE TABLE courses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  title_th TEXT,
  description TEXT,
  description_th TEXT,
  -- Optional Markdown overview shown on the course page before purchase.
  overview TEXT,
  overview_th TEXT,
  category TEXT,
  -- Price in the currency's smallest unit (THB satang = THB x100), matching
  -- Stripe's unit_amount. 0 = free (enroll without checkout).
  price_satang INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'thb',
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'published', 'archived')),
  author_identity TEXT NOT NULL,
  author_name TEXT,
  reviewed_by TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  published_at DATETIME
);

CREATE INDEX idx_courses_status ON courses(status, published_at DESC);
CREATE INDEX idx_courses_author ON courses(author_identity);

-- The quizzes/lessons that make up a course, in display order. A quiz may
-- belong to at most one course (UNIQUE quiz_id) — that's what makes it a
-- "paid" quiz gated behind that course rather than a free standalone one.
CREATE TABLE course_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  quiz_id INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  UNIQUE(quiz_id)
);

CREATE INDEX idx_course_items_course ON course_items(course_id, position);

-- One row per student granted access to a course. Written by the Stripe
-- checkout webhook (recordCheckoutPayment in index.ts) on payment, or directly
-- for a free (price 0) course. UNIQUE(course_id, student_id) makes a
-- redelivered webhook a no-op.
CREATE TABLE course_enrollments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  student_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked')),
  amount REAL NOT NULL DEFAULT 0,          -- THB actually paid (0 for free)
  stripe_session_id TEXT,                  -- checkout session that granted it
  enrolled_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(course_id, student_id)
);

CREATE INDEX idx_course_enrollments_student ON course_enrollments(student_id, status);
CREATE INDEX idx_course_enrollments_course ON course_enrollments(course_id);
