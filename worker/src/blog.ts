// Blog system: public read endpoints for the website (litalkeducation.com/blog)
// plus the authenticated management endpoints used by the admin console.
//
// Editorial flow: any staff account (teachers included) can write a post, but
// a post only goes live once an admin publishes it. Non-admin edits send a
// post back to 'pending' for re-approval. Admin status doubles as the
// "staff who can approve" marker, matching the rest of the app (see
// ADMIN_PERMISSION in auth.ts).
import { Hono } from 'hono';
import type { AppBindings, AuthUser } from './types';
import { isAdmin, requireAdmin } from './auth';
import { extname, logAudit } from './db';

const MAX_TITLE = 300;
const MAX_EXCERPT = 600;
const MAX_CONTENT = 60_000;
const MAX_CATEGORY = 60;
const MAX_COVER_BYTES = 4 * 1024 * 1024; // 4 MB
const PUBLIC_LIST_LIMIT = 100;

interface BlogPostRow {
  id: number;
  slug: string;
  title: string;
  titleTh: string | null;
  excerpt: string | null;
  excerptTh: string | null;
  content?: string;
  contentTh?: string | null;
  category: string | null;
  coverKey?: string | null;
  status?: string;
  authorIdentity?: string;
  authorName: string | null;
  reviewedBy?: string | null;
  createdAt?: string;
  updatedAt?: string;
  publishedAt: string | null;
}

const PUBLIC_LIST_FIELDS = `id, slug, title, title_th AS titleTh, excerpt, excerpt_th AS excerptTh,
  category, cover_key AS coverKey, author_name AS authorName, published_at AS publishedAt`;

const ADMIN_FIELDS = `id, slug, title, title_th AS titleTh, excerpt, excerpt_th AS excerptTh,
  content, content_th AS contentTh, category, cover_key AS coverKey, status,
  author_identity AS authorIdentity, author_name AS authorName, reviewed_by AS reviewedBy,
  created_at AS createdAt, updated_at AS updatedAt, published_at AS publishedAt`;

// The website never sees R2 keys — just whether a cover exists.
function toPublic(row: BlogPostRow) {
  const { coverKey, ...rest } = row;
  return { ...rest, hasCover: !!coverKey };
}

function slugify(title: string): string {
  const base = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/[\s-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return base || 'post';
}

async function uniqueSlug(db: D1Database, title: string, excludeId?: number): Promise<string> {
  const base = slugify(title);
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    const existing = await db
      .prepare(`SELECT id FROM blog_posts WHERE slug = ?`)
      .bind(candidate)
      .first<{ id: number }>();
    if (!existing || existing.id === excludeId) return candidate;
  }
  return `${base}-${crypto.randomUUID().slice(0, 8)}`;
}

interface PostBody {
  title?: string;
  titleTh?: string;
  excerpt?: string;
  excerptTh?: string;
  content?: string;
  contentTh?: string;
  category?: string;
}

function validatePost(body: PostBody): string | null {
  if (!body.title?.trim()) return 'Missing title';
  if (body.title.length > MAX_TITLE || (body.titleTh ?? '').length > MAX_TITLE) return 'Title too long';
  if (!body.content?.trim()) return 'Missing content';
  if (body.content.length > MAX_CONTENT || (body.contentTh ?? '').length > MAX_CONTENT) return 'Content too long';
  if ((body.excerpt ?? '').length > MAX_EXCERPT || (body.excerptTh ?? '').length > MAX_EXCERPT) return 'Excerpt too long';
  if ((body.category ?? '').length > MAX_CATEGORY) return 'Category too long';
  return null;
}

function canEdit(user: AuthUser, post: { authorIdentity?: string }): boolean {
  return isAdmin(user) || (post.authorIdentity ?? '').toLowerCase() === user.email.toLowerCase();
}

/* ===== Public routes — mounted in index.ts BEFORE verifyAuth ===== */

export const blogPublic = new Hono<AppBindings>();

blogPublic.get('/blog/posts', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT ${PUBLIC_LIST_FIELDS} FROM blog_posts
     WHERE status = 'published'
     ORDER BY published_at DESC, id DESC LIMIT ?`,
  )
    .bind(PUBLIC_LIST_LIMIT)
    .all<BlogPostRow>();
  return c.json({ status: 'success', posts: (results ?? []).map(toPublic) });
});

blogPublic.get('/blog/posts/:slug', async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT ${PUBLIC_LIST_FIELDS}, content, content_th AS contentTh FROM blog_posts
     WHERE slug = ? AND status = 'published'`,
  )
    .bind(c.req.param('slug'))
    .first<BlogPostRow>();
  if (!row) return c.json({ status: 'error', message: 'Not found' }, 404);
  return c.json({ status: 'success', post: toPublic(row) });
});

