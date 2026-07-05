import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { AppBindings } from './types';
import { verifyAuth, requirePermission } from './auth';
import { DOCUMENT_TYPES, extname, insertFileWithUniqueName, logAudit, todayCode } from './db';
import core, { bangkokToday } from './core';
import manage, { activateSchedule, activateApprovedSchedulesForStudent } from './manage';
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

  const event = JSON.parse(payload) as {
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
      // A successful payment starts the approved monthly schedule right away.
      const scheduleId = Number(meta.schedule_id);
      if (Number.isFinite(scheduleId) && scheduleId > 0) {
        await activateSchedule(c.env.DB, scheduleId);
      } else if (meta.student_id) {
        await activateApprovedSchedulesForStudent(c.env.DB, meta.student_id);
      }
      await logAudit(c.env.DB, null, 'STRIPE_PAYMENT', meta.student_id || null, session.id, true);
    }
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

  const [logs, pays] = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT log_date AS timestamp, feedback, video_url AS video FROM study_logs WHERE student_id = ? ORDER BY log_date DESC, id DESC`,
    ).bind(student.id),
    c.env.DB.prepare(
      `SELECT paid_date AS timestamp, method, amount AS total, proof_url AS proof FROM payments WHERE student_id = ? ORDER BY paid_date DESC, id DESC`,
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
    },
  });
});

// ===== Authenticated routes =====

app.use('*', verifyAuth);

app.route('/', core);
app.route('/', manage);

app.get('/me', (c) => c.json(c.get('user')));

app.get('/students/:id/files', requirePermission('files:read'), async (c) => {
  const studentId = c.req.param('id');
  if (!studentId) return c.json({ error: 'Missing student id' }, 400);
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

  const result = await c.env.DB.prepare(`UPDATE student_files SET file_type = ? WHERE id = ? AND deleted_at IS NULL`)
    .bind(body.file_type, fileId)
    .run();

  if (result.meta.changes === 0) return c.json({ error: 'Not found' }, 404);

  await logAudit(c.env.DB, c.get('user'), 'UPDATE', null, fileId, true);
  return c.json({ ok: true });
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
