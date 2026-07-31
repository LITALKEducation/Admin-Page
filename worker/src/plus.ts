// LITALK+ — the monthly/yearly subscription (worker/migrations/0033).
//
// A member gets every course flagged `included_in_plus` without buying them
// individually. Courses without the flag stay one-off purchases, so both
// models run side by side and a course moves between them by flipping one
// column. Nothing here replaces course_enrollments: a course someone bought
// outright stays theirs whether or not they are a member, which is why
// entitlement is "enrolled OR (in Plus AND a member)" rather than one or the
// other. See hasCourseAccess in courses.ts.
//
// Two rules shape the module:
//
//   * Stripe owns the money and the renewal clock. plus_subscriptions is a
//     local mirror, written ONLY by the webhook — never by a portal request —
//     so a client cannot talk itself into a membership.
//   * Access lasts to the end of the paid period. Cancelling sets
//     cancel_at_period_end; the member keeps everything until
//     current_period_end passes. That is why isPlusMember checks the date and
//     not just the status.
import { Hono } from 'hono';
import type { AppBindings, Env } from './types';
import { requireAdmin, portalTokenMatchesStudent } from './auth';
import { loadSurfaceSettings } from './aiSettings';
import { portalMessageCountToday } from './chat';
import { logAudit } from './db';
import {
  createSubscriptionCheckoutSession,
  createBillingPortalSession,
  type StripeSubscription,
} from './stripe';

// 'term' is a school term — 5 months. See planFor() for why the plan is
// resolved from the price id rather than from the billing interval.
export type PlusPlan = 'monthly' | 'term' | 'yearly';

export const PLUS_PLANS: PlusPlan[] = ['monthly', 'term', 'yearly'];

// Statuses Stripe considers a live, paying (or trialing) subscription.
// 'past_due' is deliberately NOT here: Stripe is still retrying the card, and
// the period-end check below already carries someone through a retry window
// they have paid for.
const ENTITLED_STATUSES = new Set(['active', 'trialing']);

export interface PlusRow {
  studentId: string;
  plan: string;
  status: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: number;
}

const PLUS_FIELDS = `student_id AS studentId, plan, status, stripe_customer_id AS stripeCustomerId,
  stripe_subscription_id AS stripeSubscriptionId, current_period_end AS currentPeriodEnd,
  cancel_at_period_end AS cancelAtPeriodEnd`;

export async function loadPlus(db: D1Database, studentId: string): Promise<PlusRow | null> {
  return db
    .prepare(`SELECT ${PLUS_FIELDS} FROM plus_subscriptions WHERE student_id = ? COLLATE NOCASE`)
    .bind(studentId)
    .first<PlusRow>();
}

// Is this row entitled right now? Split out from isPlusMember so a caller that
// already holds the row does not pay for a second query.
export function rowIsEntitled(row: PlusRow | null): boolean {
  if (!row || !ENTITLED_STATUSES.has(row.status)) return false;
  // A missing period end means we have a live status but never learned the
  // clock — trust the status rather than locking a paying member out.
  if (!row.currentPeriodEnd) return true;
  const end = Date.parse(row.currentPeriodEnd);
  return Number.isNaN(end) || end > Date.now();
}

// The question the rest of the Worker asks. Fails CLOSED — unlike the
// maintenance system, a membership check that errors must not hand out access
// it cannot verify — but a thrown query is logged rather than swallowed
// silently, since a permanently failing check would quietly deny paying
// members.
export async function isPlusMember(db: D1Database, studentId: string): Promise<boolean> {
  try {
    return rowIsEntitled(await loadPlus(db, studentId));
  } catch (err) {
    console.error('isPlusMember failed', err);
    return false;
  }
}

// Which plans this deployment actually offers. A plan without a price id is
// simply not offered — the portal hides its button rather than failing on a
// click — so plans can be launched one at a time.
export function configuredPlans(env: Env): Record<PlusPlan, boolean> {
  return {
    monthly: !!env.STRIPE_PLUS_PRICE_MONTHLY,
    term: !!env.STRIPE_PLUS_PRICE_TERM,
    yearly: !!env.STRIPE_PLUS_PRICE_YEARLY,
  };
}

