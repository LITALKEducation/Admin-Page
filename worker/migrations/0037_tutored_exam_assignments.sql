-- Student-specific exams for 1-to-1 tutoring.
-- Course assessments continue to use course_items; this table is only for
-- quizzes explicitly issued to one tutored student.
CREATE TABLE IF NOT EXISTS tutored_exam_assignments (
  quiz_id INTEGER PRIMARY KEY,
  student_id TEXT NOT NULL,
  assigned_by TEXT NOT NULL,
  available_from TEXT,
  due_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tutored_exam_student
  ON tutored_exam_assignments(student_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tutored_exam_assigned_by
  ON tutored_exam_assignments(assigned_by, created_at DESC);
