// "ตรวจสอบนักเรียน" (student check), monthly schedules with admin approval,
// per-teacher student visibility, and in-app student deletion.

import { Hono } from 'hono';
import type { AppBindings, AuthUser } from './types';
import { requirePermission, requireAdmin, isAdmin } from './auth';
import { logAudit } from './db';
import { bangkokToday, bangkokMonth, isYm, isYmd, isHm } from './dates';
import { createStripePaymentLink, StripeError } from './stripe';

// ===== Per-teacher student visibility =====
// Admin sees everyone (returns null = unrestricted). A teacher with
// assignment rows sees only those students; a teacher with no rows sees
// everyone, so nothing breaks until the admin opts that teacher in.
export async function visibleStudentIds(db: D1Database, user: AuthUser): Promise<Set<string> | null> {
  if (isAdmin(user)) return null;
  const { results } = await db
    .prepare(`SELECT student_id FROM teacher_students WHERE teacher_email = ? COLLATE NOCASE`)
    .bind(user.email)
    .all<{ student_id: string }>();
  if (!results || results.length === 0) return null;
  return new Set(results.map((r) => r.student_id));
}

export function canSeeStudent(visible: Set<string> | null, studentId: string): boolean {
  return visible === null || visible.has(studentId);
}

// ===== Schedule activation =====
// A successful payment turns an approved schedule live immediately: each
// planned session becomes a booking (INSERT OR IGNORE — a slot that is
// already taken is skipped rather than failing the whole activation).
export async function activateSchedule(db: D1Database, scheduleId: number): Promise<boolean> {
  const sched = await db
    .prepare(`SELECT id, student_id, month, created_by FROM monthly_schedules WHERE id = ? AND status = 'approved'`)
    .bind(scheduleId)
    .first<{ id: number; student_id: string; month: string; created_by: string | null }>();
  if (!sched) return false;

  const { results: sessions } = await db
    .prepare(`SELECT session_date, session_time FROM schedule_sessions WHERE schedule_id = ? ORDER BY session_date, session_time`)
    .bind(scheduleId)
    .all<{ session_date: string; session_time: string }>();

  const stmts: D1PreparedStatement[] = (sessions ?? []).map((s) =>
    db
      .prepare(`INSERT OR IGNORE INTO bookings (student_id, booking_date, booking_time, notes, created_by) VALUES (?, ?, ?, ?, ?)`)
      .bind(sched.student_id, s.session_date, s.session_time, `ตารางเรียนเดือน ${sched.month}`, sched.created_by),
  );
  stmts.push(db.prepare(`UPDATE monthly_schedules SET status = 'active', activated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(scheduleId));
  await db.batch(stmts);
  return true;
}

// A payment without an explicit schedule reference (manual record, or a
// Stripe link created outside the approval flow) activates every approved
// schedule of that student — in practice at most one per month.
export async function activateApprovedSchedulesForStudent(db: D1Database, studentId: string): Promise<number> {
  const { results } = await db
    .prepare(`SELECT id FROM monthly_schedules WHERE student_id = ? AND status = 'approved'`)
    .bind(studentId)
    .all<{ id: number }>();
  let activated = 0;
  for (const row of results ?? []) {
    if (await activateSchedule(db, row.id)) activated++;
  }
  return activated;
}

const manage = new Hono<AppBindings>();

// ===== Delete student (admin only) =====
// Removes the student from the app (soft delete) and frees their future
// booking slots. The Auth0 login account is deliberately NOT touched.

manage.delete('/students/:id', requireAdmin, async (c) => {
  const studentId = c.req.param('id');
  if (!studentId) return c.json({ error: 'Missing student id' }, 400);
  const user = c.get('user');

  const result = await c.env.DB.prepare(`UPDATE students SET deleted_at = CURRENT_TIMESTAMP WHERE id = ? AND deleted_at IS NULL`)
    .bind(studentId)
    .run();
  if (result.meta.changes === 0) return c.json({ error: 'ไม่พบนักเรียนรหัสนี้ในระบบ' }, 404);

  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE bookings SET status = 'cancelled' WHERE student_id = ? AND booking_date >= ? AND status = 'booked'`)
      .bind(studentId, bangkokToday()),
    c.env.DB.prepare(`DELETE FROM teacher_students WHERE student_id = ?`).bind(studentId),
  ]);
  await logAudit(c.env.DB, user, 'DELETE_STUDENT', studentId, null, true);
  return c.json({ ok: true, message: `ลบนักเรียน ${studentId} ออกจากระบบแล้ว (บัญชีเข้าสู่ระบบใน Auth0 ไม่ถูกลบ)` });
});

