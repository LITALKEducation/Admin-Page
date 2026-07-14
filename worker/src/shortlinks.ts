// URL shortener for go.litalkeducation.com (general links, any staff can
// create one) and payment.litalkeducation.com (Stripe payment links, default
// slug "<studentId>-<random>"). Both are custom domains routed to this same
// Worker (worker/wrangler.toml) — see shortLinkRedirect below for how a
// request is told apart from the rest of the app.
//
// Redirect lookups hit KV first (fast path, edge-cached) and fall back to D1
// (source of truth) on a miss, repopulating KV. go.* additionally falls back
// to published blog posts by slug, so every article gets a friendly
// go.../<post-slug> link "for free" with no separate short_links row.
import { Hono, type Context } from 'hono';
import type { AppBindings, AuthUser, Env } from './types';
import { isAdmin, requireAdmin } from './auth';
import { logAudit } from './db';

export type ShortDomain = 'go' | 'payment';

const SLUG_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz'; // no 0/O/1/l/i ambiguity
const SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const RESERVED_SLUGS = new Set(['api', 'admin', 'www', 'health', 'favicon.ico', 'robots.txt']);
// A disabled/retargeted link is at most this stale on the redirect path.
const KV_TTL_SECONDS = 6 * 60 * 60;

function randomSlug(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => SLUG_ALPHABET[b % SLUG_ALPHABET.length]).join('');
}

function kvKey(domain: ShortDomain, slug: string): string {
  return `${domain}:${slug}`;
}

