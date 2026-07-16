import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { AppBindings } from './types';
import { verifyAuth, requirePermission, portalTokenMatchesStudent } from './auth';
import { DOCUMENT_TYPES, extname, insertFileWithUniqueName, logAudit, todayCode } from './db';
import core, { bangkokToday } from './core';
import manage, {
  activateSchedule,
  activateApprovedSchedulesForStudent,
  activateAmendment,
  activateAwaitingAmendmentsForStudent,
  visibleStudentIds,
  canSeeStudent,
  creditBalance,
} from './manage';
import accounts, { handleAvatarUpload } from './accounts';
import chat, {
  MAX_MESSAGE_LENGTH,
  PORTAL_DAILY_LIMIT,
  GENERAL_DAILY_LIMIT,
  getPortalInstructions,
  loadChatHistory,
  portalMessageCountToday,
  generalMessageCountToday,
  saveChatTurn,
  studentChatContext,
} from './chat';
import { chatReply, ChatNotConfiguredError } from './gemini';
import { verifyStripeSignature } from './stripe';
import blog, { blogPublic } from './blog';
import shortLinks, { shortLinkRedirect } from './shortlinks';

const app = new Hono<AppBindings>();

// URL shortener redirects (go.litalkeducation.com / payment.litalkeducation.com).
// Must run before CORS/auth: these are plain browser navigations to a
// dedicated hostname, not API calls, and short-circuit with a redirect
// before ever reaching the rest of the app. Every other hostname falls
// through via next() untouched.
app.use('*', shortLinkRedirect);

// ALLOWED_ORIGIN is a comma-separated list (admin panel + student site).
app.use('*', async (c, next) => cors({
  origin: c.env.ALLOWED_ORIGIN.split(',').map((o) => o.trim()),
  allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Authorization', 'Content-Type'],
})(c, next));

// ===== Public routes (registered before verifyAuth) =====

