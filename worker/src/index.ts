import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { AppBindings } from './types';
import { verifyAuth, requirePermission } from './auth';
import { DOCUMENT_TYPES, extname, insertFileWithUniqueName, logAudit, todayCode } from './db';
import core, { bangkokToday } from './core';
import manage, {
  activateSchedule,
  activateApprovedSchedulesForStudent,
  activateAmendment,
  activateAwaitingAmendmentsForStudent,
  visibleStudentIds,
  canSeeStudent,
} from './manage';
import accounts from './accounts';
import { verifyStripeSignature } from './stripe';

const app = new Hono<AppBindings>();

// ALLOWED_ORIGIN is a comma-separated list (admin panel + student site).
app.use('*', async (c, next) => cors({
  origin: c.env.ALLOWED_ORIGIN.split(',').map((o) => o.trim()),
  allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Authorization', 'Content-Type'],
})(c, next));

// ===== Public routes (registered before verifyAuth) =====

// Stripe calls this with a signature header, not a Bearer token.
app.post('/stripe/webhook', async (c) => {
  if (!c.env.STRIPE_WEBHOOK_SECRET) return c.json({ error: 'Webhook not configured' }, 503);

  const payload = await c.req.text();
  const valid = await verifyStripeSignature(payload, c.req.header('Stripe-Signature'), c.env.STRIPE_WEBHOOK_SECRET);
  if (!valid) return c.json({ error: 'Invalid signature' }, 400);

  let event: {
    type: string;
    data: {
      object: {
        id: string;
        payment_link?: string | null;
        payment_status?: string;
        amount_total?: number | null;
        metadata?: Record<string, string>;
      };
    };
  };
  try {
    event = JSON.parse(payload);
  } catch (err) {
    console.error('stripe webhook: malformed JSON payload', err);
    return c.json({ error: 'Malformed payload' }, 400);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      if (session.payment_status === 'paid' && session.amount_total) {
        const meta = session.metadata ?? {};
        // UNIQUE(stripe_session_id) makes redelivered webhooks a no-op.
        await c.env.DB.prepare(
          `INSERT OR IGNORE INTO payments
             (student_id, amount, method, paid_date, source, stripe_payment_link_id, stripe_session_id, recorded_by)
           VALUES (?, ?, 'Stripe', ?, 'stripe', ?, ?, ?)`,
        )
          .bind(
            meta.student_id || null,
            session.amount_total / 100,
            bangkokToday(),
            session.payment_link ?? null,
            session.id,
            meta.created_by || null,
          )
          .run();
        if (session.payment_link) {
          await c.env.DB.prepare(`UPDATE payment_links SET status = 'paid' WHERE stripe_payment_link_id = ?`)
            .bind(session.payment_link)
            .run();
        }
        // A successful payment starts the approved schedule (or amendment)
        // right away.
        const scheduleId = Number(meta.schedule_id);
        const amendmentId = Number(meta.amendment_id);
        if (Number.isFinite(amendmentId) && amendmentId > 0) {
          await activateAmendment(c.env.DB, amendmentId);
        } else if (Number.isFinite(scheduleId) && scheduleId > 0) {
          await activateSchedule(c.env.DB, scheduleId);
        } else if (meta.student_id) {
          await activateApprovedSchedulesForStudent(c.env.DB, meta.student_id);
          await activateAwaitingAmendmentsForStudent(c.env.DB, meta.student_id);
        }
        await logAudit(c.env.DB, null, 'STRIPE_PAYMENT', meta.student_id || null, session.id, true);
      }
    }
  } catch (err) {
    // Surface a 500 so Stripe retries the delivery instead of silently
    // losing a payment record — but log first so the failure is visible
    // in `wrangler tail` / the Cloudflare dashboard instead of vanishing
    // as an opaque "other error" on Stripe's side.
    console.error(`stripe webhook: failed to process event ${event.type} (${event.data?.object?.id})`, err);
    const session = event.data?.object;
    await logAudit(c.env.DB, null, 'STRIPE_PAYMENT', session?.metadata?.student_id || null, session?.id || null, false).catch(() => {});
    return c.json({ error: 'Internal error' }, 500);
  }

  return c.json({ received: true });
});