function isValidTarget(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export function shortUrl(env: Pick<Env, 'SHORT_DOMAIN_GO' | 'SHORT_DOMAIN_PAYMENT'>, domain: ShortDomain, slug: string): string {
  const host = domain === 'go' ? env.SHORT_DOMAIN_GO : env.SHORT_DOMAIN_PAYMENT;
  return `https://${host}/${slug}`;
}

interface ShortLinkRow {
  id: number;
  domain: ShortDomain;
  slug: string;
  targetUrl: string;
  studentId: string | null;
  title: string | null;
  createdBy: string;
  createdAt: string;
  clickCount: number;
  lastClickedAt: string | null;
  disabledAt: string | null;
}

const LIST_FIELDS = `id, domain, slug, target_url AS targetUrl, student_id AS studentId, title,
  created_by AS createdBy, created_at AS createdAt, click_count AS clickCount, last_clicked_at AS lastClickedAt,
  disabled_at AS disabledAt`;

// Core creation logic shared by the authenticated POST /links endpoint and
// the automatic payment-link wrapping (mintPaymentShortLink below). Retries
// on a slug collision (UNIQUE(domain, slug)) only when the caller left the
// slug up to us; a caller-supplied slug that collides is reported as an
// error instead of silently picking a different one.
export async function createShortLink(
  db: D1Database,
  env: Pick<Env, 'SHORT_DOMAIN_GO' | 'SHORT_DOMAIN_PAYMENT' | 'SHORTLINKS'>,
  opts: {
    domain: ShortDomain;
    target: string;
    slug?: string | null;
    studentId?: string | null;
    title?: string | null;
    createdBy: string;
  },
): Promise<{ ok: true; row: ShortLinkRow; url: string } | { ok: false; error: string }> {
  if (!isValidTarget(opts.target)) return { ok: false, error: 'Invalid target URL' };

  const requestedSlug = opts.slug?.trim() || undefined;
  if (requestedSlug && (!SLUG_RE.test(requestedSlug) || RESERVED_SLUGS.has(requestedSlug.toLowerCase()))) {
    return { ok: false, error: 'Invalid slug — use 1-64 letters, numbers, "-" or "_", starting with a letter/number' };
  }

  const MAX_ATTEMPTS = 10;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const slug =
      requestedSlug ??
      (opts.domain === 'payment' && opts.studentId
        ? `${opts.studentId.replace(/[^a-zA-Z0-9-]/g, '')}-${randomSlug(5)}`
        : randomSlug(7));
    try {
      const result = await db
        .prepare(
          `INSERT INTO short_links (domain, slug, target_url, student_id, title, created_by)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(opts.domain, slug, opts.target, opts.studentId ?? null, opts.title ?? null, opts.createdBy)
        .run();
      const row: ShortLinkRow = {
        id: Number(result.meta.last_row_id),
        domain: opts.domain,
        slug,
        targetUrl: opts.target,
        studentId: opts.studentId ?? null,
        title: opts.title ?? null,
        createdBy: opts.createdBy,
        createdAt: new Date().toISOString(),
        clickCount: 0,
        lastClickedAt: null,
        disabledAt: null,
      };
      await env.SHORTLINKS.put(kvKey(opts.domain, slug), JSON.stringify({ id: row.id, target: opts.target }), {
        expirationTtl: KV_TTL_SECONDS,
      });
      return { ok: true, row, url: shortUrl(env, opts.domain, slug) };
    } catch (err) {
      if (String(err).includes('UNIQUE')) {
        if (requestedSlug) return { ok: false, error: 'This slug is already taken' };
        continue; // random collision — retry with a fresh slug
      }
      throw err;
    }
  }
  return { ok: false, error: 'Could not generate a unique slug, try again' };
}

// Best-effort: wraps a freshly-created Stripe payment link in a
// payment.litalkeducation.com/<studentId>-<random> short link. Never throws
// — a shortener hiccup must never block recording the payment link itself.
export async function mintPaymentShortLink(
  db: D1Database,
  env: Pick<Env, 'SHORT_DOMAIN_GO' | 'SHORT_DOMAIN_PAYMENT' | 'SHORTLINKS'>,
  opts: { target: string; studentId?: string | null; createdBy: string },
): Promise<string | null> {
  try {
    const result = await createShortLink(db, env, {
      domain: 'payment',
      target: opts.target,
      studentId: opts.studentId,
      createdBy: opts.createdBy,
    });
    return result.ok ? result.url : null;
  } catch (err) {
    console.error('mintPaymentShortLink: failed, continuing without a short URL', err);
    return null;
  }
}

async function bumpClick(db: D1Database, id: number | null): Promise<void> {
  if (!id) return;
  await db
    .prepare(`UPDATE short_links SET click_count = click_count + 1, last_clicked_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .bind(id)
    .run()
    .catch(() => {});
}

// ===== Public redirect — mounted first in index.ts, before CORS/auth =====
// Only engages for the two shortener hostnames; every other request (the
// admin panel, the public site, the student portal) falls through via
// next() completely untouched.
export async function shortLinkRedirect(c: Context<AppBindings>, next: () => Promise<void>): Promise<Response | void> {
  const host = (c.req.header('host') || '').toLowerCase().split(':')[0];
  const domain: ShortDomain | null =
    host === c.env.SHORT_DOMAIN_GO ? 'go' : host === c.env.SHORT_DOMAIN_PAYMENT ? 'payment' : null;
  if (!domain) return next();

  const slug = decodeURIComponent(c.req.path.replace(/^\/+/, ''));
  if (!slug) return c.redirect('https://litalkeducation.com', 302);

  const cached = await c.env.SHORTLINKS.get(kvKey(domain, slug));
  if (cached) {
    try {
      const { id, target } = JSON.parse(cached) as { id: number | null; target: string };
      c.executionCtx.waitUntil(bumpClick(c.env.DB, id));
      return c.redirect(target, 302);
    } catch {
      // corrupt cache entry — fall through to D1 below
    }
  }

  const row = await c.env.DB.prepare(
    `SELECT id, target_url AS target FROM short_links WHERE domain = ? AND slug = ? AND disabled_at IS NULL`,
  )
    .bind(domain, slug)
    .first<{ id: number; target: string }>();

  if (row) {
    c.executionCtx.waitUntil(
      c.env.SHORTLINKS.put(kvKey(domain, slug), JSON.stringify({ id: row.id, target: row.target }), {
        expirationTtl: KV_TTL_SECONDS,
      }),
    );
    c.executionCtx.waitUntil(bumpClick(c.env.DB, row.id));
    return c.redirect(row.target, 302);
  }

  // go.* only: every published blog post is reachable at go.../<slug> with
  // no short_links row of its own — the post's slug already is the
  // shortlink, it just needed the friendly hostname.
  if (domain === 'go') {
    const post = await c.env.DB.prepare(`SELECT slug FROM blog_posts WHERE slug = ? AND status = 'published'`)
      .bind(slug)
      .first<{ slug: string }>();
    if (post) {
      const target = `https://litalkeducation.com/blog-post?slug=${encodeURIComponent(post.slug)}`;
      c.executionCtx.waitUntil(
        c.env.SHORTLINKS.put(kvKey('go', slug), JSON.stringify({ id: null, target }), { expirationTtl: KV_TTL_SECONDS }),
      );
      return c.redirect(target, 302);
    }
  }

  return c.text('Link not found', 404);
}

// ===== Authenticated management routes — mounted after verifyAuth =====

const shortLinks = new Hono<AppBindings>();

function canManage(user: AuthUser, row: { createdBy: string }): boolean {
  return isAdmin(user) || row.createdBy.toLowerCase() === user.email.toLowerCase();
}

// Any signed-in staff (teacher, staff, admin) can shorten a link — this is a
// self-service utility, not a privileged action.
shortLinks.post('/links', async (c) => {
  const user = c.get('user');
  const body = await c.req
    .json<{ domain?: string; target?: string; slug?: string; studentId?: string; title?: string }>()
    .catch(() => ({}) as never);

  if (body.domain !== 'go' && body.domain !== 'payment') return c.json({ error: 'domain must be "go" or "payment"' }, 400);
  if (!body.target?.trim()) return c.json({ error: 'Missing target' }, 400);

  const result = await createShortLink(c.env.DB, c.env, {
    domain: body.domain,
    target: body.target.trim(),
    slug: body.slug,
    studentId: body.studentId?.trim() || null,
    title: body.title?.trim() || null,
    createdBy: user.email,
  });
  if (!result.ok) return c.json({ error: result.error }, 400);

  await logAudit(c.env.DB, user, 'CREATE_SHORT_LINK', body.studentId ?? null, `${result.row.domain}/${result.row.slug}`, true);
  return c.json({
    ok: true,
    id: result.row.id,
    domain: result.row.domain,
    slug: result.row.slug,
    url: result.url,
    target: result.row.targetUrl,
  });
});

// Admins see every link; other staff see only the ones they created.
shortLinks.get('/links', async (c) => {
  const user = c.get('user');
  const domain = c.req.query('domain');
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (!isAdmin(user)) {
    conditions.push('created_by = ? COLLATE NOCASE');
    params.push(user.email);
  }
  if (domain === 'go' || domain === 'payment') {
    conditions.push('domain = ?');
    params.push(domain);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const { results } = await c.env.DB.prepare(`SELECT ${LIST_FIELDS} FROM short_links ${where} ORDER BY id DESC LIMIT 200`)
    .bind(...params)
    .all<ShortLinkRow>();
  const rows = (results ?? []).map((r) => ({ ...r, url: shortUrl(c.env, r.domain, r.slug) }));
  return c.json(rows);
});

// The creator or an admin can remove a link (e.g. a mistyped slug or a
// payment link that's no longer wanted).
shortLinks.delete('/links/:id', async (c) => {
  const user = c.get('user');
  const id = Number(c.req.param('id'));
  const row = await c.env.DB.prepare(`SELECT ${LIST_FIELDS} FROM short_links WHERE id = ?`).bind(id).first<ShortLinkRow>();
  if (!row) return c.json({ error: 'Not found' }, 404);
  if (!canManage(user, row)) return c.json({ error: 'Forbidden' }, 403);

  await c.env.DB.prepare(`DELETE FROM short_links WHERE id = ?`).bind(id).run();
  await c.env.SHORTLINKS.delete(kvKey(row.domain, row.slug));
  await logAudit(c.env.DB, user, 'DELETE_SHORT_LINK', row.studentId, `${row.domain}/${row.slug}`, true);
  return c.json({ ok: true });
});

// Suspend/resume a link without losing its click history — admin only
// (unlike delete, which the creator can also do). Both purge the KV cache
// entry so the change takes effect on the very next redirect instead of
// waiting out the ~6h TTL: a disable falls through to D1 (which now
// excludes it) and 404s; an enable falls through to D1 and gets re-cached.
shortLinks.post('/links/:id/disable', requireAdmin, async (c) => {
  const user = c.get('user');
  const id = Number(c.req.param('id'));
  const row = await c.env.DB.prepare(`SELECT ${LIST_FIELDS} FROM short_links WHERE id = ?`).bind(id).first<ShortLinkRow>();
  if (!row) return c.json({ error: 'Not found' }, 404);

  await c.env.DB.prepare(`UPDATE short_links SET disabled_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(id).run();
  await c.env.SHORTLINKS.delete(kvKey(row.domain, row.slug));
  await logAudit(c.env.DB, user, 'DISABLE_SHORT_LINK', row.studentId, `${row.domain}/${row.slug}`, true);
  return c.json({ ok: true });
});

shortLinks.post('/links/:id/enable', requireAdmin, async (c) => {
  const user = c.get('user');
  const id = Number(c.req.param('id'));
  const row = await c.env.DB.prepare(`SELECT ${LIST_FIELDS} FROM short_links WHERE id = ?`).bind(id).first<ShortLinkRow>();
  if (!row) return c.json({ error: 'Not found' }, 404);

  await c.env.DB.prepare(`UPDATE short_links SET disabled_at = NULL WHERE id = ?`).bind(id).run();
  await c.env.SHORTLINKS.delete(kvKey(row.domain, row.slug));
  await logAudit(c.env.DB, user, 'ENABLE_SHORT_LINK', row.studentId, `${row.domain}/${row.slug}`, true);
  return c.json({ ok: true });
});

export default shortLinks;
