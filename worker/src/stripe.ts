// Minimal Stripe REST client for Workers (no SDK): form-encoded requests
// against api.stripe.com plus webhook signature verification via WebCrypto.

const STRIPE_API = 'https://api.stripe.com';

export class StripeError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function stripeRequest<T>(
  secretKey: string,
  method: 'GET' | 'POST',
  path: string,
  params?: Record<string, string>,
): Promise<T> {
  // GET requests can't carry a body — params go on the query string instead.
  const query = params && method === 'GET' ? `?${new URLSearchParams(params).toString()}` : '';
  const body = params && method === 'POST' ? new URLSearchParams(params).toString() : undefined;
  const res = await fetch(`${STRIPE_API}${path}${query}`, {
    method,
    headers: {
      Authorization: `Bearer ${secretKey}`,
      ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body,
  });
  const json = (await res.json()) as T & { error?: { message?: string } };
  if (!res.ok) {
    throw new StripeError(res.status, json.error?.message ?? `Stripe API error (HTTP ${res.status})`);
  }
  return json;
}

export interface CreatedPaymentLink {
  id: string;
  url: string;
}

// Shown on every Stripe checkout page this system creates — paying is
// treated as accepting this policy, so it's appended rather than optional.
export const STRIPE_POLICY_NOTE = 'หากชำระเงินแล้วแสดงว่ายอมรับนโยบายของเรา และไม่มีการเรียกขอเงินคืน';

// Appends the policy note to a (possibly empty) description.
export function withPolicyNote(text?: string): string {
  const base = (text ?? '').trim();
  return base ? `${base} · ${STRIPE_POLICY_NOTE}` : STRIPE_POLICY_NOTE;
}

// Payment Links require a Price object, so create an inline product+price
// first, then the link. The link is single-use (one completed session) since
// each link is an invoice for one specific student/customer.
export async function createStripePaymentLink(
  secretKey: string,
  opts: {
    productName: string;
    productDescription?: string;
    amountSatang: number; // THB x100
    currency: string;
    metadata: Record<string, string>;
  },
): Promise<CreatedPaymentLink> {
  // Stripe's price-create endpoint only accepts a handful of product_data
  // fields (name, metadata, active, statement_descriptor, tax_code,
  // unit_label) — description is NOT one of them, so it must not be sent
  // here (Stripe rejects it as an unknown parameter).
  const price = await stripeRequest<{ id: string }>(secretKey, 'POST', '/v1/prices', {
    unit_amount: String(opts.amountSatang),
    currency: opts.currency,
    'product_data[name]': opts.productName,
  });

  const params: Record<string, string> = {
    'line_items[0][price]': price.id,
    'line_items[0][quantity]': '1',
    'restrictions[completed_sessions][limit]': '1',
    // Lets the payer enter a Stripe promotion code on the checkout page.
    // Stripe applies the discount itself; the webhook already records
    // whatever `amount_total` it reports, so no other change is needed.
    allow_promotion_codes: 'true',
    // The description belongs on the resulting PaymentIntent instead, where
    // it shows up on the checkout page, receipt, and dashboard.
    ...(opts.productDescription ? { 'payment_intent_data[description]': opts.productDescription } : {}),
  };
  for (const [k, v] of Object.entries(opts.metadata)) {
    params[`metadata[${k}]`] = v;
  }
  const link = await stripeRequest<{ id: string; url: string }>(secretKey, 'POST', '/v1/payment_links', params);
  return { id: link.id, url: link.url };
}

export async function deactivateStripePaymentLink(secretKey: string, paymentLinkId: string): Promise<void> {
  await stripeRequest(secretKey, 'POST', `/v1/payment_links/${paymentLinkId}`, { active: 'false' });
}

export interface PromotionCodeSummary {
  id: string;
  code: string;
  description: string; // e.g. "10% off" or "50 THB off", for the admin dropdown
}

// Lists currently-redeemable promotion codes so the admin can pick one
// instead of typing it (and risking a typo/inactive code).
export async function listActivePromotionCodes(secretKey: string): Promise<PromotionCodeSummary[]> {
  const res = await stripeRequest<{
    data: Array<{
      code: string;
      id: string;
      coupon: { percent_off?: number | null; amount_off?: number | null; currency?: string | null; name?: string | null };
    }>;
  }>(secretKey, 'GET', '/v1/promotion_codes', { active: 'true', limit: '100' });
  return res.data.map((pc) => ({
    id: pc.id,
    code: pc.code,
    description: pc.coupon.percent_off
      ? `${pc.coupon.percent_off}%`
      : pc.coupon.amount_off
        ? `${(pc.coupon.amount_off / 100).toFixed(0)} ${(pc.coupon.currency ?? '').toUpperCase()}`
        : pc.coupon.name ?? '',
  }));
}

// Payment Links have no create-time "apply this coupon" parameter (that's
// Checkout-Sessions-only, and mutually exclusive with allow_promotion_codes
// anyway). Instead Stripe pre-fills the promo code field via a URL param —
// the payer can still edit or clear it before paying.
export function withPrefilledPromoCode(url: string, promoCode?: string): string {
  if (!promoCode) return url;
  const withParam = new URL(url);
  withParam.searchParams.set('prefilled_promo_code', promoCode);
  return withParam.toString();
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Verifies a `Stripe-Signature` header (t=...,v1=...) against the raw body.
export async function verifyStripeSignature(
  payload: string,
  sigHeader: string | undefined,
  webhookSecret: string,
  toleranceSeconds = 300,
): Promise<boolean> {
  if (!sigHeader) return false;

  let timestamp = '';
  const signatures: string[] = [];
  for (const part of sigHeader.split(',')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key === 't') timestamp = value;
    else if (key === 'v1') signatures.push(value);
  }
  if (!timestamp || signatures.length === 0) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > toleranceSeconds) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(webhookSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${payload}`));
  const expected = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');

  return signatures.some((sig) => timingSafeEqualHex(sig, expected));
}