blogPublic.get('/blog/posts/:slug/cover', async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT cover_key AS coverKey, cover_mime AS coverMime FROM blog_posts WHERE slug = ? AND status = 'published'`,
  )
    .bind(c.req.param('slug'))
    .first<{ coverKey: string | null; coverMime: string | null }>();
  if (!row?.coverKey) return c.json({ status: 'error', message: 'Not found' }, 404);
  const object = await c.env.BUCKET.get(row.coverKey);
  if (!object) return c.json({ status: 'error', message: 'Not found' }, 404);
  return new Response(object.body, {
    headers: {
      'Content-Type': row.coverMime || object.httpMetadata?.contentType || 'image/jpeg',
      'Cache-Control': 'public, max-age=3600',
    },
  });
});

/* ===== Management routes — mounted AFTER verifyAuth ===== */

const blog = new Hono<AppBindings>();

// Admins see every post; other staff (teachers) see only their own.
blog.get('/blog-admin/posts', async (c) => {
  const user = c.get('user');
  const stmt = isAdmin(user)
    ? c.env.DB.prepare(`SELECT ${ADMIN_FIELDS} FROM blog_posts ORDER BY id DESC`)
    : c.env.DB.prepare(`SELECT ${ADMIN_FIELDS} FROM blog_posts WHERE author_identity = ? COLLATE NOCASE ORDER BY id DESC`).bind(user.email);
  const { results } = await stmt.all<BlogPostRow>();
  return c.json({ status: 'success', isAdmin: isAdmin(user), posts: results ?? [] });
});

// Create a post. Every new post starts as 'pending'; an admin can pass
// publish=true to put it live immediately.
blog.post('/blog-admin/posts', async (c) => {
  const user = c.get('user');
  const body = await c.req.json<PostBody & { publish?: boolean }>().catch(() => ({}) as never);
  const invalid = validatePost(body);
  if (invalid) return c.json({ error: invalid }, 400);

  const publish = body.publish === true && isAdmin(user);
  const slug = await uniqueSlug(c.env.DB, body.title!);

  const result = await c.env.DB.prepare(
    `INSERT INTO blog_posts
       (slug, title, title_th, excerpt, excerpt_th, content, content_th, category,
        status, author_identity, author_name, reviewed_by, published_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      slug,
      body.title!.trim(),
      body.titleTh?.trim() || null,
      body.excerpt?.trim() || null,
      body.excerptTh?.trim() || null,
      body.content!,
      body.contentTh || null,
      body.category?.trim() || null,
      publish ? 'published' : 'pending',
      user.email,
      user.name || user.email,
      publish ? user.email : null,
      publish ? new Date().toISOString() : null,
    )
    .run();

  await logAudit(c.env.DB, user, publish ? 'BLOG_PUBLISH' : 'BLOG_SUBMIT', null, slug, true);
  return c.json({ ok: true, id: result.meta.last_row_id, slug, status: publish ? 'published' : 'pending' });
});