// ===== Student check ("ตรวจสอบนักเรียน") =====
// One call returns everything the check screen needs: profile, payment
// status this month, upcoming study days, recent logs, and schedule states.

manage.get('/student-check/:id', requirePermission('data:read'), async (c) => {
  const studentId = c.req.param('id');
  if (!studentId) return c.json({ error: 'Missing student id' }, 400);
  const user = c.get('user');

  const visible = await visibleStudentIds(c.env.DB, user);
  if (!canSeeStudent(visible, studentId)) return c.json({ error: 'Forbidden' }, 403);

  const student = await c.env.DB.prepare(
    `SELECT id, name, nickname, email, phone, course, created_at AS createdAt FROM students WHERE id = ? AND deleted_at IS NULL`,
  )
    .bind(studentId)
    .first();
  if (!student) return c.json({ error: 'ไม่พบนักเรียนรหัสนี้ในระบบ' }, 404);

  const month = bangkokMonth();
  const today = bangkokToday();
  const [monthPays, lastPay, pendingLinks, upcoming, recentLogs, schedules] = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count FROM payments WHERE student_id = ? AND paid_date LIKE ? || '%'`)
      .bind(studentId, month),
    c.env.DB.prepare(`SELECT paid_date AS date, amount, method FROM payments WHERE student_id = ? ORDER BY paid_date DESC, id DESC LIMIT 1`)
      .bind(studentId),
    c.env.DB.prepare(`SELECT url, amount, description FROM payment_links WHERE student_id = ? AND status = 'active' ORDER BY id DESC LIMIT 5`)
      .bind(studentId),
    c.env.DB.prepare(
      `SELECT booking_date AS date, booking_time AS time, notes FROM bookings
       WHERE student_id = ? AND status = 'booked' AND booking_date >= ? ORDER BY booking_date, booking_time LIMIT 20`,
    ).bind(studentId, today),
    c.env.DB.prepare(`SELECT log_date AS date, feedback, video_url AS video, created_by AS createdBy FROM study_logs WHERE student_id = ? ORDER BY log_date DESC, id DESC LIMIT 5`)
      .bind(studentId),
    c.env.DB.prepare(
      `SELECT ms.id, ms.month, ms.status, ms.total_amount AS total, ms.rate_per_session AS rate, ms.created_by AS createdBy,
              (SELECT COUNT(*) FROM schedule_sessions ss WHERE ss.schedule_id = ms.id) AS sessionCount,
              pl.url AS paymentUrl
       FROM monthly_schedules ms LEFT JOIN payment_links pl ON pl.id = ms.payment_link_id
       WHERE ms.student_id = ? ORDER BY ms.month DESC, ms.id DESC LIMIT 6`,
    ).bind(studentId),
  ]);

  const monthRow = (monthPays.results?.[0] ?? { total: 0, count: 0 }) as { total: number; count: number };
  return c.json({
    student,
    month,
    payment: {
      paidThisMonth: monthRow.count > 0,
      monthTotal: monthRow.total,
      last: lastPay.results?.[0] ?? null,
      pendingLinks: pendingLinks.results ?? [],
    },
    upcomingClasses: upcoming.results ?? [],
    recentLogs: recentLogs.results ?? [],
    schedules: schedules.results ?? [],
  });
});

// ===== Monthly schedules =====

const SCHEDULE_STATUSES = ['pending', 'approved', 'active', 'rejected', 'cancelled'] as const;

manage.post('/schedules', requirePermission('data:write'), async (c) => {
  const body = await c.req.json<{
    studentId?: string;
    month?: string;
    ratePerSession?: number | string;
    note?: string;
    sessions?: Array<{ date?: string; time?: string }>;
  }>();

  if (!body.studentId) return c.json({ error: 'Missing studentId' }, 400);
  if (!isYm(body.month)) return c.json({ error: 'Invalid month (YYYY-MM)' }, 400);
  const rate = Number(body.ratePerSession);
  if (!Number.isFinite(rate) || rate <= 0) return c.json({ error: 'Invalid ratePerSession' }, 400);

  const rawSessions = Array.isArray(body.sessions) ? body.sessions : [];
  const sessions = rawSessions.filter((s): s is { date: string; time: string } => isYmd(s.date) && isHm(s.time));
  if (sessions.length === 0) return c.json({ error: 'กรุณาระบุคาบเรียนอย่างน้อย 1 คาบ' }, 400);
  if (sessions.length !== rawSessions.length) return c.json({ error: 'มีคาบเรียนที่วันหรือเวลาไม่ถูกต้อง' }, 400);
  if (sessions.some((s) => !s.date.startsWith(body.month!))) {
    return c.json({ error: `ทุกคาบเรียนต้องอยู่ในเดือน ${body.month}` }, 400);
  }

  const user = c.get('user');
  const visible = await visibleStudentIds(c.env.DB, user);
  if (!canSeeStudent(visible, body.studentId)) return c.json({ error: 'Forbidden' }, 403);

  const student = await c.env.DB.prepare(`SELECT id, name FROM students WHERE id = ? AND deleted_at IS NULL`)
    .bind(body.studentId)
    .first<{ id: string; name: string }>();
  if (!student) return c.json({ error: 'ไม่พบนักเรียนรหัสนี้ในระบบ' }, 404);

  const dup = await c.env.DB.prepare(
    `SELECT id FROM monthly_schedules WHERE student_id = ? AND month = ? AND status IN ('pending', 'approved', 'active')`,
  )
    .bind(body.studentId, body.month)
    .first();
  if (dup) return c.json({ error: `นักเรียนคนนี้มีตารางเรียนเดือน ${body.month} ที่รอดำเนินการหรือใช้งานอยู่แล้ว` }, 409);

  const total = rate * sessions.length;
  const result = await c.env.DB.prepare(
    `INSERT INTO monthly_schedules (student_id, month, rate_per_session, total_amount, note, created_by) VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(body.studentId, body.month, rate, total, body.note?.trim() || null, user.email)
    .run();
  const scheduleId = Number(result.meta.last_row_id);

  await c.env.DB.batch(
    sessions.map((s) =>
      c.env.DB.prepare(`INSERT OR IGNORE INTO schedule_sessions (schedule_id, session_date, session_time) VALUES (?, ?, ?)`)
        .bind(scheduleId, s.date, s.time),
    ),
  );
  await logAudit(c.env.DB, user, 'CREATE_SCHEDULE', body.studentId, `${body.month} x${sessions.length}`, true);

  return c.json({
    ok: true,
    id: scheduleId,
    total,
    message: `ส่งตารางเรียนเดือน ${body.month} ของ ${student.name} (${sessions.length} ครั้ง รวม ${total.toLocaleString()} บาท) รอแอดมินอนุมัติ`,
  });
});

