-- "Coming soon" courses.
--
-- available_at: an optional launch timestamp (ISO-8601, UTC). When it is set
-- AND still in the future the course is in "coming soon" mode: a published
-- course shows up in the catalogue and on the home page with a countdown, but
-- enrollment / checkout is blocked until the moment arrives. NULL (the default)
-- means the course is open as soon as it is published, exactly as before.
ALTER TABLE courses ADD COLUMN available_at DATETIME;

-- Upcoming published courses, soonest first — for a "launching soon" strip.
CREATE INDEX idx_courses_available ON courses(status, available_at);
