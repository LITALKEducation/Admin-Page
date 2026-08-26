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

-- A quiz belongs to exactly one teaching workflow: either a reusable course
-- assessment/content item or a student-specific 1-to-1 exam, never both.
CREATE TRIGGER IF NOT EXISTS trg_tutored_exam_not_course_item
BEFORE INSERT ON tutored_exam_assignments
WHEN EXISTS (SELECT 1 FROM course_items WHERE quiz_id = NEW.quiz_id)
BEGIN
  SELECT RAISE(ABORT, 'course assessment cannot be assigned as a tutored exam');
END;

CREATE TRIGGER IF NOT EXISTS trg_course_item_not_tutored_exam
BEFORE INSERT ON course_items
WHEN EXISTS (SELECT 1 FROM tutored_exam_assignments WHERE quiz_id = NEW.quiz_id)
BEGIN
  SELECT RAISE(ABORT, 'tutored exam cannot be added to a course');
END;