manage.get('/schedules', requirePermission('data:read'), async (c) => {
  const user = c.get('user');
  const admin = isAdmin(user);
  const status = c.req.query('status');

  let sql = `SELECT ms.id, ms.student_id AS studentId, COALESCE(s.name, ms.student_id) AS studentName, ms.month,
                    ms.rate_per_session AS rate, ms.total_amount AS total, ms.note, ms.status, ms.reject_reason AS rejectReason,
                    ms.created_by AS createdBy, ms.approved_by AS approvedBy, ms.created_at AS createdAt,
                    (SELECT COUNT(*) FROM schedule_sessions ss WHERE ss.schedule_id = ms.id) AS sessionCount,
                    pl.url AS paymentUrl, pl.status AS paymentLinkStatus
             FROM monthly_schedules ms
             LEFT JOIN students s ON s.id = ms.student_id
             LEFT JOIN payment_links pl ON pl.id = ms.payment_link_id`;
  const where: string[] = [];
  const binds: unknown[] = [];
  // Teachers see only schedules they submitted; admins see everything.
  if (!admin) {
    where.push('ms.created_by = ? COLLATE NOCASE');
    binds.push(user.email);
  }
  if (status && (SCHEDULE_STATUSES as readonly string[]).includes(status)) {
    where.push('ms.status = ?');
    binds.push(status);
  }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY ms.id DESC LIMIT 50';

  const { results } = await c.env.DB.prepare(sql).bind(...binds).all<Record<string, unknown> & { id: number }>();
  const rows = results ?? [];

  if (rows.length) {
    const ids = rows.map((r) => r.id);
    const { results: sess } = await c.env.DB.prepare(
      `SELECT schedule_id AS scheduleId, session_date AS date, session_time AS time
       FROM schedule_sessions WHERE schedule_id IN (${ids.map(() => '?').join(',')})
       ORDER BY session_date, session_time`,
    )
      .bind(...ids)
      .all<{ scheduleId: number; date: string; time: string }>();
    const byId = new Map<number, Array<{ date: string; time: string }>>();
    for (const s of sess ?? []) {
      if (!byId.has(s.scheduleId)) byId.set(s.scheduleId, []);
      byId.get(s.scheduleId)!.push({ date: s.date, time: s.time });
    }
    for (const r of rows) (r as Record<string, unknown>).sessions = byId.get(r.id) ?? [];
  }

  return c.json(rows);
});