// Student portal data for the public website (litalkeducation.com/student.html).
// Deliberately unauthenticated and keyed by student id — this mirrors the GAS
// endpoint it replaces (the student site "logs in" client-side only), so it
// exposes exactly the same data the old Sheet endpoint did.
app.get('/portal/:studentId', async (c) => {
  const studentId = c.req.param('studentId');
  // NOCASE: the id comes from the Auth0 email local part, which is lowercased.
  const student = await c.env.DB.prepare(`SELECT id, name, course FROM students WHERE id = ? COLLATE NOCASE AND deleted_at IS NULL`)
    .bind(studentId)
    .first<{ id: string; name: string; course: string | null }>();
  if (!student) {
    return c.json({ status: 'error', message: 'ไม่พบข้อมูลนักเรียนรหัสนี้ในระบบ' }, 404);
  }

  const today = bangkokToday();
  const [logs, pays, upcoming, pendingLinks] = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT log_date AS timestamp, feedback, video_url AS video FROM study_logs WHERE student_id = ? ORDER BY log_date DESC, id DESC`,
    ).bind(student.id),
    c.env.DB.prepare(
      `SELECT paid_date AS timestamp, method, amount AS total, proof_url AS proof FROM payments WHERE student_id = ? ORDER BY paid_date DESC, id DESC`,
    ).bind(student.id),
    // Only 'booked' rows: a withdrawn hour flips its booking to 'cancelled'
    // (see applyRemoveSessions in manage.ts), so that day simply stops
    // showing up here — no separate "removed" state to reconcile.
    c.env.DB.prepare(
      `SELECT booking_date AS date, booking_time AS time FROM bookings
       WHERE student_id = ? AND status = 'booked' AND booking_date >= ? ORDER BY booking_date, booking_time LIMIT 60`,
    ).bind(student.id, today),
    // Payment links the system is waiting on this student to pay (schedule
    // approvals / hour top-ups that still need a Stripe checkout).
    c.env.DB.prepare(
      `SELECT url, amount, description FROM payment_links WHERE student_id = ? AND status = 'active' ORDER BY id DESC LIMIT 5`,
    ).bind(student.id),
  ]);

  const payments = (pays.results ?? []) as Array<{ timestamp: string }>;
  return c.json({
    status: 'success',
    data: {
      info: {
        name: student.name,
        course: student.course ?? '-',
        lastPaid: payments[0]?.timestamp ?? '-',
      },
      studyLogs: logs.results ?? [],
      payments,
      schedule: upcoming.results ?? [],
      pendingPayments: pendingLinks.results ?? [],
    },
  });
});

// Public file download by opaque token (shareable link). No auth: the token
// is the capability. Only files with a token set are reachable this way.
app.get('/public/files/:token', async (c) => {
  const token = c.req.param('token');
  if (!token) return c.json({ error: 'Not found' }, 404);
  const row = await c.env.DB.prepare(
    `SELECT r2_key, filename, mime_type FROM student_files WHERE public_token = ? AND deleted_at IS NULL`,
  )
    .bind(token)
    .first<{ r2_key: string; filename: string; mime_type: string }>();
  if (!row) return c.json({ error: 'Not found' }, 404);

  const object = await c.env.BUCKET.get(row.r2_key);
  if (!object) return c.json({ error: 'File missing in storage' }, 404);

  return new Response(object.body, {
    headers: {
      'Content-Type': row.mime_type || 'application/octet-stream',
      'Content-Disposition': `inline; filename="${row.filename}"`,
      'Cache-Control': 'private, max-age=300',
    },
  });
});

// ===== Authenticated routes =====

app.use('*', verifyAuth);

app.route('/', core);
app.route('/', manage);
app.route('/', accounts);

app.get('/me', (c) => c.json(c.get('user')));

app.get('/students/:id/files', requirePermission('files:read'), async (c) => {
  const studentId = c.req.param('id');
  if (!studentId) return c.json({ error: 'Missing student id' }, 400);
  const visible = await visibleStudentIds(c.env.DB, c.get('user'));
  if (!canSeeStudent(visible, studentId)) return c.json({ error: 'Forbidden' }, 403);
  const { results } = await c.env.DB.prepare(
    `SELECT id, filename, file_type, uploaded_at, uploaded_by, size, mime_type
     FROM student_files WHERE student_id = ? AND deleted_at IS NULL ORDER BY uploaded_at DESC`,
  )
    .bind(studentId)
    .all();
  return c.json(results);
});

app.post('/upload', requirePermission('files:write'), async (c) => {
  const form = await c.req.formData();
  const studentId = form.get('student_id');
  const fileType = form.get('file_type');
  // workers-types' FormData.get() is typed as `string | null` only, but at
  // runtime it returns a File for multipart file fields; widen the type back.
  const file = form.get('file') as unknown as File | string | null;

  if (typeof studentId !== 'string' || !studentId || typeof fileType !== 'string' || typeof file === 'string' || file === null) {
    return c.json({ error: 'Missing student_id, file_type, or file' }, 400);
  }
  if (!DOCUMENT_TYPES.includes(fileType as (typeof DOCUMENT_TYPES)[number])) {
    return c.json({ error: 'Invalid file_type' }, 400);
  }

  const user = c.get('user');
  const visible = await visibleStudentIds(c.env.DB, user);
  if (!canSeeStudent(visible, studentId)) return c.json({ error: 'Forbidden' }, 403);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const { id, filename, r2Key } = await insertFileWithUniqueName(c.env.DB, studentId, todayCode(), extname(file.name), {
    originalFilename: file.name,
    fileType,
    uploadedBy: user.email,
    size: bytes.byteLength,
    mimeType: file.type,
  });

  await c.env.BUCKET.put(r2Key, bytes, { httpMetadata: { contentType: file.type } });
  await logAudit(c.env.DB, user, 'UPLOAD', studentId, filename, true);

  return c.json({ id, filename, r2Key });
});

app.get('/files/:fileId', requirePermission('files:read'), async (c) => {
  const fileId = c.req.param('fileId');
  if (!fileId) return c.json({ error: 'Not found' }, 404);
  const row = await c.env.DB.prepare(
    `SELECT r2_key, filename, mime_type, student_id FROM student_files WHERE id = ? AND deleted_at IS NULL`,
  )
    .bind(fileId)
    .first<{ r2_key: string; filename: string; mime_type: string; student_id: string }>();

  if (!row) return c.json({ error: 'Not found' }, 404);

  const visible = await visibleStudentIds(c.env.DB, c.get('user'));
  if (!canSeeStudent(visible, row.student_id)) return c.json({ error: 'Forbidden' }, 403);

  const object = await c.env.BUCKET.get(row.r2_key);
  if (!object) return c.json({ error: 'File missing in storage' }, 404);

  await logAudit(c.env.DB, c.get('user'), 'DOWNLOAD', row.student_id, row.filename, true);

  return new Response(object.body, {
    headers: {
      'Content-Type': row.mime_type || 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${row.filename}"`,
    },
  });
});

