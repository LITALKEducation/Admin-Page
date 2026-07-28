-- Structured learning flow: teaching videos + Pretest → Lessons → Posttest.
--
-- A lesson is now "watch a video, then take the test". Each quiz can carry a
-- video (YouTube / Vimeo / direct file URL) shown before its questions.
ALTER TABLE quizzes ADD COLUMN video_url TEXT;

-- A course arranges its quizzes into a fixed path: one optional pretest, any
-- number of lessons, one optional posttest. `kind` marks each item's role so
-- the portal can gate the sequence:
--   * pretest  — must be taken first, before any lesson unlocks
--   * lesson   — a video + test; taken in any order once the pretest is done
--   * posttest — unlocks only after every lesson is completed
ALTER TABLE course_items ADD COLUMN kind TEXT NOT NULL DEFAULT 'lesson';
-- Values: 'pretest' | 'lesson' | 'posttest' (no CHECK constraint so this
-- ALTER stays reversible; the Worker validates on write).