// Approve: mark approved and (if Stripe is configured) create the payment
// link the admin forwards to the parent. Metadata carries schedule_id so the
// webhook can activate exactly this schedule when the parent pays.
manage.post('/schedules/:id/approve', requireAdmin, async (c) => {
  const id = Number(c.req.param('id'));
  const sched = await c.env.DB.prepare(
    `SELECT ms.id, ms.student_id AS studentId, ms.month, ms.total_amount AS total,
            (SELECT COUNT(*) FROM schedule_sessions ss WHERE ss.schedule_id = ms.id) AS sessionCount,
            COALESCE(s.name, ms.student_id) AS studentName
     FROM monthly_schedules ms LEFT JOIN students s ON s.id = ms.student_id
     WHERE ms.id = ? AND ms.status = 'pending'`,
  )
    .bind(id)
    .first<{ id: number; studentId: string; month: string; total: number; sessionCount: number; studentName: string }>();
  if (!sched) return c.json({ error: 'ไม่พบตารางเรียนที่รออนุมัติ' }, 404);

  const user = c.get('user');
  let paymentUrl: string | null = null;
  let warning: string | null = null;

  if (c.env.STRIPE_SECRET_KEY) {
    try {
      const description = `ค่าเรียนเดือน ${sched.month} - ${sched.studentName} (${sched.sessionCount} ครั้ง)`;
      const link = await createStripePaymentLink(c.env.STRIPE_SECRET_KEY, {
        productName: description,
        amountSatang: Math.round(sched.total * 100),
        currency: 'thb',
        metadata: {
          student_id: sched.studentId,
          schedule_id: String(sched.id),
          created_by: user.email,
        },
      });
      const linkRow = await c.env.DB.prepare(
        `INSERT INTO payment_links (stripe_payment_link_id, url, student_id, customer_name, description, amount, currency, created_by)
         VALUES (?, ?, ?, ?, ?, ?, 'thb', ?)`,
      )
        .bind(link.id, link.url, sched.studentId, sched.studentName, description, sched.total, user.email)
        .run();
      await c.env.DB.prepare(`UPDATE monthly_schedules SET payment_link_id = ? WHERE id = ?`)
        .bind(Number(linkRow.meta.last_row_id), id)
        .run();
      paymentUrl = link.url;
    } catch (err) {
      // Approve anyway — a manual payment record still activates the
      // schedule; the admin just has to collect the money another way.
      warning = err instanceof StripeError ? `สร้างลิงก์ชำระเงินไม่สำเร็จ (Stripe: ${err.message})` : 'สร้างลิงก์ชำระเงินไม่สำเร็จ';
    }
  }

  await c.env.DB.prepare(`UPDATE monthly_schedules SET status = 'approved', approved_by = ?, approved_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .bind(user.email, id)
    .run();
  await logAudit(c.env.DB, user, 'APPROVE_SCHEDULE', sched.studentId, String(id), true);

  let message = `อนุมัติตารางเรียนเดือน ${sched.month} ของ ${sched.studentName} แล้ว`;
  if (paymentUrl) message += ' — ส่งลิงก์ชำระเงินให้ผู้ปกครองได้เลย ตารางจะเริ่มทำงานทันทีเมื่อชำระสำเร็จ';
  else if (warning) message += ` — ${warning} ตารางจะเริ่มทำงานเมื่อบันทึกการชำระเงินในระบบ`;
  else message += ' — ตารางจะเริ่มทำงานเมื่อบันทึกการชำระเงินในระบบ';

  return c.json({ ok: true, paymentUrl, warning, message });
});

manage.post('/schedules/:id/reject', requireAdmin, async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.json<{ reason?: string }>().catch(() => ({ reason: undefined }));
  const user = c.get('user');

  const result = await c.env.DB.prepare(
    `UPDATE monthly_schedules SET status = 'rejected', reject_reason = ?, approved_by = ?, approved_at = CURRENT_TIMESTAMP
     WHERE id = ? AND status = 'pending'`,
  )
    .bind(body.reason?.trim() || null, user.email, id)
    .run();
  if (result.meta.changes === 0) return c.json({ error: 'ไม่พบตารางเรียนที่รออนุมัติ' }, 404);

  await logAudit(c.env.DB, user, 'REJECT_SCHEDULE', null, String(id), true);
  return c.json({ ok: true, message: 'ปฏิเสธตารางเรียนแล้ว ครูสามารถแก้ไขและส่งใหม่ได้' });
});

// Teachers can cancel their own pending schedule; admins can cancel any
// schedule that has not started running yet.
manage.post('/schedules/:id/cancel', requirePermission('data:write'), async (c) => {
  const id = Number(c.req.param('id'));
  const user = c.get('user');
  const admin = isAdmin(user);

  const sched = await c.env.DB.prepare(`SELECT id, status, created_by FROM monthly_schedules WHERE id = ?`)
    .bind(id)
    .first<{ id: number; status: string; created_by: string | null }>();
  if (!sched) return c.json({ error: 'ไม่พบตารางเรียน' }, 404);
  const cancellable = admin ? ['pending', 'approved'] : ['pending'];
  if (!cancellable.includes(sched.status)) return c.json({ error: 'ตารางเรียนนี้ยกเลิกไม่ได้แล้ว' }, 400);
  if (!admin && (sched.created_by ?? '').toLowerCase() !== user.email.toLowerCase()) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  await c.env.DB.prepare(`UPDATE monthly_schedules SET status = 'cancelled' WHERE id = ?`).bind(id).run();
  await logAudit(c.env.DB, user, 'CANCEL_SCHEDULE', null, String(id), true);
  return c.json({ ok: true, message: 'ยกเลิกตารางเรียนแล้ว' });
});

// ===== Teacher visibility management (admin only) =====

// The identities the Worker has actually seen (from the audit log), so the
// admin can assign visibility to exactly the string a teacher's requests
// carry. If the Auth0 email Action is not configured these are `auth0|...`
// subs, not emails — assignments must then use the sub.
manage.get('/staff-identities', requireAdmin, async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT user_email AS identity, MAX(created_at) AS lastSeen, COUNT(*) AS actions
     FROM audit_logs WHERE user_email IS NOT NULL AND user_email != ''
     GROUP BY user_email ORDER BY lastSeen DESC LIMIT 25`,
  ).all();
  return c.json(results ?? []);
});