// Published blog posts for the public website (litalkeducation.com/blog).
app.route('/', blogPublic);

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
        total_details?: { amount_discount?: number | null } | null;
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
        const discountAmount = session.total_details?.amount_discount ? session.total_details.amount_discount / 100 : null;
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
          await c.env.DB.prepare(`UPDATE payment_links SET status = 'paid', discount_amount = ? WHERE stripe_payment_link_id = ?`)
            .bind(discountAmount, session.payment_link)
            .run();
        }
        // A successful payment starts the approved schedule (or amendment)
        // right away.
        const scheduleId = Number(meta.schedule_id);
        const amendmentId = Number(meta.amendment_id);
        if (Number.isFinite(amendmentId) && amendmentId > 0) {
          await activateAmendment(c.env.DB, c.env, amendmentId);
        } else if (Number.isFinite(scheduleId) && scheduleId > 0) {
          await activateSchedule(c.env.DB, c.env, scheduleId);
        } else if (meta.student_id) {
          await activateApprovedSchedulesForStudent(c.env.DB, c.env, meta.student_id);
          await activateAwaitingAmendmentsForStudent(c.env.DB, c.env, meta.student_id);
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
// Public and keyed by student id (the student site "logs in" client-side only),
// exposing the basic profile / study / payment data the old GAS Sheet endpoint
// did, plus credit balance. Sensitive fields — private files and Google Meet
// links — are returned only when the caller presents a valid Auth0 token for
// this same student (see portalTokenMatchesStudent).
app.get('/portal/:studentId', async (c) => {
  const studentId = c.req.param('studentId');
  // NOCASE: the id comes from the Auth0 email local part, which is lowercased.
  const student = await c.env.DB.prepare(
    `SELECT id, name, nickname, course, avatar_key AS avatarKey FROM students WHERE id = ? COLLATE NOCASE AND deleted_at IS NULL`,
  )
    .bind(studentId)
    .first<{ id: string; name: string; nickname: string | null; course: string | null; avatarKey: string | null }>();
  if (!student) {
    return c.json({ status: 'error', message: 'ไม่พบข้อมูลนักเรียนรหัสนี้ในระบบ' }, 404);
  }

  // The portal is public by student id, but files and Meet links are only
  // returned to the authenticated student themselves (Auth0 token whose login
  // identity matches this id). Everything else stays visible to the ?id= link.
  const authed = await portalTokenMatchesStudent(c, student.id);

  const today = bangkokToday();
  const [logs, pays, upcoming, pendingLinks, teachers] = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT log_date AS timestamp, feedback, video_url AS video FROM study_logs WHERE student_id = ? ORDER BY log_date DESC, id DESC LIMIT 300`,
    ).bind(student.id),
    c.env.DB.prepare(
      `SELECT paid_date AS timestamp, method, amount AS total, proof_url AS proof FROM payments WHERE student_id = ? ORDER BY paid_date DESC, id DESC LIMIT 200`,
    ).bind(student.id),
    // Only 'booked' rows: a withdrawn hour flips its booking to 'cancelled'
    // (see applyRemoveSessions in manage.ts), so that day simply stops
    // showing up here — no separate "removed" state to reconcile.
    c.env.DB.prepare(
      `SELECT booking_date AS date, booking_time AS time, meet_link AS meet FROM bookings
       WHERE student_id = ? AND status = 'booked' AND booking_date >= ? ORDER BY booking_date, booking_time LIMIT 60`,
    ).bind(student.id, today),
    // Payment links the system is waiting on this student to pay (schedule
    // approvals / hour top-ups that still need a Stripe checkout).
    c.env.DB.prepare(
      `SELECT url, short_url AS shortUrl, amount, description FROM payment_links WHERE student_id = ? AND status = 'active' ORDER BY id DESC LIMIT 5`,
    ).bind(student.id),
    // Whoever the admin assigned this student to (teacher_students — the
    // same "visibility" mapping the admin panel's access screen manages),
    // so the portal can show "your teacher" with contact info.
    c.env.DB.prepare(
      `SELECT st.identity, st.name, st.title, st.phone, st.avatar_key AS avatarKey
       FROM teacher_students ts JOIN staff st ON st.identity = ts.teacher_email COLLATE NOCASE
       WHERE ts.student_id = ? COLLATE NOCASE ORDER BY st.name`,
    ).bind(student.id),
  ]);

  const balance = await creditBalance(c.env.DB, student.id);

  // Meet links are a join-the-class capability — strip them unless the caller
  // proved they are this student.
  const schedule = ((upcoming.results ?? []) as Array<{ date: string; time: string; meet: string | null }>).map((s) =>
    authed ? s : { date: s.date, time: s.time, meet: null },
  );

  // Downloadable documents (homework, certificates, …) — authenticated only.
  let files: unknown[] = [];
  if (authed) {
    const { results } = await c.env.DB.prepare(
      `SELECT id, filename, file_type AS fileType, size, uploaded_at AS uploadedAt
       FROM student_files WHERE student_id = ? AND deleted_at IS NULL ORDER BY uploaded_at DESC LIMIT 100`,
    )
      .bind(student.id)
      .all();
    files = results ?? [];
  }

  const payments = (pays.results ?? []) as Array<{ timestamp: string }>;
  const teacherRows = (teachers.results ?? []) as Array<{
    identity: string; name: string; title: string | null; phone: string | null; avatarKey: string | null;
  }>;
  return c.json({
    status: 'success',
    data: {
      info: {
        name: student.name,
        nickname: student.nickname ?? null,
        course: student.course ?? '-',
        lastPaid: payments[0]?.timestamp ?? '-',
        creditBalance: balance,
        hasAvatar: !!student.avatarKey,
        authed,
      },
      studyLogs: logs.results ?? [],
      payments,
      schedule,
      pendingPayments: pendingLinks.results ?? [],
      files,
      // "Your teacher" card — sourced from the same teacher_students
      // assignment the admin's visibility screen manages. identity is
      // included only so the frontend can request the matching avatar
      // below; the avatar route re-checks the assignment itself, so
      // knowing an identity alone doesn't unlock anyone's photo.
      teachers: teacherRows.map((t) => ({
        identity: t.identity,
        name: t.name,
        title: t.title,
        phone: t.phone,
        hasAvatar: !!t.avatarKey,
      })),
    },
  });
});

// Public teacher-avatar proxy for the student portal's "your teacher" card.
// Scoped to this student: only streams the photo of a teacher who is
// actually assigned to this student_id via teacher_students, so this can't
// be used to enumerate arbitrary staff photos just by knowing an identity.
app.get('/portal/:studentId/teacher-avatar/:identity', async (c) => {
  const studentId = c.req.param('studentId');
  const identity = decodeURIComponent(c.req.param('identity'));
  const row = await c.env.DB.prepare(
    `SELECT st.avatar_key AS avatarKey
     FROM teacher_students ts JOIN staff st ON st.identity = ts.teacher_email COLLATE NOCASE
     WHERE ts.student_id = ? COLLATE NOCASE AND ts.teacher_email = ? COLLATE NOCASE`,
  )
    .bind(studentId, identity)
    .first<{ avatarKey: string | null }>();
  if (!row?.avatarKey) return c.json({ error: 'ยังไม่มีรูปภาพ' }, 404);
  const object = await c.env.BUCKET.get(row.avatarKey);
  if (!object) return c.json({ error: 'ไม่พบไฟล์รูปภาพ' }, 404);
  return new Response(object.body, {
    headers: {
      'Content-Type': object.httpMetadata?.contentType || 'image/jpeg',
      'Cache-Control': 'private, max-age=300',
    },
  });
});

// Public avatar for the student portal — the student's own photo is basic
// profile data, so no auth (parity with the rest of the public portal).
app.get('/portal/:studentId/avatar', async (c) => {
  const studentId = c.req.param('studentId');
  const student = await c.env.DB.prepare(
    `SELECT avatar_key AS avatarKey FROM students WHERE id = ? COLLATE NOCASE AND deleted_at IS NULL`,
  )
    .bind(studentId)
    .first<{ avatarKey: string | null }>();
  if (!student?.avatarKey) return c.json({ error: 'ยังไม่มีรูปภาพ' }, 404);
  const object = await c.env.BUCKET.get(student.avatarKey);
  if (!object) return c.json({ error: 'ไม่พบไฟล์รูปภาพ' }, 404);
  return new Response(object.body, {
    headers: {
      'Content-Type': object.httpMetadata?.contentType || 'image/jpeg',
      'Cache-Control': 'private, max-age=300',
    },
  });
});

// Self-service profile edit for the signed-in student themselves — nickname
// and photo only (the legal `name` stays admin-controlled since it feeds
// invoices/certificates). Gated the same way as the other private /portal/*
// routes: a valid Auth0 token whose login identity is this student.
app.patch('/portal/:studentId/profile', async (c) => {
  const studentId = c.req.param('studentId');
  if (!(await portalTokenMatchesStudent(c, studentId))) return c.json({ status: 'error', message: 'Unauthorized' }, 401);

  const body = await c.req.json<{ nickname?: string }>().catch(() => ({}) as never);
  if (body.nickname === undefined) return c.json({ status: 'error', message: 'ไม่มีข้อมูลที่จะบันทึก' }, 400);

  const student = await c.env.DB.prepare(`SELECT id FROM students WHERE id = ? COLLATE NOCASE AND deleted_at IS NULL`)
    .bind(studentId)
    .first<{ id: string }>();
  if (!student) return c.json({ status: 'error', message: 'ไม่พบข้อมูลนักเรียนรหัสนี้ในระบบ' }, 404);

  await c.env.DB.prepare(`UPDATE students SET nickname = ? WHERE id = ?`).bind(body.nickname.trim() || null, student.id).run();
  await logAudit(c.env.DB, null, 'STUDENT_SELF_EDIT_PROFILE', student.id, null, true);
  return c.json({ status: 'success', message: 'บันทึกข้อมูลสำเร็จ' });
});

// Self-service avatar upload/removal — same R2 key convention
// (`avatars/students/<id>`) as the admin upload route, so both
// `/students/:id/avatar` and `/portal/:studentId/avatar` serve whichever was
// set last.
app.post('/portal/:studentId/avatar', async (c) => {
  const studentId = c.req.param('studentId');
  if (!(await portalTokenMatchesStudent(c, studentId))) return c.json({ status: 'error', message: 'Unauthorized' }, 401);

  const student = await c.env.DB.prepare(`SELECT id, avatar_key AS avatarKey FROM students WHERE id = ? COLLATE NOCASE AND deleted_at IS NULL`)
    .bind(studentId)
    .first<{ id: string; avatarKey: string | null }>();
  if (!student) return c.json({ status: 'error', message: 'ไม่พบข้อมูลนักเรียนรหัสนี้ในระบบ' }, 404);

  const res = await handleAvatarUpload(c, `avatars/students/${student.id}`, 'students', 'id', student.id, student.avatarKey);
  if (res.status === 200) await logAudit(c.env.DB, null, 'STUDENT_SELF_UPDATE_AVATAR', student.id, null, true);
  return res;
});

app.delete('/portal/:studentId/avatar', async (c) => {
  const studentId = c.req.param('studentId');
  if (!(await portalTokenMatchesStudent(c, studentId))) return c.json({ status: 'error', message: 'Unauthorized' }, 401);

  const student = await c.env.DB.prepare(`SELECT id, avatar_key AS avatarKey FROM students WHERE id = ? COLLATE NOCASE AND deleted_at IS NULL`)
    .bind(studentId)
    .first<{ id: string; avatarKey: string | null }>();
  if (!student) return c.json({ status: 'error', message: 'ไม่พบข้อมูลนักเรียนรหัสนี้ในระบบ' }, 404);
  if (!student.avatarKey) return c.json({ status: 'success', message: 'ไม่มีรูปภาพอยู่แล้ว' });

  await c.env.BUCKET.delete(student.avatarKey).catch(() => {});
  await c.env.DB.prepare(`UPDATE students SET avatar_key = NULL WHERE id = ?`).bind(student.id).run();
  await logAudit(c.env.DB, null, 'STUDENT_SELF_REMOVE_AVATAR', student.id, null, true);
  return c.json({ status: 'success', message: 'ลบรูปภาพสำเร็จ' });
});

// Student-portal file download. Gated by the student's own Auth0 token (the
// admin `/files/:fileId` route needs a staff permission the student lacks).
app.get('/portal/:studentId/files/:fileId', async (c) => {
  const studentId = c.req.param('studentId');
  const fileId = c.req.param('fileId');
  if (!(await portalTokenMatchesStudent(c, studentId))) return c.json({ error: 'Unauthorized' }, 401);

  const row = await c.env.DB.prepare(
    `SELECT r2_key, filename, mime_type, student_id FROM student_files WHERE id = ? AND deleted_at IS NULL`,
  )
    .bind(fileId)
    .first<{ r2_key: string; filename: string; mime_type: string; student_id: string }>();
  if (!row || row.student_id.toLowerCase() !== studentId.toLowerCase()) return c.json({ error: 'Not found' }, 404);

  const object = await c.env.BUCKET.get(row.r2_key);
  if (!object) return c.json({ error: 'File missing in storage' }, 404);
  return new Response(object.body, {
    headers: {
      'Content-Type': row.mime_type || 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${row.filename}"`,
      'Cache-Control': 'private, max-age=300',
    },
  });
});

