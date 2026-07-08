-- Stripe discount support (see worker/src/stripe.ts):
-- `promo_code` is a promotion code the admin pre-fills into the checkout
-- URL (?prefilled_promo_code=...) when creating a link; the payer can
-- still edit or clear it. `discount_amount` is populated by the webhook
-- once the link is paid, from Stripe's reported total_details.amount_discount.
ALTER TABLE payment_links ADD COLUMN promo_code TEXT;
ALTER TABLE payment_links ADD COLUMN discount_amount REAL;
