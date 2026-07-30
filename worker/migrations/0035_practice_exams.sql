-- โหมดติวสอบ — practice exams น้องลิลลี่ generates, a LITALK+ benefit.
--
-- Deliberately NOT stored in `quizzes`. A generated exam belongs to one
-- learner, was never reviewed by a teacher, and must never appear in the
-- catalogue, in a course, or in the admin editor. Putting it in `quizzes`
-- would mean every existing listing query needed an extra "and not generated"
-- filter, and the first one anybody forgot would leak AI-written questions
-- into the school's published content. A separate table cannot leak that way.
--
-- One exam is one sitting, so the attempt lives on the same row rather than in
-- a second table: there is no retake — the learner generates a fresh exam,
-- which is the point of the mode.
CREATE TABLE practice_exams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id TEXT NOT NULL,
  -- The lesson it was generated from, when it was generated from one. NULL for
  -- a free-topic exam. Not a foreign key: deleting a lesson should not delete
  -- a learner's score history.
  source_quiz_id INTEGER,
  -- What the learner asked to be tested on, for the history list.
  topic TEXT,
  -- JSON array in the same shape quiz_questions uses, answers included. Never
  -- sent to the browser before grading — see slides of that rule in
  -- quizzes.ts; the portal gets prompts and options only.
  questions TEXT NOT NULL,
  question_count INTEGER NOT NULL DEFAULT 0,
  -- NULL until submitted, which is also how "unfinished" is detected.
  answers TEXT,
  score INTEGER,
  max_score INTEGER,
  submitted_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- The history list, newest first, for one learner.
CREATE INDEX idx_practice_exams_student ON practice_exams(student_id, id DESC);
