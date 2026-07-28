-- Cover image for a course, shown on the public catalogue and course cards.
-- Stored in R2 like blog covers (see 0011_blog.sql); the DB only holds the
-- object key + mime type, never the bytes.
ALTER TABLE courses ADD COLUMN cover_key TEXT;   -- R2 object key of the cover image
ALTER TABLE courses ADD COLUMN cover_mime TEXT;