app.patch('/files/:fileId', requirePermission('files:write'), async (c) => {
  const fileId = c.req.param('fileId');
  if (!fileId) return c.json({ error: 'Not found' }, 404);
  const body = await c.req.json<{ file_type?: string }>();

  if (!body.file_type || !DOCUMENT_TYPES.includes(body.file_type as (typeof DOCUMENT_TYPES)[number])) {
    return c.json({ error: 'Invalid file_type' }, 400);
  }

  const fileRow = await c.env.DB.prepare(`SELECT student_id FROM student_files WHERE id = ? AND deleted_at IS NULL`)
    .bind(fileId)
    .first<{ student_id: string }>();
  if (!fileRow) return c.json({ error: 'Not found' }, 404);
  const visible = await visibleStudentIds(c.env.DB, c.get('user'));
  if (!canSeeStudent(visible, fileRow.student_id)) return c.json({ error: 'Forbidden' }, 403);

  const result = await c.env.DB.prepare(`UPDATE student_files SET file_type = ? WHERE id = ? AND deleted_at IS NULL`)
    .bind(body.file_type, fileId)
    .run();

  if (result.meta.changes === 0) return c.json({ error: 'Not found' }, 404);

  await logAudit(c.env.DB, c.get('user'), 'UPDATE', null, fileId, true);
  return c.json({ ok: true });
});

// Mint (or return the existing) public share link for a file.
app.post('/files/:fileId/public-link', requirePermission('files:write'), async (c) => {
  const fileId = c.req.param('fileId');
  if (!fileId) return c.json({ error: 'Not found' }, 404);
  const row = await c.env.DB.prepare(
    `SELECT public_token AS token, student_id AS studentId FROM student_files WHERE id = ? AND deleted_at IS NULL`,
  )
    .bind(fileId)
    .first<{ token: string | null; studentId: string }>();
  if (!row) return c.json({ error: 'Not found' }, 404);

  const visible = await visibleStudentIds(c.env.DB, c.get('user'));
  if (!canSeeStudent(visible, row.studentId)) return c.json({ error: 'Forbidden' }, 403);

  let token = row.token;
  if (!token) {
    token = crypto.randomUUID().replace(/-/g, '');
    await c.env.DB.prepare(`UPDATE student_files SET public_token = ? WHERE id = ?`).bind(token, fileId).run();
    await logAudit(c.env.DB, c.get('user'), 'CREATE_PUBLIC_LINK', row.studentId, fileId, true);
  }
  const origin = c.env.PUBLIC_FILES_ORIGIN || new URL(c.req.url).origin;
  const url = `${origin}/public/files/${token}`;
  return c.json({ ok: true, token, url });
});

app.delete('/files/:fileId', requirePermission('files:delete'), async (c) => {
  const fileId = c.req.param('fileId');
  if (!fileId) return c.json({ error: 'Not found' }, 404);
  const row = await c.env.DB.prepare(`SELECT r2_key, filename, student_id FROM student_files WHERE id = ? AND deleted_at IS NULL`)
    .bind(fileId)
    .first<{ r2_key: string; filename: string; student_id: string }>();

  if (!row) return c.json({ error: 'Not found' }, 404);

  await c.env.DB.prepare(`UPDATE student_files SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(fileId).run();
  await c.env.BUCKET.delete(row.r2_key);
  await logAudit(c.env.DB, c.get('user'), 'DELETE', row.student_id, row.filename, true);

  return c.json({ ok: true });
});

export default app;
