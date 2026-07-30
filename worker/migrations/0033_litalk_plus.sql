-- LITALK+ — the monthly/yearly subscription 0030 left groundwork for.
--
-- 0030 added courses.included_in_plus and called LITALK+ "a future
-- subscription". This is that subscription: a learner pays monthly or yearly
-- and gets every course flagged included_in_plus, without buying them one by
-- one. Courses NOT flagged stay one-off purchases, so the two models coexist
-- and a course can move between them by flipping one column.
--
-- Stripe owns the money and the renewal schedule; this table is a local
-- mirror of the parts the Worker has to answer questions about on every
-- request. It is written only by the webhook (worker/src/plus.ts), never by
-- the portal, so a client cannot talk itself into an entitlement.
CREATE TABLE plus_subscriptions (
  -- One subscription per learner. A second checkout for someone who already
  -- has one updates this row rather than adding another, so "is this person
  -- a member" never has to reconcile two answers.
  student_id TEXT PRIMARY KEY,
  plan TEXT NOT NULL,                       -- 'monthly' | 'yearly'
  -- Stripe's own status string, stored verbatim rather than mapped to a local
  -- vocabulary: 'active', 'trialing', 'past_due', 'canceled', 'unpaid', …
  -- Mapping it here would mean re-deploying whenever Stripe adds one.
  status TEXT NOT NULL,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT UNIQUE,
  -- ISO timestamp. Access runs to the end of the paid period even after a
  -- cancellation, which is why entitlement checks this and not just status.
  current_period_end TEXT,
  -- Set when the member has cancelled but the period has not run out. They
  -- keep access; the UI needs to know not to offer "cancel" again.
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- The webhook arrives knowing the Stripe subscription id and nothing else, so
-- that is the lookup it needs. student_id is already the primary key.
CREATE INDEX idx_plus_subscriptions_stripe ON plus_subscriptions(stripe_subscription_id);

-- Answering "who is a member right now" for the admin list.
CREATE INDEX idx_plus_subscriptions_status ON plus_subscriptions(status);
