-- Images inserted inline into a blog post's Markdown content (separate from
-- the single per-post cover image in blog_posts.cover_key). Tracked in their
-- own table so the public serving route only ever streams R2 objects that
-- were actually uploaded through the blog editor, never an arbitrary key.
CREATE TABLE blog_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  r2_key TEXT NOT NULL UNIQUE,
  mime TEXT NOT NULL,
  author_identity TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
