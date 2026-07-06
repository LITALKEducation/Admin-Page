-- Web Push (browser/mobile push, works even with the tab closed) subscription
-- registry. One row per device/browser subscription; a subscriber (staff
-- identity or student id) can have several (multiple devices).

CREATE TABLE push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscriber_type TEXT NOT NULL,   -- 'staff' | 'student'
  subscriber_id TEXT NOT NULL,     -- staff identity (email) or student id
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_push_subs_subscriber ON push_subscriptions(subscriber_type, subscriber_id);