export function anyPlanConfigured(env: Env): boolean {
  return !!env.STRIPE_SECRET_KEY && Object.values(configuredPlans(env)).some(Boolean);
}

/* ===================== Webhook side ===================== */

// Which plan is this subscription on?
//
// Resolved from the PRICE ID against our own config, not from the billing
// interval: the term plan is interval "month" with a count of 5, so reading
// the interval alone would file it as monthly and the member would see the
// wrong plan for five months at a time.
//
// The interval is only a fallback, for a subscription on a price we do not
// know — someone switched plan in Stripe's billing portal to something added
// there and not here. Even then it distinguishes term from monthly by count,
// so the fallback is wrong only for an interval we have never seen.
function planFor(env: Env, sub: StripeSubscription): PlusPlan {
  const priceId = sub.items?.data?.[0]?.price?.id;
  if (priceId) {
    if (priceId === env.STRIPE_PLUS_PRICE_MONTHLY) return 'monthly';
    if (priceId === env.STRIPE_PLUS_PRICE_TERM) return 'term';
    if (priceId === env.STRIPE_PLUS_PRICE_YEARLY) return 'yearly';
  }
  const recurring = sub.items?.data?.[0]?.price?.recurring;
  if (recurring?.interval === 'year') return 'yearly';
  if (recurring?.interval === 'month' && (recurring.interval_count ?? 1) > 1) return 'term';
  return 'monthly';
}

function customerIdOf(sub: StripeSubscription): string | null {
  if (!sub.customer) return null;
  return typeof sub.customer === 'string' ? sub.customer : sub.customer.id ?? null;
}

// Mirror a Stripe subscription into plus_subscriptions. Idempotent: Stripe
// redelivers events, and the same subscription arrives again on every renewal
// and every card change, so this is an upsert keyed on the learner.
//
// studentIdHint covers the one event that may not carry the metadata —
// a checkout.session.completed whose session we still hold.
export async function syncSubscription(
  env: Env,
  sub: StripeSubscription,
  studentIdHint?: string | null,
): Promise<void> {
  const studentId = sub.metadata?.student_id || studentIdHint || null;
  if (!studentId) {
    // Nothing to attach it to. Logged rather than thrown: retrying will not
    // make the metadata appear, and a 500 here would have Stripe redeliver
    // forever.
    console.error('plus: subscription without student_id', sub.id);
    await logAudit(env.DB, null, 'PLUS_SYNC', null, sub.id, false).catch(() => {});
    return;
  }

  const periodEnd = sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null;
  await env.DB.prepare(
    `INSERT INTO plus_subscriptions
       (student_id, plan, status, stripe_customer_id, stripe_subscription_id, current_period_end, cancel_at_period_end, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(student_id) DO UPDATE SET
       plan = excluded.plan,
       status = excluded.status,
       stripe_customer_id = COALESCE(excluded.stripe_customer_id, plus_subscriptions.stripe_customer_id),
       stripe_subscription_id = excluded.stripe_subscription_id,
       current_period_end = excluded.current_period_end,
       cancel_at_period_end = excluded.cancel_at_period_end,
       updated_at = CURRENT_TIMESTAMP`,
  )
    .bind(
      studentId,
      planFor(env, sub),
      sub.status,
      customerIdOf(sub),
      sub.id,
      periodEnd,
      sub.cancel_at_period_end ? 1 : 0,
    )
    .run();
  await logAudit(env.DB, null, 'PLUS_SYNC', studentId, sub.id, true).catch(() => {});
}

/* ===================== Portal routes (before verifyAuth) ===================== */

export const plusPortal = new Hono<AppBindings>();

function planPriceId(env: Env, plan: PlusPlan): string | undefined {
  if (plan === 'yearly') return env.STRIPE_PLUS_PRICE_YEARLY;
  if (plan === 'term') return env.STRIPE_PLUS_PRICE_TERM;
  return env.STRIPE_PLUS_PRICE_MONTHLY;
}

