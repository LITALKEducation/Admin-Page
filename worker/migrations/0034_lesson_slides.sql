-- Lesson slides, downloadable as PDF — a LITALK+ benefit.
--
-- Attached to a quiz, exactly like the lesson video in 0032: a quiz already IS
-- a lesson here (video + text + questions), so the slides for that lesson
-- belong on the same row rather than in a table that would need its own
-- ownership and access rules. The "library" the tier list describes is then
-- just the set of these across the lessons a learner can reach — see
-- GET /portal/:studentId/slides.
--
-- Unlike a video this needs no multipart upload and no Range serving: a slide
-- deck is comfortably inside a Worker's request body, and a PDF is fetched
-- whole rather than seeked. It also needs no playback ticket, because a
-- download can go through an ordinary authenticated fetch — nothing here has
-- to survive being put in an element's src attribute.
ALTER TABLE quizzes ADD COLUMN slide_key TEXT;
ALTER TABLE quizzes ADD COLUMN slide_mime TEXT;
-- Bytes, so the lesson page can show a size before someone starts a download
-- on mobile data.
ALTER TABLE quizzes ADD COLUMN slide_size INTEGER;
-- Original filename, shown in the admin editor and used for the download name.
ALTER TABLE quizzes ADD COLUMN slide_name TEXT;
