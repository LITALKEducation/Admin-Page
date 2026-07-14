-- URL shortener (see worker/src/shortlinks.ts):
--   go.litalkeducation.com       — general-purpose links; also transparently
--                                   serves every published blog post at
--                                   go.../<post-slug> with no row needed here.
--   payment.litalkeducation.com  — Stripe payment links; default slug is
--                                   "<studentId>-<random>" when none is given.
CREATE TABLE short_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL CHECK (domain IN ('go', 'payment')),
  slug TEXT NOT NULL,
  target_url TEXT NOT NULL,
  student_id TEXT,
  title TEXT,
  created_by TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  click_count INTEGER NOT NULL DEFAULT 0,
  last_clicked_at DATETIME,
  -- Set by an admin (POST /links/:id/disable) to suspend a link without
  -- losing its click history; cleared by POST /links/:id/enable.
  disabled_at DATETIME,
  UNIQUE(domain, slug)
);

CREATE INDEX idx_short_links_student ON short_links(student_id);
CREATE INDEX idx_short_links_created_by ON short_links(created_by);

-- Cache of the short link minted automatically for a Stripe payment link
-- (payment.litalkeducation.com/<studentId>-<random>), so the admin UI can
-- offer the short URL instead of the long Stripe checkout URL.
ALTER TABLE payment_links ADD COLUMN short_url TEXT;