// An unknown plan name from a client falls back to monthly rather than being
// rejected, but only after being checked against the real list — so a typo
// cannot silently charge someone the yearly price.
function normalisePlan(value: unknown): PlusPlan {
  return PLUS_PLANS.includes(value as PlusPlan) ? (value as PlusPlan) : 'monthly';
}

// Only ever redirect back to one of our own origins — the same open-redirect
// guard the course checkout uses for its after-completion URL.
function safeReturnUrl(env: Env, candidate: string | undefined, fallbackPath: string): string {
  const allowed = env.ALLOWED_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean);
  const fallback = `${allowed[0] || 'https://litalkeducation.com'}${fallbackPath}`;
  if (!candidate) return fallback;
  try {
    const url = new URL(candidate);
    if (url.protocol === 'https:' && allowed.some((o) => candidate.startsWith(o))) return candidate;
  } catch {
    /* not a URL */
  }
  return fallback;
}

// What the portal renders its membership panel from.
plusPortal.get('/portal/:studentId/plus', async (c) => {
  const studentId = c.req.param('studentId');
  if (!(await portalTokenMatchesStudent(c, studentId))) {
    return c.json({ status: 'error', message: 'Unauthorized' }, 401);
  }
  const row = await loadPlus(c.env.DB, studentId);
  const member = rowIsEntitled(row);

  // The Lilly quota belongs here rather than behind a second call: the portal
  // needs "what does this person get" as one answer, and showing the remaining
  // free questions BEFORE someone hits the wall is the whole point of the free
  // tier being a way in rather than a dead end.
  const chatSettings = await loadSurfaceSettings(c.env.DB, 'portal');
  const usedToday = member ? 0 : await portalMessageCountToday(c.env.DB, studentId);

  return c.json({
    status: 'success',
    member,
    chat: {
      unlimited: member,
      dailyLimit: chatSettings.dailyLimit,
      usedToday,
      remaining: member ? null : Math.max(0, chatSettings.dailyLimit - usedToday),
    },
    // Absent rather than null when there has never been a subscription, so the
    // portal can tell "never joined" from "joined and lapsed".
    subscription: row
      ? {
          plan: row.plan,
          status: row.status,
          currentPeriodEnd: row.currentPeriodEnd,
          cancelAtPeriodEnd: row.cancelAtPeriodEnd === 1,
        }
      : null,
    // So the page can hide the buttons rather than fail on a click.
    available: anyPlanConfigured(c.env),
    plans: configuredPlans(c.env),
  });
});

// Start a subscription. Returns a Stripe Checkout URL for the portal to send
// the learner to; nothing is granted here — the webhook does that once Stripe
// confirms the first payment.
plusPortal.post('/portal/:studentId/plus/checkout', async (c) => {
  const studentId = c.req.param('studentId');
  if (!(await portalTokenMatchesStudent(c, studentId))) {
    return c.json({ status: 'error', message: 'Unauthorized' }, 401);
  }

  const body = await c.req.json<{ plan?: string; returnUrl?: string }>().catch(() => ({}) as never);
  const plan = normalisePlan(body.plan);

  const existing = await loadPlus(c.env.DB, studentId);
  if (rowIsEntitled(existing)) {
    // Already a member. Changing plan goes through the billing portal, which
    // handles proration; starting a second subscription would bill twice.
    return c.json({ status: 'success', member: true, message: 'คุณเป็นสมาชิก LITALK+ อยู่แล้ว' });
  }

  if (!c.env.STRIPE_SECRET_KEY) return c.json({ status: 'error', message: 'ระบบชำระเงินยังไม่พร้อมใช้งาน' }, 503);
  const priceId = planPriceId(c.env, plan);
  if (!priceId) return c.json({ status: 'error', message: 'ยังไม่ได้ตั้งค่าแพ็กเกจนี้' }, 503);

  const returnUrl = safeReturnUrl(c.env, body.returnUrl, '/study');
  const student = await c.env.DB.prepare(`SELECT email FROM students WHERE id = ? COLLATE NOCASE AND deleted_at IS NULL`)
    .bind(studentId)
    .first<{ email: string | null }>();

  try {
    const session = await createSubscriptionCheckoutSession(c.env.STRIPE_SECRET_KEY, {
      priceId,
      studentId,
      customerEmail: student?.email || undefined,
      successUrl: `${returnUrl}${returnUrl.includes('?') ? '&' : '?'}plus=1`,
      cancelUrl: returnUrl,
    });
    await logAudit(c.env.DB, null, 'PLUS_CHECKOUT', studentId, plan, true);
    return c.json({ status: 'success', url: session.url });
  } catch (err) {
    console.error('plus checkout failed', err);
    return c.json({ status: 'error', message: 'สร้างลิงก์สมัครสมาชิกไม่สำเร็จ' }, 502);
  }
});