// AI chat for the student portal. Shared by students and parents alike (the
// portal has no separate parent identity — see worker/README.md) since both
// reach this the same way everyone else reaches the portal: by knowing the
// student id. Grounded only in this student's own account data; never
// exposes other students, matching the rest of the /portal/* routes.
app.post('/portal/:studentId/chat', async (c) => {
  const studentId = c.req.param('studentId');
  const body = await c.req.json<{ conversationId?: string; message?: string }>().catch(() => ({}) as never);
  const message = (body.message ?? '').trim();
  if (!message) return c.json({ status: 'error', message: 'กรุณาพิมพ์คำถาม' }, 400);
  if (message.length > MAX_MESSAGE_LENGTH) {
    return c.json({ status: 'error', message: `ข้อความยาวเกินไป (จำกัด ${MAX_MESSAGE_LENGTH} ตัวอักษร)` }, 400);
  }

  const context = await studentChatContext(c.env.DB, studentId);
  if (!context) return c.json({ status: 'error', message: 'ไม่พบข้อมูลนักเรียนรหัสนี้ในระบบ' }, 404);

  const usedToday = await portalMessageCountToday(c.env.DB, studentId);
  if (usedToday >= PORTAL_DAILY_LIMIT) {
    return c.json({ status: 'error', message: 'วันนี้ถามคำถามครบโควตาแล้ว กรุณาลองใหม่พรุ่งนี้ หรือติดต่อเจ้าหน้าที่ผ่าน LINE OA' }, 429);
  }

  const conversationId = body.conversationId || crypto.randomUUID();
  const history = await loadChatHistory(c.env.DB, conversationId);
  const instructions = await getPortalInstructions(c.env.DB);

  const systemPrompt = [
    'You are น้องลิลลี่ (Nong Lilly), the AI assistant for LITALK Education, answering questions from a student or their parent about this one student\'s own account only. If asked your name, say น้องลิลลี่.',
    `Account data (real data from the system — reference only, never invent or guess beyond it):\n${JSON.stringify(context)}`,
    'Only answer about this student\'s own account. Never discuss or reveal any other student\'s data. You cannot edit anything, book or cancel classes, or take any action — you can only answer questions; if the user wants a change made, tell them to contact staff via LITALK\'s LINE OA. Do not give medical, legal, or financial advice beyond what is in the account data.',
    instructions
      ? `Additional guidance from the school admin on how to respond — follow it, but it never overrides the rules above (e.g. still never reveal another student's data):\n${instructions}`
      : null,
    'Reply in whichever language the user just wrote in (Thai or English). Keep answers concise, friendly, and direct — no preamble, and do not show your reasoning process, just the final answer.',
    'Format replies in Markdown (the client renders it): use **bold**, bullet lists, and short paragraphs where they help readability, but keep it light — this is a chat bubble, not a document.',
  ]
    .filter(Boolean)
    .join('\n\n');

  let reply: string;
  try {
    reply = await chatReply(c.env, systemPrompt, history, message);
  } catch (err) {
    if (err instanceof ChatNotConfiguredError) return c.json({ status: 'error', message: 'ผู้ช่วย AI ยังไม่ได้ตั้งค่าในระบบ' }, 503);
    console.error('portal chat: Gemini call failed', err);
    return c.json({ status: 'error', message: 'ระบบ AI ไม่พร้อมใช้งานในขณะนี้ กรุณาลองใหม่อีกครั้ง' }, 503);
  }

  await saveChatTurn(c.env.DB, conversationId, 'portal', studentId, null, message, reply);

  return c.json({ status: 'success', conversationId, reply });
});