// Edit a post — the author or an admin. A non-admin edit sends the post
// back to 'pending' so an admin re-approves the new revision.
blog.patch('/blog-admin/posts/:id', async (c) => {
  const user = c.get('user');
  const id = Number(c.req.param('id'));
  const post = await c.env.DB.prepare(
    `SELECT id, slug, status, author_identity AS authorIdentity FROM blog_posts WHERE id = ?`,
  )
    .bind(id)
    .first<{ id: number; slug: string; status: string; authorIdentity: string }>();
  if (!post) return c.json({ error: 'Not found' }, 404);
  if (!canEdit(user, post)) return c.json({ error: 'Forbidden' }, 403);

  const body = await c.req.json<PostBody>().catch(() => ({}) as never);
  const invalid = validatePost(body);
  if (invalid) return c.json({ error: invalid }, 400);

  const demote = !isAdmin(user) && post.status === 'published';
  await c.env.DB.prepare(
    `UPDATE blog_posts SET
       title = ?, title_th = ?, excerpt = ?, excerpt_th = ?, content = ?, content_th = ?, category = ?,
       status = CASE WHEN ? THEN 'pending' ELSE status END,
       updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
  )
    .bind(
      body.title!.trim(),
      body.titleTh?.trim() || null,
      body.excerpt?.trim() || null,
      body.excerptTh?.trim() || null,
      body.content!,
      body.contentTh || null,
      body.category?.trim() || null,
      demote ? 1 : 0,
      id,
    )
    .run();

  await logAudit(c.env.DB, user, 'BLOG_EDIT', null, post.slug, true);
  return c.json({ ok: true, status: demote ? 'pending' : post.status });
});

// Approve / reject / unpublish — admin only.
blog.post('/blog-admin/posts/:id/status', requireAdmin, async (c) => {
  const user = c.get('user');
  const id = Number(c.req.param('id'));
  const body = await c.req.json<{ status?: string }>().catch(() => ({}) as never);
  if (!['published', 'pending', 'rejected'].includes(body.status ?? '')) {
    return c.json({ error: 'Invalid status' }, 400);
  }

  const post = await c.env.DB.prepare(`SELECT slug, published_at AS publishedAt FROM blog_posts WHERE id = ?`)
    .bind(id)
    .first<{ slug: string; publishedAt: string | null }>();
  if (!post) return c.json({ error: 'Not found' }, 404);

  await c.env.DB.prepare(
    `UPDATE blog_posts SET status = ?, reviewed_by = ?,
       published_at = CASE WHEN ? = 'published' AND published_at IS NULL THEN ? ELSE published_at END,
       updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
  )
    .bind(body.status, user.email, body.status, new Date().toISOString(), id)
    .run();

  await logAudit(c.env.DB, user, `BLOG_${body.status!.toUpperCase()}`, null, post.slug, true);
  return c.json({ ok: true });
});

// Delete — the author (their own post) or an admin (any post).
blog.delete('/blog-admin/posts/:id', async (c) => {
  const user = c.get('user');
  const id = Number(c.req.param('id'));
  const post = await c.env.DB.prepare(
    `SELECT slug, cover_key AS coverKey, author_identity AS authorIdentity FROM blog_posts WHERE id = ?`,
  )
    .bind(id)
    .first<{ slug: string; coverKey: string | null; authorIdentity: string }>();
  if (!post) return c.json({ error: 'Not found' }, 404);
  if (!canEdit(user, post)) return c.json({ error: 'Forbidden' }, 403);

  await c.env.DB.prepare(`DELETE FROM blog_posts WHERE id = ?`).bind(id).run();
  if (post.coverKey) await c.env.BUCKET.delete(post.coverKey).catch(() => {});
  await logAudit(c.env.DB, user, 'BLOG_DELETE', null, post.slug, true);
  return c.json({ ok: true });
});

// Upload / replace the cover image (multipart form, field "file").
blog.post('/blog-admin/posts/:id/cover', async (c) => {
  const user = c.get('user');
  const id = Number(c.req.param('id'));
  const post = await c.env.DB.prepare(
    `SELECT slug, cover_key AS coverKey, author_identity AS authorIdentity FROM blog_posts WHERE id = ?`,
  )
    .bind(id)
    .first<{ slug: string; coverKey: string | null; authorIdentity: string }>();
  if (!post) return c.json({ error: 'Not found' }, 404);
  if (!canEdit(user, post)) return c.json({ error: 'Forbidden' }, 403);

  const form = await c.req.formData();
  const file = form.get('file') as unknown as File | string | null;
  if (typeof file === 'string' || file === null) return c.json({ error: 'Missing file' }, 400);
  if (!file.type.startsWith('image/')) return c.json({ error: 'Cover must be an image' }, 400);

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength > MAX_COVER_BYTES) return c.json({ error: 'Image too large (max 4 MB)' }, 400);

  const key = `blog/covers/${id}-${crypto.randomUUID().slice(0, 8)}${extname(file.name) || '.jpg'}`;
  await c.env.BUCKET.put(key, bytes, { httpMetadata: { contentType: file.type } });
  await c.env.DB.prepare(`UPDATE blog_posts SET cover_key = ?, cover_mime = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .bind(key, file.type, id)
    .run();
  if (post.coverKey) await c.env.BUCKET.delete(post.coverKey).catch(() => {});

  await logAudit(c.env.DB, user, 'BLOG_COVER', null, post.slug, true);
  return c.json({ ok: true });
});

export default blog;