// Manage / switch plan / cancel — Stripe's hosted billing portal. Doing this
// ourselves would mean handling card details and failed-payment dunning.
plusPortal.post('/portal/:studentId/plus/manage', async (c) => {
  const studentId = c.req.param('studentId');
  if (!(await portalTokenMatchesStudent(c, studentId))) {
    return c.json({ status: 'error', message: 'Unauthorized' }, 401);
  }
  if (!c.env.STRIPE_SECRET_KEY) return c.json({ status: 'error', message: 'ระบบชำระเงินยังไม่พร้อมใช้งาน' }, 503);

  const row = await loadPlus(c.env.DB, studentId);
  if (!row?.stripeCustomerId) return c.json({ status: 'error', message: 'ไม่พบข้อมูลสมาชิก' }, 404);

  const body = await c.req.json<{ returnUrl?: string }>().catch(() => ({}) as never);
  try {
    const session = await createBillingPortalSession(
      c.env.STRIPE_SECRET_KEY,
      row.stripeCustomerId,
      safeReturnUrl(c.env, body.returnUrl, '/study'),
    );
    return c.json({ status: 'success', url: session.url });
  } catch (err) {
    console.error('plus billing portal failed', err);
    return c.json({ status: 'error', message: 'เปิดหน้าจัดการสมาชิกไม่สำเร็จ' }, 502);
  }
});

/* ===================== Public route (before verifyAuth) ===================== */

// Whether LITALK+ is on sale yet, for the marketing page. Deliberately says
// nothing about anyone — no auth, no student id, just "is there a plan".
//
// The point is that launching is a Stripe dashboard edit, exactly like the
// price: set STRIPE_PLUS_PRICE_MONTHLY / _YEARLY and the "เร็ว ๆ นี้" badge
// turns into a real call to action with no deploy. Fails to `available: false`,
// so the safe answer is the coming-soon one.
plusPortal.get('/plus/public', async (c) => {
  return c.json({
    status: 'success',
    available: anyPlanConfigured(c.env),
    plans: configuredPlans(c.env),
  });
});

/* ===================== Admin routes (after verifyAuth) ===================== */

export const plus = new Hono<AppBindings>();

// Who is a member, and what is each membership doing. Admin-only: it is
// billing data for the whole school, not a per-teacher view.
plus.get('/plus/subscribers', requireAdmin, async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT ps.student_id AS studentId, COALESCE(s.nickname, s.name, ps.student_id) AS studentName,
            s.email AS studentEmail, ps.plan, ps.status, ps.current_period_end AS currentPeriodEnd,
            ps.cancel_at_period_end AS cancelAtPeriodEnd, ps.started_at AS startedAt, ps.updated_at AS updatedAt
       FROM plus_subscriptions ps
       LEFT JOIN students s ON s.id = ps.student_id COLLATE NOCASE
      ORDER BY ps.updated_at DESC LIMIT 1000`,
  ).all();
  const rows = results ?? [];
  const now = Date.now();
  const active = rows.filter(
    (r) =>
      ENTITLED_STATUSES.has(String((r as { status: string }).status)) &&
      (!(r as { currentPeriodEnd: string | null }).currentPeriodEnd ||
        Date.parse(String((r as { currentPeriodEnd: string }).currentPeriodEnd)) > now),
  ).length;
  return c.json({
    status: 'success',
    subscribers: rows,
    counts: { total: rows.length, active },
    configured: !!(c.env.STRIPE_PLUS_PRICE_MONTHLY || c.env.STRIPE_PLUS_PRICE_YEARLY),
  });
});
