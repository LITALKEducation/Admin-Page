-- Lesson videos stored in R2 instead of on YouTube.
--
-- video_url stays: a quiz can point at YouTube/Vimeo as before, or carry a
-- file in R2, and the player picks whichever is set. Keeping both means the
-- switch can happen course by course rather than as one migration of content,
-- and a course whose video is already on YouTube needs no re-upload.
--
-- When both are set the R2 file wins — it is the one the school controls.
ALTER TABLE quizzes ADD COLUMN video_key TEXT;
ALTER TABLE quizzes ADD COLUMN video_mime TEXT;
-- Bytes. Kept so the admin list can show a size without a HEAD to R2, and so
-- an interrupted upload that never completed is visible as a NULL.
ALTER TABLE quizzes ADD COLUMN video_size INTEGER;
-- Original filename, for the admin UI only.
ALTER TABLE quizzes ADD COLUMN video_name TEXT;

-- Short-lived playback tickets.
--
-- A <video src> cannot carry an Authorization header, so the stream endpoint
-- has to authenticate from the URL itself. The portal asks for a ticket over
-- the normal authenticated API — that call is where ownership and the course
-- sequencing gate are checked — and plays the URL the ticket is embedded in.
--
-- Same shape and reasoning as id_card_tokens (0018): an opaque random value
-- in D1 with an expiry, so a copied URL stops working on its own and a
-- revoked one stops working immediately. Bound to BOTH the quiz and the
-- student, so a ticket that does leak opens exactly the one lesson its owner
-- was already entitled to.
CREATE TABLE quiz_video_tickets (
  token TEXT PRIMARY KEY,
  quiz_id INTEGER NOT NULL,
  student_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,          -- ISO timestamp, compared in JS
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Reissuing deletes this student's previous ticket for the quiz, so the table
-- stays roughly one row per student per lesson rather than growing per view.
CREATE INDEX idx_quiz_video_tickets_owner ON quiz_video_tickets(quiz_id, student_id);
