-- Blog posts for the public website (litalkeducation.com/blog).
-- Written in the admin console: teachers submit posts that an admin
-- approves before they go live; admins can publish directly.
-- Content is Markdown; EN is the primary language, TH fields optional.
CREATE TABLE blog_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  title_th TEXT,
  excerpt TEXT,
  excerpt_th TEXT,
  content TEXT NOT NULL,
  content_th TEXT,
  category TEXT,
  cover_key TEXT,   -- R2 object key of the cover image
  cover_mime TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'published', 'rejected')),
  author_identity TEXT NOT NULL,  -- staff identity (email/sub) of the writer
  author_name TEXT,
  reviewed_by TEXT,               -- admin who approved / rejected
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  published_at DATETIME
);

CREATE INDEX idx_blog_posts_public ON blog_posts(status, published_at DESC);
CREATE INDEX idx_blog_posts_author ON blog_posts(author_identity);
