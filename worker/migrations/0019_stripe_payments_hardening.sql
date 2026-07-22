-- Stripe payment system hardening: link expiry, refunds, and receipt URLs.

-- Payment links now carry an expiry. A daily scheduled sweep
-- (worker/src/index.ts `scheduled`) deactivates any still-active link past
-- this time and flips status to 'expired', so a link meant for one approval
-- can't quietly be paid weeks later. NULL = never expires (legacy rows).
ALTER TABLE payment_links ADD COLUMN expires_at DATETIME;

-- 'expired' joins the status vocabulary alongside 'active' | 'paid' |
-- 'deactivated' (no CHECK constraint on the column, so this is a doc note).

-- Correlates a recorded payment back to its Stripe PaymentIntent so refund
-- webhooks (charge.refunded) — which only carry the PaymentIntent id, never
-- our checkout-session id — can find the row to update.
ALTER TABLE payments ADD COLUMN stripe_payment_intent_id TEXT;

-- Cumulative amount refunded on this payment (THB), mirrored from Stripe's
-- charge.amount_refunded. 0 = not refunded. Finance nets this out of totals.
ALTER TABLE payments ADD COLUMN refunded_amount REAL NOT NULL DEFAULT 0;
ALTER TABLE payments ADD COLUMN refunded_at DATETIME;

CREATE INDEX idx_payments_payment_intent ON payments(stripe_payment_intent_id);
CREATE INDEX idx_payment_links_expires ON payment_links(expires_at);