// AI chat for the general marketing site (litalkeducation.com — home,
// programs, about), for visitors who aren't asking about a specific
// enrolled student's account. Not grounded in any account data — it can
// only answer general questions about LITALK Education itself. visitorId
// is a random id the site generates and persists client-side purely to
// rate-limit this endpoint; it carries no identity.
// This endpoint's own error strings are shown verbatim in the widget on
// bilingual marketing pages, so — unlike every other Thai-only error message
// in this file — they follow the site's language toggle (`lang`, sent by
// the frontend from window.litalkGetLang()) rather than being Thai-only.
// This is independent of the AI's own reply, which separately and
// correctly auto-detects whatever language the user types in.
const GENERAL_CHAT_ERRORS = {
  en: {
    emptyMessage: 'Please type a question',
    tooLong: (max: number) => `Message is too long (max ${max} characters)`,
    quota: "You've reached today's question limit. Please try again tomorrow, or contact us via LINE OA.",
    notConfigured: 'The AI assistant is not set up yet',
    callFailed: 'The AI assistant is unavailable right now. Please try again.',
  },
  th: {
    emptyMessage: 'กรุณาพิมพ์คำถาม',
    tooLong: (max: number) => `ข้อความยาวเกินไป (จำกัด ${max} ตัวอักษร)`,
    quota: 'วันนี้ถามคำถามครบโควตาแล้ว กรุณาลองใหม่พรุ่งนี้ หรือติดต่อเจ้าหน้าที่ผ่าน LINE OA',
    notConfigured: 'ผู้ช่วย AI ยังไม่ได้ตั้งค่าในระบบ',
    callFailed: 'ระบบ AI ไม่พร้อมใช้งานในขณะนี้ กรุณาลองใหม่อีกครั้ง',
  },
};

