// In-app notification center. System events (schedule/amendment approvals,
// payments, credit changes) and admin-composed messages all funnel through
// createNotification(); recipients are resolved at read-time by matching
// audience_type/audience_value against the reader's identity/role, so a
// single row can serve a broadcast to many readers with independent read
// state (notification_reads).

import { Hono } from 'hono';
import type { AppBindings, Env } from './types';
import { requireAdmin, isAdmin } from './auth';
import { logAudit } from './db';
import { dispatchPush, savePushSubscription, deletePushSubscription } from './push';

export type AudienceType = 'staff_identity' | 'role' | 'all_staff' | 'student' | 'all_students' | 'all';

export interface NotificationInput {
  title: string;
  body?: string | null;
  linkUrl?: string | null;
  category?: string;
  audienceType: AudienceType;
  audienceValue?: string | null;
  createdBy?: string | null;
  createdByName?: string | null;
}

// Writes the row, then best-effort pushes it to every matching device. Push
// failures (unconfigured VAPID, unreachable devices, etc.) never affect the
// in-app notification — it's already committed by the time dispatchPush runs.
export async function createNotification(env: Env, input: NotificationInput): Promise<number> {
  const result = await env.DB.prepare(
    `INSERT INTO notifications (title, body, link_url, category, audience_type, audience_value, created_by, created_by_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      input.title,
      input.body ?? null,
      input.linkUrl ?? null,
      input.category ?? 'custom',
      input.audienceType,
      input.audienceValue ?? null,
      input.createdBy ?? null,
      input.createdByName ?? null,
    )
    .run();
  const id = Number(result.meta.last_row_id);
  dispatchPush(env, { audienceType: input.audienceType, audienceValue: input.audienceValue, title: input.title, body: input.body, linkUrl: input.linkUrl }).catch(() => {});
  return id;
}

// Convenience wrappers for the system-triggered events fired from core.ts /
// manage.ts. All are "fire and forget" — a notification failure must never
// block the underlying action, so callers should skip awaiting failures.

export function notifyAdmins(env: Env, input: Omit<NotificationInput, 'audienceType' | 'audienceValue'>) {
  return createNotification(env, { ...input, audienceType: 'role', audienceValue: 'admin' });
}

export function notifyStaff(env: Env, identity: string, input: Omit<NotificationInput, 'audienceType' | 'audienceValue'>) {
  return createNotification(env, { ...input, audienceType: 'staff_identity', audienceValue: identity });
}

export function notifyStudent(env: Env, studentId: string, input: Omit<NotificationInput, 'audienceType' | 'audienceValue'>) {
  return createNotification(env, { ...input, audienceType: 'student', audienceValue: studentId });
}

// Shared WHERE clause (+ binds) for "notifications visible to this staff
// member": their own role, a direct mention, or a staff-wide broadcast.
function staffAudienceWhere(email: string, admin: boolean): { sql: string; binds: unknown[] } {
  return {
    sql: `(n.audience_type = 'all' OR n.audience_type = 'all_staff'
           OR (n.audience_type = 'role' AND n.audience_value = ?)
           OR (n.audience_type = 'staff_identity' AND n.audience_value = ? COLLATE NOCASE))`,
    binds: [admin ? 'admin' : 'teacher', email],
  };
}

const notifications = new Hono<AppBindings>();

notifications.get('/notifications', async (c) => {
  const user = c.get('user');
  const admin = isAdmin(user);
  const { sql: whereSql, binds } = staffAudienceWhere(user.email, admin);

  const { results } = await c.env.DB.prepare(
    `SELECT n.id, n.title, n.body, n.link_url AS linkUrl, n.category,
            n.audience_type AS audienceType, n.audience_value AS audienceValue,
            n.created_by AS createdBy, n.created_by_name AS createdByName, n.created_at AS createdAt,
            CASE WHEN r.notification_id IS NOT NULL THEN 1 ELSE 0 END AS isRead
     FROM notifications n
     LEFT JOIN notification_reads r ON r.notification_id = n.id AND r.reader_identity = ? COLLATE NOCASE
     WHERE ${whereSql}
     ORDER BY n.created_at DESC LIMIT 50`,
  )
    .bind(user.email, ...binds)
    .all();
  return c.json(results ?? []);
});

notifications.get('/notifications/unread-count', async (c) => {
  const user = c.get('user');
  const admin = isAdmin(user);
  const { sql: whereSql, binds } = staffAudienceWhere(user.email, admin);

  const row = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n
     FROM notifications n
     LEFT JOIN notification_reads r ON r.notification_id = n.id AND r.reader_identity = ? COLLATE NOCASE
     WHERE ${whereSql} AND r.notification_id IS NULL`,
  )
    .bind(user.email, ...binds)
    .first<{ n: number }>();
  return c.json({ count: row?.n ?? 0 });
});