manage.get('/teacher-assignments', requireAdmin, async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT teacher_email AS teacher, student_id AS studentId FROM teacher_students ORDER BY teacher_email, student_id`,
  ).all<{ teacher: string; studentId: string }>();

  const grouped = new Map<string, string[]>();
  for (const row of results ?? []) {
    if (!grouped.has(row.teacher)) grouped.set(row.teacher, []);
    grouped.get(row.teacher)!.push(row.studentId);
  }
  return c.json([...grouped.entries()].map(([teacher, studentIds]) => ({ teacher, studentIds })));
});

// Replaces a teacher's whole assignment set. An empty list removes the
// restriction (the teacher goes back to seeing every student). The key is
// the identity the teacher's requests carry: their email when the Auth0
// email Action is configured, otherwise their `auth0|...` sub.
manage.put('/teacher-assignments/:teacher', requireAdmin, async (c) => {
  const teacher = decodeURIComponent(c.req.param('teacher') ?? '').trim().toLowerCase();
  if (teacher.length < 3 || /\s/.test(teacher) || (!teacher.includes('@') && !teacher.includes('|'))) {
    return c.json({ error: 'Invalid teacher identity (expected an email or an auth0|... sub)' }, 400);
  }

  const body = await c.req.json<{ studentIds?: string[] }>();
  const ids = Array.isArray(body.studentIds)
    ? [...new Set(body.studentIds.filter((x): x is string => typeof x === 'string' && x.length > 0))]
    : [];

  const user = c.get('user');
  const stmts: D1PreparedStatement[] = [
    c.env.DB.prepare(`DELETE FROM teacher_students WHERE teacher_email = ? COLLATE NOCASE`).bind(teacher),
    ...ids.map((sid) =>
      c.env.DB.prepare(`INSERT OR IGNORE INTO teacher_students (teacher_email, student_id, created_by) VALUES (?, ?, ?)`)
        .bind(teacher, sid, user.email),
    ),
  ];
  await c.env.DB.batch(stmts);
  await logAudit(c.env.DB, user, 'SET_TEACHER_STUDENTS', null, `${teacher}:${ids.length}`, true);

  return c.json({
    ok: true,
    message: ids.length
      ? `กำหนดให้ ${teacher} เห็นนักเรียน ${ids.length} คน`
      : `ล้างการจำกัดสิทธิ์ของ ${teacher} แล้ว (กลับไปเห็นนักเรียนทุกคน)`,
  });
});

export default manage;