app.post('/chat/general', async (c) => {
  const body = await c.req.json<{ conversationId?: string; message?: string; visitorId?: string; lang?: string }>().catch(() => ({}) as never);
  const message = (body.message ?? '').trim();
  const visitorId = (body.visitorId ?? '').trim();
  const errors = GENERAL_CHAT_ERRORS[body.lang === 'th' ? 'th' : 'en'];
  if (!message) return c.json({ status: 'error', message: errors.emptyMessage }, 400);
  if (message.length > MAX_MESSAGE_LENGTH) {
    return c.json({ status: 'error', message: errors.tooLong(MAX_MESSAGE_LENGTH) }, 400);
  }
  if (!visitorId) return c.json({ status: 'error', message: 'Missing visitorId' }, 400);

  const usedToday = await generalMessageCountToday(c.env.DB, visitorId);
  if (usedToday >= GENERAL_DAILY_LIMIT) {
    return c.json({ status: 'error', message: errors.quota }, 429);
  }

  const conversationId = body.conversationId || crypto.randomUUID();
  const history = await loadChatHistory(c.env.DB, conversationId);
  const instructions = await getPortalInstructions(c.env.DB);

  const systemPrompt = [
    'You are น้องลิลลี่ (Nong Lilly), the AI assistant for LITALK Education\'s public website, answering general questions from visitors (prospective students/parents) who are not necessarily enrolled. If asked your name, say น้องลิลลี่.',
    'You have no access to any specific student\'s account, schedule, payments, or balance — you cannot look any of that up. If someone asks about their own account specifically, tell them to sign in at the student portal (or contact staff via LINE OA if they can\'t). Only answer general questions: what LITALK Education offers, how classes/courses generally work, how to get started, and similar. Never invent specific prices, schedules, or promotions you don\'t actually know — point those questions to the programs page or LITALK\'s LINE OA instead of guessing. You cannot take any action (book classes, create accounts, process payments) — only answer questions.',
    instructions
      ? `Additional guidance from the school admin on how to respond — follow it, but it never overrides the rules above (e.g. still never invent specific pricing/schedule details):\n${instructions}`
      : null,
    'Reply in whichever language the user just wrote in (Thai or English). Keep answers concise, friendly, and direct — no preamble, and do not show your reasoning process, just the final answer.',
    'Format replies in Markdown (the client renders it): use **bold**, bullet lists, and short paragraphs where they help readability, but keep it light — this is a chat bubble, not a document.',
  ]
    .filter(Boolean)
    .join('\n\n');

  let reply: string;
  try {
    reply = await chatReply(c.env, systemPrompt, history, message);
  } catch (err) {
    if (err instanceof ChatNotConfiguredError) return c.json({ status: 'error', message: errors.notConfigured }, 503);
    console.error('general chat: Gemini call failed', err);
    return c.json({ status: 'error', message: errors.callFailed }, 503);
  }

  await saveChatTurn(c.env.DB, conversationId, 'general', null, visitorId, message, reply);

  return c.json({ status: 'success', conversationId, reply });
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
app.route('/', chat);
app.route('/', blog);
app.route('/', shortLinks);

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