notifications.post('/notifications/:id/read', async (c) => {
  const id = Number(c.req.param('id'));
  const user = c.get('user');
  await c.env.DB.prepare(`INSERT OR IGNORE INTO notification_reads (notification_id, reader_identity) VALUES (?, ?)`)
    .bind(id, user.email)
    .run();
  return c.json({ ok: true });
});

notifications.post('/notifications/read-all', async (c) => {
  const user = c.get('user');
  const admin = isAdmin(user);
  const { sql: whereSql, binds } = staffAudienceWhere(user.email, admin);

  await c.env.DB.prepare(
    `INSERT OR IGNORE INTO notification_reads (notification_id, reader_identity)
     SELECT n.id, ? FROM notifications n WHERE ${whereSql}`,
  )
    .bind(user.email, ...binds)
    .run();
  return c.json({ ok: true });
});

// Admin's send history (system + manually composed), for the compose screen.
notifications.get('/notifications/history', requireAdmin, async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, title, body, link_url AS linkUrl, category, audience_type AS audienceType,
            audience_value AS audienceValue, created_by AS createdBy, created_by_name AS createdByName, created_at AS createdAt
     FROM notifications ORDER BY id DESC LIMIT 100`,
  ).all();
  return c.json(results ?? []);
});

const AUDIENCE_TYPES: AudienceType[] = ['staff_identity', 'role', 'all_staff', 'student', 'all_students', 'all'];

// Admin composes a notification: picks who receives it (a specific person, a
// role, a specific student, or everyone) and an optional sender label.
notifications.post('/notifications', requireAdmin, async (c) => {
  const user = c.get('user');
  const body = await c.req.json<{
    title?: string;
    body?: string;
    linkUrl?: string;
    audienceType?: string;
    audienceValue?: string;
    senderName?: string;
  }>();

  const title = (body.title ?? '').trim();
  if (!title) return c.json({ error: 'กรุณากรอกหัวข้อการแจ้งเตือน' }, 400);
  if (!AUDIENCE_TYPES.includes(body.audienceType as AudienceType)) return c.json({ error: 'ระบุกลุ่มผู้รับไม่ถูกต้อง' }, 400);
  const audienceType = body.audienceType as AudienceType;

  let audienceValue: string | null = null;
  if (audienceType === 'role') {
    if (body.audienceValue !== 'admin' && body.audienceValue !== 'teacher') {
      return c.json({ error: 'ระบุบทบาทไม่ถูกต้อง (admin หรือ teacher)' }, 400);
    }
    audienceValue = body.audienceValue;
  } else if (audienceType === 'staff_identity') {
    audienceValue = (body.audienceValue ?? '').trim();
    if (!audienceValue) return c.json({ error: 'กรุณาระบุผู้รับ' }, 400);
  } else if (audienceType === 'student') {
    audienceValue = (body.audienceValue ?? '').trim();
    if (!audienceValue) return c.json({ error: 'กรุณาระบุนักเรียน' }, 400);
    const student = await c.env.DB.prepare(`SELECT id FROM students WHERE id = ? COLLATE NOCASE AND deleted_at IS NULL`)
      .bind(audienceValue)
      .first();
    if (!student) return c.json({ error: 'ไม่พบนักเรียนรหัสนี้ในระบบ' }, 404);
  }

  const id = await createNotification(c.env, {
    title,
    body: (body.body ?? '').trim() || null,
    linkUrl: (body.linkUrl ?? '').trim() || null,
    category: 'custom',
    audienceType,
    audienceValue,
    createdBy: user.email,
    createdByName: (body.senderName ?? '').trim() || user.name,
  });
  await logAudit(c.env.DB, user, 'SEND_NOTIFICATION', audienceType === 'student' ? audienceValue : null, `${id} ${audienceType}:${audienceValue ?? ''}`, true);
  return c.json({ ok: true, id, message: 'ส่งการแจ้งเตือนแล้ว' });
});

// ===== Web Push subscriptions (staff) =====

notifications.post('/push/subscribe', async (c) => {
  const user = c.get('user');
  const body = await c.req.json<{ endpoint?: string; keys?: { p256dh?: string; auth?: string } }>();
  if (!body.endpoint || !body.keys?.p256dh || !body.keys?.auth) return c.json({ error: 'Invalid subscription' }, 400);
  await savePushSubscription(c.env.DB, 'staff', user.email, { endpoint: body.endpoint, p256dh: body.keys.p256dh, auth: body.keys.auth });
  return c.json({ ok: true });
});

notifications.post('/push/unsubscribe', async (c) => {
  const body = await c.req.json<{ endpoint?: string }>().catch(() => ({ endpoint: undefined }));
  if (body.endpoint) await deletePushSubscription(c.env.DB, body.endpoint);
  return c.json({ ok: true });
});

export default notifications;
