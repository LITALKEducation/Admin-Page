-- Online learning & testing system (ระบบทดสอบและเรียนออนไลน์).
--
-- A quiz bundles an optional Markdown lesson (the "learn" part) with a set
-- of questions (the "test" part). Any staff account (teachers included) can
-- author a quiz; it only becomes visible to students once an admin — or the
-- author, if they publish directly — moves it to 'published'. Mirrors the
-- editorial model already used for blog posts (see 0011_blog.sql), including
-- the author_identity / reviewed_by identity snapshot convention.
CREATE TABLE quizzes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  title_th TEXT,
  -- Short summary shown in the student's quiz list.
  description TEXT,
  description_th TEXT,
  -- Optional Markdown study material shown before the questions — this is
  -- the "learning" half of the system; a quiz can be lesson-only (no
  -- questions) or test-only (no lesson).
  lesson TEXT,
  lesson_th TEXT,
  category TEXT,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'published', 'archived')),
  -- Minutes allowed once a student starts; NULL = untimed.
  time_limit_min INTEGER,
  -- Percent (0-100) of total points needed to pass. 0 = no pass mark.
  pass_score INTEGER NOT NULL DEFAULT 0,
  -- Whether students may retake after a submitted attempt.
  allow_retake INTEGER NOT NULL DEFAULT 1,
  -- Show per-question correctness on the result screen.
  show_answers INTEGER NOT NULL DEFAULT 1,
  author_identity TEXT NOT NULL,   -- staff identity (email/sub) of the author
  author_name TEXT,
  reviewed_by TEXT,                -- admin who published / archived
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  published_at DATETIME
);

CREATE INDEX idx_quizzes_status ON quizzes(status, published_at DESC);
CREATE INDEX idx_quizzes_author ON quizzes(author_identity);

-- Questions belonging to a quiz. `options` and `answer` are JSON so a single
-- table covers every supported question type without a column explosion:
--   single    — one correct choice; options = ["A","B",...], answer = 2 (index)
--   multiple  — several correct; options = [...], answer = [0,3] (indexes)
--   truefalse — options implied; answer = true | false
--   short     — free text; answer = ["accepted", "answers"] (case-insensitive)
CREATE TABLE quiz_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quiz_id INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  type TEXT NOT NULL DEFAULT 'single'
    CHECK (type IN ('single', 'multiple', 'truefalse', 'short')),
  prompt TEXT NOT NULL,
  options TEXT,           -- JSON array of choice strings (single/multiple)
  answer TEXT NOT NULL,   -- JSON: correct answer(s), shape depends on type
  explanation TEXT,       -- optional Markdown shown after grading
  points INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX idx_quiz_questions_quiz ON quiz_questions(quiz_id, position);

-- One row per submitted attempt. `answers` is the JSON map the student sent
-- (question id -> their answer), kept for review; score/max_score are the
-- graded totals in points. A quiz with allow_retake = 0 is capped at one
-- submitted attempt per student, enforced in the Worker.
CREATE TABLE quiz_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quiz_id INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  student_id TEXT NOT NULL,
  answers TEXT,           -- JSON map { questionId: answer }
  score INTEGER NOT NULL DEFAULT 0,
  max_score INTEGER NOT NULL DEFAULT 0,
  passed INTEGER NOT NULL DEFAULT 0,
  started_at DATETIME,
  submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_quiz_attempts_quiz ON quiz_attempts(quiz_id, submitted_at DESC);
CREATE INDEX idx_quiz_attempts_student ON quiz_attempts(student_id, quiz_id);
