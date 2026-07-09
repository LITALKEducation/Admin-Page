// "ตรวจสอบนักเรียน" (student check), monthly schedules with admin approval,
// per-teacher student visibility, and in-app student deletion.

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppBindings, AuthUser, Env } from './types';
import { requirePermission, requireAdmin, isAdmin } from './auth';
import { logAudit } from './db';
import { bangkokToday, bangkokMonth, isYm, isYmd, isHm, formatSessionsThai } from './dates';
import { createStripePaymentLink, deactivateStripePaymentLink, StripeError, withPolicyNote } from './stripe';
import { createMeetEvent, deleteMeetEvent } from './googlemeet';

// Cancels every 'booked' row matching a WHERE clause (student_id, dates,
// notes label, ...) and best-effort deletes each one's Google Calendar
// event. Used everywhere a booking is dropped (student deletion, schedule
// resync, amendment withdrawal) so the Meet event never outlives its booking.
async function cancelBookings(db: D1Database, env: Env, whereSql: string, params: unknown[]): Promise<void> {
  const { results } = await db
    .prepare(`SELECT id, calendar_event_id AS calendarEventId FROM bookings WHERE status = 'booked' AND ${whereSql}`)
    .bind(...params)
    .all<{ id: number; calendarEventId: string | null }>();
  const rows = results ?? [];
  if (!rows.length) return;
  await db
    .prepare(`UPDATE bookings SET status = 'cancelled' WHERE status = 'booked' AND ${whereSql}`)
    .bind(...params)
    .run();
  await Promise.allSettled(rows.map((r) => deleteMeetEvent(env, r.calendarEventId)));
}

// Creates a Google Meet event for each session (in parallel) and returns
// them in the same order, so callers can zip them into their INSERT binds.
// Never throws — createMeetEvent already degrades to null per-session.
async function createMeetEvents(
  env: Env,
  studentId: string,
  studentName: string,
  course: string | null | undefined,
  sessions: Array<{ date: string; time: string }>,
) {
  return Promise.all(sessions.map((s) => createMeetEvent(env, { studentName, course, date: s.date, time: s.time })));
}

// ===== Per-teacher student visibility =====
// Admin sees everyone (returns null = unrestricted). A non-admin teacher
// sees ONLY their admin-assigned students — including none: an unassigned
// teacher gets an empty set and therefore sees nothing until the admin
// grants access (the UI then shows a "contact staff" empty state).
export async function visibleStudentIds(db: D1Database, user: AuthUser): Promise<Set<string> | null> {
  if (isAdmin(user)) return null;
  const { results } = await db
    .prepare(`SELECT student_id FROM teacher_students WHERE teacher_email = ? COLLATE NOCASE`)
    .bind(user.email)
    .all<{ student_id: string }>();
  return new Set((results ?? []).map((r) => r.student_id));
}

export function canSeeStudent(visible: Set<string> | null, studentId: string): boolean {
  return visible === null || visible.has(studentId);
}

// ===== Class-hour credits (1 credit = 1 hour = 1 session) =====

export async function creditBalance(db: D1Database, studentId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COALESCE(SUM(hours), 0) AS balance FROM student_credits WHERE student_id = ?`)
    .bind(studentId)
    .first<{ balance: number }>();
  return row?.balance ?? 0;
}

// Returns credits reserved from a student's balance for a set of sessions:
// spends min(balance, sessionCount) hours, records the ledger entry, and
// gives back how many hours were covered so the caller can price only the
// remainder.
async function reserveCredits(
  db: D1Database,
  studentId: string,
  scheduleId: number,
  sessionCount: number,
  actor: string,
  month: string,
): Promise<number> {
  const balance = await creditBalance(db, studentId);
  const used = Math.min(Math.max(0, balance), sessionCount);
  if (used > 0) {
    await db
      .prepare(`INSERT INTO student_credits (student_id, hours, reason, schedule_id, created_by) VALUES (?, ?, ?, ?, ?)`)
      .bind(studentId, -used, `ใช้เครดิตกับตารางเรียนเดือน ${month}`, scheduleId, actor)
      .run();
  }
  return used;
}

// Gives back the credits a schedule was holding (used when it is edited,
// rejected, or cancelled before being paid) and zeroes its reservation.
async function releaseScheduleCredits(db: D1Database, scheduleId: number, actor: string): Promise<void> {
  const sched = await db
    .prepare(`SELECT student_id, credits_applied AS applied, month FROM monthly_schedules WHERE id = ?`)
    .bind(scheduleId)
    .first<{ student_id: string; applied: number; month: string }>();
  if (!sched || !sched.applied) return;
  await db.batch([
    db
      .prepare(`INSERT INTO student_credits (student_id, hours, reason, schedule_id, created_by) VALUES (?, ?, ?, ?, ?)`)
      .bind(sched.student_id, sched.applied, `คืนเครดิตจากตารางเรียนเดือน ${sched.month}`, scheduleId, actor),
    db.prepare(`UPDATE monthly_schedules SET credits_applied = 0 WHERE id = ?`).bind(scheduleId),
  ]);
}

// ===== Schedule activation =====
// A successful payment turns an approved schedule live immediately: each
// planned session becomes a booking (INSERT OR IGNORE — a slot that is
// already taken is skipped rather than failing the whole activation).
export async function activateSchedule(db: D1Database, env: Env, scheduleId: number): Promise<boolean> {
  const sched = await db
    .prepare(`SELECT id, student_id, month, created_by FROM monthly_schedules WHERE id = ? AND status = 'approved'`)
    .bind(scheduleId)
    .first<{ id: number; student_id: string; month: string; created_by: string | null }>();
  if (!sched) return false;

  const { results: sessions } = await db
    .prepare(`SELECT session_date, session_time FROM schedule_sessions WHERE schedule_id = ? ORDER BY session_date, session_time`)
    .bind(scheduleId)
    .all<{ session_date: string; session_time: string }>();
  const rows = sessions ?? [];

  const student = await db.prepare(`SELECT name, course FROM students WHERE id = ?`).bind(sched.student_id).first<{ name: string; course: string | null }>();
  const meets = await createMeetEvents(
    env,
    sched.student_id,
    student?.name ?? sched.student_id,
    student?.course,
    rows.map((s) => ({ date: s.session_date, time: s.session_time })),
  );

  const stmts: D1PreparedStatement[] = rows.map((s, i) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO bookings (student_id, booking_date, booking_time, notes, created_by, meet_link, calendar_event_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(sched.student_id, s.session_date, s.session_time, `ตารางเรียนเดือน ${sched.month}`, sched.created_by, meets[i]?.meetLink ?? null, meets[i]?.eventId ?? null),
  );
  stmts.push(db.prepare(`UPDATE monthly_schedules SET status = 'active', activated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(scheduleId));
  await db.batch(stmts);
  return true;
}

// A payment without an explicit schedule reference (manual record, or a
// Stripe link created outside the approval flow) activates every approved
// schedule of that student — in practice at most one per month.
export async function activateApprovedSchedulesForStudent(db: D1Database, env: Env, studentId: string): Promise<number> {
  const { results } = await db
    .prepare(`SELECT id FROM monthly_schedules WHERE student_id = ? AND status = 'approved'`)
    .bind(studentId)
    .all<{ id: number }>();
  let activated = 0;
  for (const row of results ?? []) {
    if (await activateSchedule(db, env, row.id)) activated++;
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

  await cancelBookings(c.env.DB, c.env, `student_id = ? AND booking_date >= ?`, [studentId, bangkokToday()]);
  await c.env.DB.prepare(`DELETE FROM teacher_students WHERE student_id = ?`).bind(studentId).run();
  await logAudit(c.env.DB, user, 'DELETE_STUDENT', studentId, null, true);
  return c.json({ ok: true, message: `ลบนักเรียน ${studentId} ออกจากระบบแล้ว (บัญชีเข้าสู่ระบบใน Auth0 ไม่ถูกลบ)` });
});

// ===== Credit editing (admin only) =====
// Manual adjustments to a student's class-hour credit ledger — e.g. a
// goodwill credit or correcting an error — go through the same
// student_credits table as schedule/amendment credits, just with
// schedule_id left NULL.

manage.get('/students/:id/credits', requireAdmin, async (c) => {
  const studentId = c.req.param('id');
  if (!studentId) return c.json({ error: 'Missing student id' }, 400);
  const student = await c.env.DB.prepare(`SELECT id, name FROM students WHERE id = ? AND deleted_at IS NULL`)
    .bind(studentId)
    .first<{ id: string; name: string }>();
  if (!student) return c.json({ error: 'ไม่พบนักเรียนรหัสนี้ในระบบ' }, 404);

  const [entries, balance] = await Promise.all([
    c.env.DB.prepare(
      `SELECT id, hours, reason, schedule_id AS scheduleId, created_by AS createdBy, created_at AS createdAt
       FROM student_credits WHERE student_id = ? ORDER BY created_at DESC, id DESC LIMIT 50`,
    )
      .bind(studentId)
      .all(),
    creditBalance(c.env.DB, studentId),
  ]);

  return c.json({ student, balance, entries: entries.results ?? [] });
});

manage.post('/students/:id/credits/adjust', requireAdmin, async (c) => {
  const studentId = c.req.param('id');
  if (!studentId) return c.json({ error: 'Missing student id' }, 400);
  const user = c.get('user');
  const body = await c.req.json<{ hours?: number | string; reason?: string }>();

  const hours = Number(body.hours);
  if (!Number.isFinite(hours) || hours === 0) return c.json({ error: 'กรุณากรอกจำนวนชั่วโมงที่ไม่เป็นศูนย์' }, 400);
  const reason = (body.reason ?? '').trim();
  if (!reason) return c.json({ error: 'กรุณาระบุเหตุผลการปรับเครดิต' }, 400);

  const student = await c.env.DB.prepare(`SELECT id, name FROM students WHERE id = ? AND deleted_at IS NULL`)
    .bind(studentId)
    .first<{ id: string; name: string }>();
  if (!student) return c.json({ error: 'ไม่พบนักเรียนรหัสนี้ในระบบ' }, 404);

  await c.env.DB.prepare(`INSERT INTO student_credits (student_id, hours, reason, created_by) VALUES (?, ?, ?, ?)`)
    .bind(studentId, hours, reason, user.email)
    .run();
  const balance = await creditBalance(c.env.DB, studentId);
  await logAudit(c.env.DB, user, 'ADJUST_CREDIT', studentId, `${hours > 0 ? '+' : ''}${hours} (${reason})`, true);

  const sign = hours > 0 ? '+' : '';
  return c.json({
    ok: true,
    balance,
    message: `ปรับเครดิตของ ${student.name} เรียบร้อย (${sign}${hours} ชม.) ยอดคงเหลือ ${balance} ชม.`,
  });
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
  const admin = isAdmin(user);
  const [monthPays, lastPay, pendingLinks, upcoming, recentLogs, schedules, credit] = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count FROM payments WHERE student_id = ? AND paid_date LIKE ? || '%'`)
      .bind(studentId, month),
    // proof_url/stripe_session_id are only meaningful to the admin (payment
    // verification); the route still selects them, the response just omits
    // them for teachers.
    c.env.DB.prepare(
      `SELECT id, paid_date AS date, amount, method, source, proof_url AS proof, stripe_session_id AS stripeSessionId
       FROM payments WHERE student_id = ? ORDER BY paid_date DESC, id DESC LIMIT 1`,
    ).bind(studentId),
    c.env.DB.prepare(`SELECT url, amount, description FROM payment_links WHERE student_id = ? AND status = 'active' ORDER BY id DESC LIMIT 5`)
      .bind(studentId),
    c.env.DB.prepare(
      `SELECT booking_date AS date, booking_time AS time, notes FROM bookings
       WHERE student_id = ? AND status = 'booked' AND booking_date >= ? ORDER BY booking_date, booking_time LIMIT 20`,
    ).bind(studentId, today),
    c.env.DB.prepare(`SELECT id, log_date AS date, feedback, video_url AS video, created_by AS createdBy FROM study_logs WHERE student_id = ? ORDER BY log_date DESC, id DESC LIMIT 5`)
      .bind(studentId),
    c.env.DB.prepare(
      `SELECT ms.id, ms.month, ms.status, ms.total_amount AS total, ms.rate_per_session AS rate,
              ms.credits_applied AS creditsApplied, ms.created_by AS createdBy,
              (SELECT COUNT(*) FROM schedule_sessions ss WHERE ss.schedule_id = ms.id) AS sessionCount,
              pl.url AS paymentUrl
       FROM monthly_schedules ms LEFT JOIN payment_links pl ON pl.id = ms.payment_link_id
       WHERE ms.student_id = ? ORDER BY ms.month DESC, ms.id DESC LIMIT 6`,
    ).bind(studentId),
    c.env.DB.prepare(`SELECT COALESCE(SUM(hours), 0) AS balance FROM student_credits WHERE student_id = ?`).bind(studentId),
  ]);

  const scheduleRows = (schedules.results ?? []) as Array<Record<string, unknown> & { id: number }>;
  if (scheduleRows.length) {
    const ids = scheduleRows.map((r) => r.id);
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
    for (const r of scheduleRows) r.sessions = byId.get(r.id) ?? [];
  }

  const lastPayRow = lastPay.results?.[0] as
    | { id: number; date: string; amount: number; method: string | null; source: string; proof: string | null; stripeSessionId: string | null }
    | undefined;

  const monthRow = (monthPays.results?.[0] ?? { total: 0, count: 0 }) as { total: number; count: number };
  return c.json({
    student,
    month,
    creditBalance: (credit.results?.[0] as { balance: number } | undefined)?.balance ?? 0,
    payment: {
      paidThisMonth: monthRow.count > 0,
      monthTotal: monthRow.total,
      last: lastPayRow
        ? {
            id: lastPayRow.id,
            date: lastPayRow.date,
            amount: lastPayRow.amount,
            method: lastPayRow.method,
            source: lastPayRow.source,
            // Only the admin sees payment verification details.
            proof: admin ? lastPayRow.proof : undefined,
            stripeSessionId: admin ? lastPayRow.stripeSessionId : undefined,
          }
        : null,
      pendingLinks: pendingLinks.results ?? [],
    },
    upcomingClasses: upcoming.results ?? [],
    recentLogs: recentLogs.results ?? [],
    schedules: scheduleRows,
  });
});

// ===== Monthly schedules =====

const SCHEDULE_STATUSES = ['pending', 'approved', 'active', 'rejected', 'cancelled', 'revise'] as const;

interface CleanSession {
  date: string;
  time: string;
}

// Validates + normalises a month's sessions; returns an error string or the
// clean list. Shared by create and edit.
function parseSessions(month: string, raw: unknown): { error: string } | { sessions: CleanSession[] } {
  const arr = Array.isArray(raw) ? (raw as Array<{ date?: string; time?: string }>) : [];
  const sessions = arr.filter((s): s is CleanSession => isYmd(s.date) && isHm(s.time));
  if (sessions.length === 0) return { error: 'กรุณาระบุคาบเรียนอย่างน้อย 1 คาบ' };
  if (sessions.length !== arr.length) return { error: 'มีคาบเรียนที่วันหรือเวลาไม่ถูกต้อง' };
  if (sessions.some((s) => !s.date.startsWith(month))) return { error: `ทุกคาบเรียนต้องอยู่ในเดือน ${month}` };
  return { sessions };
}

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

  const parsed = parseSessions(body.month, body.sessions);
  if ('error' in parsed) return c.json({ error: parsed.error }, 400);
  const { sessions } = parsed;

  const user = c.get('user');
  const visible = await visibleStudentIds(c.env.DB, user);
  if (!canSeeStudent(visible, body.studentId)) return c.json({ error: 'Forbidden' }, 403);

  const student = await c.env.DB.prepare(`SELECT id, name FROM students WHERE id = ? AND deleted_at IS NULL`)
    .bind(body.studentId)
    .first<{ id: string; name: string }>();
  if (!student) return c.json({ error: 'ไม่พบนักเรียนรหัสนี้ในระบบ' }, 404);

  const dup = await c.env.DB.prepare(
    `SELECT id FROM monthly_schedules WHERE student_id = ? AND month = ? AND status IN ('pending', 'approved', 'active', 'revise')`,
  )
    .bind(body.studentId, body.month)
    .first();
  if (dup) return c.json({ error: `นักเรียนคนนี้มีตารางเรียนเดือน ${body.month} ที่รอดำเนินการหรือใช้งานอยู่แล้ว` }, 409);

  // Insert first (need the id for the credit ledger), then reserve credits
  // and price only the sessions credit doesn't cover.
  const inserted = await c.env.DB.prepare(
    `INSERT INTO monthly_schedules (student_id, month, rate_per_session, total_amount, note, created_by) VALUES (?, ?, ?, 0, ?, ?)`,
  )
    .bind(body.studentId, body.month, rate, body.note?.trim() || null, user.email)
    .run();
  const scheduleId = Number(inserted.meta.last_row_id);

  await c.env.DB.batch(
    sessions.map((s) =>
      c.env.DB.prepare(`INSERT OR IGNORE INTO schedule_sessions (schedule_id, session_date, session_time) VALUES (?, ?, ?)`)
        .bind(scheduleId, s.date, s.time),
    ),
  );

  const creditsUsed = await reserveCredits(c.env.DB, body.studentId, scheduleId, sessions.length, user.email, body.month);
  const chargedSessions = sessions.length - creditsUsed;
  const total = chargedSessions * rate;
  await c.env.DB.prepare(`UPDATE monthly_schedules SET total_amount = ?, credits_applied = ? WHERE id = ?`)
    .bind(total, creditsUsed, scheduleId)
    .run();
  await logAudit(c.env.DB, user, 'CREATE_SCHEDULE', body.studentId, `${body.month} x${sessions.length}`, true);

  let message = `ส่งตารางเรียนเดือน ${body.month} ของ ${student.name} (${sessions.length} ครั้ง`;
  message += creditsUsed > 0 ? ` — ใช้เครดิต ${creditsUsed} ชม. เหลือเก็บ ${total.toLocaleString()} บาท)` : ` รวม ${total.toLocaleString()} บาท)`;
  message += ' รอแอดมินอนุมัติ';
  return c.json({ ok: true, id: scheduleId, total, creditsUsed, message });
});

// Edit a schedule. Teachers (owner) or admins may fully re-do a schedule
// that is pending / rejected / revise — it re-prices (credits included) and
// goes back to 'pending'. Admins may also adjust an approved / active
// (already-paid) schedule's sessions: reducing hours converts the removed
// sessions to credit, and an active schedule's bookings are re-synced.
manage.patch('/schedules/:id', requirePermission('data:write'), async (c) => {
  const id = Number(c.req.param('id'));
  const user = c.get('user');
  const admin = isAdmin(user);

  const sched = await c.env.DB.prepare(
    `SELECT id, student_id AS studentId, month, rate_per_session AS rate, status, created_by AS createdBy FROM monthly_schedules WHERE id = ?`,
  )
    .bind(id)
    .first<{ id: number; studentId: string; month: string; rate: number; status: string; createdBy: string | null }>();
  if (!sched) return c.json({ error: 'ไม่พบตารางเรียน' }, 404);

  const visible = await visibleStudentIds(c.env.DB, user);
  if (!canSeeStudent(visible, sched.studentId)) return c.json({ error: 'Forbidden' }, 403);

  const body = await c.req.json<{ ratePerSession?: number | string; note?: string; sessions?: Array<{ date?: string; time?: string }> }>();
  const parsed = parseSessions(sched.month, body.sessions);
  if ('error' in parsed) return c.json({ error: parsed.error }, 400);
  const { sessions } = parsed;

  const editableByOwner = ['pending', 'rejected', 'revise'];
  const editableByAdminPaid = ['approved', 'active'];

  if (editableByOwner.includes(sched.status)) {
    if (!admin && (sched.createdBy ?? '').toLowerCase() !== user.email.toLowerCase()) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    const rate = body.ratePerSession !== undefined ? Number(body.ratePerSession) : sched.rate;
    if (!Number.isFinite(rate) || rate <= 0) return c.json({ error: 'Invalid ratePerSession' }, 400);

    // Re-do the sessions and re-price from scratch: give back any credit the
    // old version held, then reserve afresh for the new session count.
    await releaseScheduleCredits(c.env.DB, id, user.email);
    await c.env.DB.prepare(`DELETE FROM schedule_sessions WHERE schedule_id = ?`).bind(id).run();
    await c.env.DB.batch(
      sessions.map((s) =>
        c.env.DB.prepare(`INSERT OR IGNORE INTO schedule_sessions (schedule_id, session_date, session_time) VALUES (?, ?, ?)`)
          .bind(id, s.date, s.time),
      ),
    );
    const creditsUsed = await reserveCredits(c.env.DB, sched.studentId, id, sessions.length, user.email, sched.month);
    const total = (sessions.length - creditsUsed) * rate;
    await c.env.DB.prepare(
      `UPDATE monthly_schedules SET rate_per_session = ?, total_amount = ?, credits_applied = ?, note = ?,
         status = 'pending', reject_reason = NULL, revise_note = NULL WHERE id = ?`,
    )
      .bind(rate, total, creditsUsed, body.note?.trim() || null, id)
      .run();
    await logAudit(c.env.DB, user, 'EDIT_SCHEDULE', sched.studentId, `${id} -> pending`, true);
    return c.json({ ok: true, total, creditsUsed, message: 'บันทึกและส่งตารางเรียนให้แอดมินอนุมัติอีกครั้งแล้ว' });
  }

  if (editableByAdminPaid.includes(sched.status)) {
    if (!admin) return c.json({ error: 'ตารางเรียนนี้แก้ไขได้เฉพาะแอดมิน (ชำระเงินแล้ว)' }, 403);

    const { results: oldSess } = await c.env.DB.prepare(
      `SELECT session_date AS date, session_time AS time FROM schedule_sessions WHERE schedule_id = ?`,
    )
      .bind(id)
      .all<CleanSession>();
    const oldCount = (oldSess ?? []).length;
    const newCount = sessions.length;

    // Replace the schedule's sessions.
    await c.env.DB.prepare(`DELETE FROM schedule_sessions WHERE schedule_id = ?`).bind(id).run();
    await c.env.DB.batch(
      sessions.map((s) =>
        c.env.DB.prepare(`INSERT OR IGNORE INTO schedule_sessions (schedule_id, session_date, session_time) VALUES (?, ?, ?)`)
          .bind(id, s.date, s.time),
      ),
    );

    // For an active (already-running) schedule, re-sync its bookings: drop
    // the ones it created, then re-add for the new set.
    if (sched.status === 'active') {
      const label = `ตารางเรียนเดือน ${sched.month}`;
      await cancelBookings(c.env.DB, c.env, `student_id = ? AND notes = ?`, [sched.studentId, label]);
      const student = await c.env.DB.prepare(`SELECT name, course FROM students WHERE id = ?`)
        .bind(sched.studentId)
        .first<{ name: string; course: string | null }>();
      const meets = await createMeetEvents(c.env, sched.studentId, student?.name ?? sched.studentId, student?.course, sessions);
      await c.env.DB.batch(
        sessions.map((s, i) =>
          c.env.DB.prepare(
            `INSERT OR IGNORE INTO bookings (student_id, booking_date, booking_time, notes, created_by, meet_link, calendar_event_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
            .bind(sched.studentId, s.date, s.time, label, user.email, meets[i]?.meetLink ?? null, meets[i]?.eventId ?? null),
        ),
      );
    }

    // Reducing a paid schedule's hours becomes credit (1 credit / hour).
    let credited = 0;
    if (newCount < oldCount) {
      credited = oldCount - newCount;
      await c.env.DB.prepare(`INSERT INTO student_credits (student_id, hours, reason, schedule_id, created_by) VALUES (?, ?, ?, ?, ?)`)
        .bind(sched.studentId, credited, `ลดชั่วโมงตารางเรียนเดือน ${sched.month}`, id, user.email)
        .run();
    }
    await c.env.DB.prepare(`UPDATE monthly_schedules SET note = COALESCE(?, note) WHERE id = ?`)
      .bind(body.note?.trim() || null, id)
      .run();
    await logAudit(c.env.DB, user, 'EDIT_PAID_SCHEDULE', sched.studentId, `${id} ${oldCount}->${newCount}`, true);

    let message = `ปรับตารางเรียนเดือน ${sched.month} แล้ว (${oldCount} → ${newCount} ครั้ง)`;
    if (credited > 0) message += ` — เพิ่มเครดิตให้นักเรียน ${credited} ชม.`;
    return c.json({ ok: true, credited, message });
  }

  return c.json({ error: 'ตารางเรียนสถานะนี้แก้ไขไม่ได้' }, 400);
});

manage.get('/schedules', requirePermission('data:read'), async (c) => {
  const user = c.get('user');
  const admin = isAdmin(user);
  const status = c.req.query('status');

  let sql = `SELECT ms.id, ms.student_id AS studentId, COALESCE(s.name, ms.student_id) AS studentName, ms.month,
                    ms.rate_per_session AS rate, ms.total_amount AS total, ms.credits_applied AS creditsApplied,
                    ms.note, ms.status, ms.reject_reason AS rejectReason, ms.revise_note AS reviseNote,
                    ms.created_by AS createdBy, COALESCE(st.name, ms.created_by) AS createdByName,
                    ms.approved_by AS approvedBy, ms.created_at AS createdAt,
                    (SELECT COUNT(*) FROM schedule_sessions ss WHERE ss.schedule_id = ms.id) AS sessionCount,
                    pl.url AS paymentUrl, pl.status AS paymentLinkStatus
             FROM monthly_schedules ms
             LEFT JOIN students s ON s.id = ms.student_id
             LEFT JOIN staff st ON st.identity = ms.created_by COLLATE NOCASE
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
  const body = await c.req.json<{ description?: string }>().catch(() => ({ description: undefined }));
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

  // Fully covered by credit (nothing to charge): approve and activate now.
  if (sched.total <= 0) {
    await c.env.DB.prepare(`UPDATE monthly_schedules SET status = 'approved', approved_by = ?, approved_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .bind(user.email, id)
      .run();
    await activateSchedule(c.env.DB, c.env, id);
    await logAudit(c.env.DB, user, 'APPROVE_SCHEDULE', sched.studentId, `${id} (credit)`, true);
    return c.json({
      ok: true,
      paymentUrl: null,
      warning: null,
      message: `อนุมัติตารางเรียนเดือน ${sched.month} ของ ${sched.studentName} แล้ว — ใช้เครดิตเต็มจำนวน ไม่ต้องชำระเงิน ตารางเริ่มทำงานทันที`,
    });
  }

  let paymentUrl: string | null = null;
  let warning: string | null = null;

  if (c.env.STRIPE_SECRET_KEY) {
    try {
      const productName = `ค่าเรียนเดือน ${sched.month} - ${sched.studentName} (${sched.sessionCount} ครั้ง)`;
      // Custom description if the admin supplied one; otherwise auto-list
      // every session's date and time. The no-refund policy note is always
      // appended.
      let autoDescription = body.description?.trim();
      if (!autoDescription) {
        const { results: sess } = await c.env.DB.prepare(
          `SELECT session_date AS date, session_time AS time FROM schedule_sessions WHERE schedule_id = ?`,
        )
          .bind(sched.id)
          .all<{ date: string; time: string }>();
        autoDescription = `คาบเรียน: ${formatSessionsThai(sess ?? [])}`;
      }
      const link = await createStripePaymentLink(c.env.STRIPE_SECRET_KEY, {
        productName,
        productDescription: withPolicyNote(autoDescription),
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
        .bind(link.id, link.url, sched.studentId, sched.studentName, productName, sched.total, user.email)
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

  await releaseScheduleCredits(c.env.DB, id, user.email);
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

// "Request revision" — softer than rejecting: keeps the schedule and asks
// the teacher to re-check it. The teacher edits it (PATCH) and it returns to
// 'pending' instead of being thrown away and rebuilt from scratch.
manage.post('/schedules/:id/revise', requireAdmin, async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.json<{ note?: string }>().catch(() => ({ note: undefined }));
  const user = c.get('user');

  await releaseScheduleCredits(c.env.DB, id, user.email);
  const result = await c.env.DB.prepare(
    `UPDATE monthly_schedules SET status = 'revise', revise_note = ?, approved_by = ?, approved_at = CURRENT_TIMESTAMP
     WHERE id = ? AND status = 'pending'`,
  )
    .bind(body.note?.trim() || null, user.email, id)
    .run();
  if (result.meta.changes === 0) return c.json({ error: 'ไม่พบตารางเรียนที่รออนุมัติ' }, 404);

  await logAudit(c.env.DB, user, 'REVISE_SCHEDULE', null, String(id), true);
  return c.json({ ok: true, message: 'ส่งกลับให้ครูปรับปรุงตารางเรียนแล้ว' });
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
  const cancellable = admin ? ['pending', 'approved', 'rejected', 'revise'] : ['pending', 'rejected', 'revise'];
  if (!cancellable.includes(sched.status)) return c.json({ error: 'ตารางเรียนนี้ยกเลิกไม่ได้แล้ว' }, 400);
  if (!admin && (sched.created_by ?? '').toLowerCase() !== user.email.toLowerCase()) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  await releaseScheduleCredits(c.env.DB, id, user.email);
  await c.env.DB.prepare(`UPDATE monthly_schedules SET status = 'cancelled' WHERE id = ?`).bind(id).run();
  await logAudit(c.env.DB, user, 'CANCEL_SCHEDULE', null, String(id), true);
  return c.json({ ok: true, message: 'ยกเลิกตารางเรียนแล้ว' });
});

// ===== Schedule amendments (add / withdraw hours on a live schedule) =====
// A teacher can request extra or fewer sessions once a schedule is already
// approved (or active). An admin acting directly applies the same request
// immediately instead of parking it as 'pending'. Either way, the same
// decision logic runs once the request is "decided":
//   - remove: sessions are dropped and converted to credit right away —
//     no payment is ever involved.
//   - add: the student's credit balance is spent first; only sessions left
//     uncovered are charged (a Stripe link if configured, else a manual
//     payment activates it later, matching the original schedule flow).

const AMENDMENT_STATUSES = ['pending', 'awaiting_payment', 'applied', 'rejected', 'cancelled'] as const;
type ScheduleRow = { id: number; studentId: string; month: string; rate: number; status: string };

async function applyAddSessions(
  db: D1Database,
  env: Env,
  schedule: ScheduleRow,
  sessions: CleanSession[],
  actor: string,
): Promise<void> {
  const stmts: D1PreparedStatement[] = sessions.map((s) =>
    db.prepare(`INSERT OR IGNORE INTO schedule_sessions (schedule_id, session_date, session_time) VALUES (?, ?, ?)`)
      .bind(schedule.id, s.date, s.time),
  );
  if (schedule.status === 'active') {
    const label = `ตารางเรียนเดือน ${schedule.month}`;
    const student = await db.prepare(`SELECT name, course FROM students WHERE id = ?`).bind(schedule.studentId).first<{ name: string; course: string | null }>();
    const meets = await createMeetEvents(env, schedule.studentId, student?.name ?? schedule.studentId, student?.course, sessions);
    stmts.push(
      ...sessions.map((s, i) =>
        db
          .prepare(
            `INSERT OR IGNORE INTO bookings (student_id, booking_date, booking_time, notes, created_by, meet_link, calendar_event_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(schedule.studentId, s.date, s.time, label, actor, meets[i]?.meetLink ?? null, meets[i]?.eventId ?? null),
      ),
    );
  }
  await db.batch(stmts);
}

async function applyRemoveSessions(
  db: D1Database,
  env: Env,
  schedule: ScheduleRow,
  sessions: CleanSession[],
  actor: string,
): Promise<void> {
  const stmts: D1PreparedStatement[] = sessions.map((s) =>
    db.prepare(`DELETE FROM schedule_sessions WHERE schedule_id = ? AND session_date = ? AND session_time = ?`)
      .bind(schedule.id, s.date, s.time),
  );
  let cancelledEventIds: (string | null)[] = [];
  if (schedule.status === 'active' && sessions.length > 0) {
    const label = `ตารางเรียนเดือน ${schedule.month}`;
    const { results } = await db
      .prepare(
        `SELECT calendar_event_id AS calendarEventId FROM bookings
         WHERE student_id = ? AND status = 'booked' AND notes = ?
           AND (${sessions.map(() => '(booking_date = ? AND booking_time = ?)').join(' OR ')})`,
      )
      .bind(schedule.studentId, label, ...sessions.flatMap((s) => [s.date, s.time]))
      .all<{ calendarEventId: string | null }>();
    cancelledEventIds = (results ?? []).map((r) => r.calendarEventId);
    stmts.push(
      ...sessions.map((s) =>
        db.prepare(`UPDATE bookings SET status = 'cancelled' WHERE student_id = ? AND booking_date = ? AND booking_time = ? AND notes = ? AND status = 'booked'`)
          .bind(schedule.studentId, s.date, s.time, label),
      ),
    );
  }
  stmts.push(
    db.prepare(`INSERT INTO student_credits (student_id, hours, reason, schedule_id, created_by) VALUES (?, ?, ?, ?, ?)`)
      .bind(schedule.studentId, sessions.length, `ถอนชั่วโมงจากตารางเรียนเดือน ${schedule.month}`, schedule.id, actor),
  );
  await db.batch(stmts);
  await Promise.allSettled(cancelledEventIds.map((id) => deleteMeetEvent(env, id)));
}

// Runs the credit-then-charge decision for an amendment and updates its row.
// Used both when an admin creates a request directly and when an admin
// approves a teacher's pending request — same outcome either way.
async function decideAmendment(
  c: Context<AppBindings>,
  amendment: {
    id: number;
    scheduleId: number;
    studentId: string;
    type: string;
    sessions: CleanSession[];
    rate: number;
  },
  schedule: ScheduleRow,
): Promise<{ message: string; paymentUrl: string | null }> {
  const db = c.env.DB;
  const user = c.get('user');

  if (amendment.type === 'remove') {
    await applyRemoveSessions(db, c.env, schedule, amendment.sessions, user.email);
    await db
      .prepare(`UPDATE schedule_amendments SET status = 'applied', approved_by = ?, approved_at = CURRENT_TIMESTAMP, applied_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .bind(user.email, amendment.id)
      .run();
    await logAudit(db, user, 'APPLY_AMENDMENT_REMOVE', amendment.studentId, `${amendment.id} x${amendment.sessions.length}`, true);
    return { message: `ถอนชั่วโมงเรียน ${amendment.sessions.length} คาบแล้ว — เพิ่มเครดิตให้นักเรียน ${amendment.sessions.length} ชม.`, paymentUrl: null };
  }

  // type 'add'
  const sessionCount = amendment.sessions.length;
  const balance = await creditBalance(db, amendment.studentId);
  const creditsUsed = Math.min(Math.max(0, balance), sessionCount);
  const chargeCount = sessionCount - creditsUsed;
  const chargeAmount = chargeCount * amendment.rate;

  if (creditsUsed > 0) {
    await db
      .prepare(`INSERT INTO student_credits (student_id, hours, reason, schedule_id, created_by) VALUES (?, ?, ?, ?, ?)`)
      .bind(amendment.studentId, -creditsUsed, `ใช้เครดิตกับคำร้องเพิ่มชั่วโมงเดือน ${schedule.month}`, schedule.id, user.email)
      .run();
  }

  if (chargeAmount <= 0) {
    await applyAddSessions(db, c.env, schedule, amendment.sessions, user.email);
    await db
      .prepare(`UPDATE schedule_amendments SET status = 'applied', credits_used = ?, charge_amount = 0, approved_by = ?, approved_at = CURRENT_TIMESTAMP, applied_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .bind(creditsUsed, user.email, amendment.id)
      .run();
    await logAudit(db, user, 'APPLY_AMENDMENT_ADD', amendment.studentId, `${amendment.id} x${sessionCount} (credit)`, true);
    return {
      message: `เพิ่มชั่วโมงเรียน ${sessionCount} คาบแล้ว — ใช้เครดิตเต็มจำนวน ไม่ต้องชำระเงิน`,
      paymentUrl: null,
    };
  }

  // Remainder needs payment.
  let paymentUrl: string | null = null;
  let paymentLinkId: number | null = null;
  let warning: string | null = null;
  const student = await db.prepare(`SELECT name FROM students WHERE id = ?`).bind(amendment.studentId).first<{ name: string }>();
  const studentName = student?.name ?? amendment.studentId;

  if (c.env.STRIPE_SECRET_KEY) {
    try {
      const productName = `เพิ่มชั่วโมงเรียนเดือน ${schedule.month} - ${studentName} (${chargeCount} ครั้ง)`;
      const description = `คาบเรียนที่เพิ่ม: ${formatSessionsThai(amendment.sessions)}`;
      const link = await createStripePaymentLink(c.env.STRIPE_SECRET_KEY, {
        productName,
        productDescription: withPolicyNote(description),
        amountSatang: Math.round(chargeAmount * 100),
        currency: 'thb',
        metadata: { student_id: amendment.studentId, amendment_id: String(amendment.id), created_by: user.email },
      });
      const linkRow = await db
        .prepare(
          `INSERT INTO payment_links (stripe_payment_link_id, url, student_id, customer_name, description, amount, currency, created_by)
           VALUES (?, ?, ?, ?, ?, ?, 'thb', ?)`,
        )
        .bind(link.id, link.url, amendment.studentId, studentName, productName, chargeAmount, user.email)
        .run();
      paymentLinkId = Number(linkRow.meta.last_row_id);
      paymentUrl = link.url;
    } catch (err) {
      warning = err instanceof StripeError ? `สร้างลิงก์ชำระเงินไม่สำเร็จ (Stripe: ${err.message})` : 'สร้างลิงก์ชำระเงินไม่สำเร็จ';
    }
  }

  await db
    .prepare(
      `UPDATE schedule_amendments SET status = 'awaiting_payment', credits_used = ?, charge_amount = ?, payment_link_id = ?,
         approved_by = ?, approved_at = CURRENT_TIMESTAMP WHERE id = ?`,
    )
    .bind(creditsUsed, chargeAmount, paymentLinkId, user.email, amendment.id)
    .run();
  await logAudit(db, user, 'APPROVE_AMENDMENT_ADD', amendment.studentId, `${amendment.id} x${sessionCount}`, true);

  let message = `เพิ่มชั่วโมงเรียน ${sessionCount} คาบ`;
  if (creditsUsed > 0) message += ` (ใช้เครดิต ${creditsUsed} ชม. เหลือเก็บ ${chargeAmount.toLocaleString()} บาท)`;
  else message += ` รวม ${chargeAmount.toLocaleString()} บาท`;
  message += paymentUrl
    ? ' — ส่งลิงก์ชำระเงินให้ผู้ปกครองได้เลย จะเพิ่มคาบเรียนทันทีเมื่อชำระสำเร็จ'
    : warning
      ? ` — ${warning} จะเพิ่มคาบเรียนเมื่อบันทึกการชำระเงินในระบบ`
      : ' — จะเพิ่มคาบเรียนเมื่อบันทึกการชำระเงินในระบบ';

  return { message, paymentUrl };
}

// Activates a paid 'awaiting_payment' add-amendment: inserts its sessions
// (and bookings, if the schedule is active) and marks it applied. Called
// from the Stripe webhook (via metadata.amendment_id) and from the manual
// payment hook below.
export async function activateAmendment(db: D1Database, env: Env, amendmentId: number): Promise<boolean> {
  const amendment = await db
    .prepare(`SELECT id, schedule_id AS scheduleId, sessions FROM schedule_amendments WHERE id = ? AND status = 'awaiting_payment' AND type = 'add'`)
    .bind(amendmentId)
    .first<{ id: number; scheduleId: number; sessions: string }>();
  if (!amendment) return false;

  const schedule = await db
    .prepare(`SELECT id, student_id AS studentId, month, rate_per_session AS rate, status FROM monthly_schedules WHERE id = ?`)
    .bind(amendment.scheduleId)
    .first<ScheduleRow>();
  if (!schedule) return false;

  const sessions = JSON.parse(amendment.sessions) as CleanSession[];
  await applyAddSessions(db, env, schedule, sessions, 'system');
  await db
    .prepare(`UPDATE schedule_amendments SET status = 'applied', applied_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .bind(amendment.id)
    .run();
  return true;
}

// A manual payment without a specific amendment reference activates every
// awaiting-payment add-amendment for that student (mirrors
// activateApprovedSchedulesForStudent).
export async function activateAwaitingAmendmentsForStudent(db: D1Database, env: Env, studentId: string): Promise<number> {
  const { results } = await db
    .prepare(`SELECT id FROM schedule_amendments WHERE student_id = ? AND status = 'awaiting_payment' AND type = 'add'`)
    .bind(studentId)
    .all<{ id: number }>();
  let activated = 0;
  for (const row of results ?? []) {
    if (await activateAmendment(db, env, row.id)) activated++;
  }
  return activated;
}

async function loadEditableSchedule(c: Context<AppBindings>, scheduleId: number): Promise<ScheduleRow | null> {
  return c.env.DB.prepare(`SELECT id, student_id AS studentId, month, rate_per_session AS rate, status FROM monthly_schedules WHERE id = ?`)
    .bind(scheduleId)
    .first<ScheduleRow>();
}

// Teacher requests, or admin directly performs, an add/withdraw-hours change
// on a schedule that is already approved or active.
manage.post('/schedules/:id/amend', requirePermission('data:write'), async (c) => {
  const scheduleId = Number(c.req.param('id'));
  const user = c.get('user');
  const admin = isAdmin(user);

  const schedule = await loadEditableSchedule(c, scheduleId);
  if (!schedule) return c.json({ error: 'ไม่พบตารางเรียน' }, 404);
  if (!['approved', 'active'].includes(schedule.status)) {
    return c.json({ error: 'ขอเพิ่ม/ถอนชั่วโมงได้เฉพาะตารางเรียนที่อนุมัติแล้ว' }, 400);
  }
  const visible = await visibleStudentIds(c.env.DB, user);
  if (!canSeeStudent(visible, schedule.studentId)) return c.json({ error: 'Forbidden' }, 403);

  const body = await c.req.json<{ type?: string; sessions?: Array<{ date?: string; time?: string }>; note?: string }>();
  if (body.type !== 'add' && body.type !== 'remove') return c.json({ error: 'ระบุประเภทคำร้อง add หรือ remove' }, 400);

  const parsed = parseSessions(schedule.month, body.sessions);
  if ('error' in parsed) return c.json({ error: parsed.error }, 400);
  const { sessions } = parsed;

  const { results: existing } = await c.env.DB.prepare(
    `SELECT session_date AS date, session_time AS time FROM schedule_sessions WHERE schedule_id = ?`,
  )
    .bind(scheduleId)
    .all<CleanSession>();
  const existingKeys = new Set((existing ?? []).map((s) => `${s.date} ${s.time}`));

  if (body.type === 'add') {
    const dup = sessions.find((s) => existingKeys.has(`${s.date} ${s.time}`));
    if (dup) return c.json({ error: `คาบเรียนวันที่ ${dup.date} เวลา ${dup.time} มีอยู่แล้วในตาราง` }, 409);
  } else {
    const missing = sessions.find((s) => !existingKeys.has(`${s.date} ${s.time}`));
    if (missing) return c.json({ error: `ไม่พบคาบเรียนวันที่ ${missing.date} เวลา ${missing.time} ในตารางนี้` }, 400);
  }

  const inserted = await c.env.DB.prepare(
    `INSERT INTO schedule_amendments (schedule_id, student_id, type, sessions, rate_per_session, note, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(scheduleId, schedule.studentId, body.type, JSON.stringify(sessions), schedule.rate, body.note?.trim() || null, user.email)
    .run();
  const amendmentId = Number(inserted.meta.last_row_id);

  if (!admin) {
    await logAudit(c.env.DB, user, 'REQUEST_AMENDMENT', schedule.studentId, `${amendmentId} ${body.type} x${sessions.length}`, true);
    return c.json({
      ok: true,
      id: amendmentId,
      message: `ส่งคำร้อง${body.type === 'add' ? 'เพิ่ม' : 'ถอน'}ชั่วโมงเรียน (${sessions.length} คาบ) ให้แอดมินอนุมัติแล้ว`,
    });
  }

  // Admin acting directly: decide immediately, no pending state.
  const decision = await decideAmendment(
    c,
    { id: amendmentId, scheduleId, studentId: schedule.studentId, type: body.type, sessions, rate: schedule.rate },
    schedule,
  );
  return c.json({ ok: true, id: amendmentId, ...decision });
});

manage.get('/schedules/:id/amendments', requirePermission('data:read'), async (c) => {
  const scheduleId = Number(c.req.param('id'));
  const { results } = await c.env.DB.prepare(
    `SELECT sa.id, sa.schedule_id AS scheduleId, sa.type, sa.sessions, sa.rate_per_session AS rate,
            sa.credits_used AS creditsUsed, sa.charge_amount AS chargeAmount, sa.status, sa.note,
            sa.reject_reason AS rejectReason, sa.created_by AS createdBy, COALESCE(st.name, sa.created_by) AS createdByName,
            sa.approved_by AS approvedBy, sa.created_at AS createdAt, pl.url AS paymentUrl
     FROM schedule_amendments sa
     LEFT JOIN staff st ON st.identity = sa.created_by COLLATE NOCASE
     LEFT JOIN payment_links pl ON pl.id = sa.payment_link_id
     WHERE sa.schedule_id = ? ORDER BY sa.id DESC`,
  )
    .bind(scheduleId)
    .all<{ sessions: string }>();
  const rows = (results ?? []).map((r) => ({ ...r, sessions: JSON.parse(r.sessions) }));
  return c.json(rows);
});

// Admin's approval queue / history across all schedules; teachers see their own.
manage.get('/schedule-amendments', requirePermission('data:read'), async (c) => {
  const user = c.get('user');
  const admin = isAdmin(user);
  const status = c.req.query('status');

  let sql = `SELECT sa.id, sa.schedule_id AS scheduleId, ms.student_id AS studentId,
                    COALESCE(s.name, ms.student_id) AS studentName, ms.month, sa.type, sa.sessions,
                    sa.rate_per_session AS rate, sa.credits_used AS creditsUsed, sa.charge_amount AS chargeAmount,
                    sa.status, sa.note, sa.reject_reason AS rejectReason,
                    sa.created_by AS createdBy, COALESCE(st.name, sa.created_by) AS createdByName,
                    sa.approved_by AS approvedBy, sa.created_at AS createdAt, pl.url AS paymentUrl
             FROM schedule_amendments sa
             JOIN monthly_schedules ms ON ms.id = sa.schedule_id
             LEFT JOIN students s ON s.id = ms.student_id
             LEFT JOIN staff st ON st.identity = sa.created_by COLLATE NOCASE
             LEFT JOIN payment_links pl ON pl.id = sa.payment_link_id`;
  const where: string[] = [];
  const binds: unknown[] = [];
  if (!admin) {
    where.push('sa.created_by = ? COLLATE NOCASE');
    binds.push(user.email);
  }
  if (status && (AMENDMENT_STATUSES as readonly string[]).includes(status)) {
    where.push('sa.status = ?');
    binds.push(status);
  }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY sa.id DESC LIMIT 50';

  const { results } = await c.env.DB.prepare(sql).bind(...binds).all<{ sessions: string }>();
  const rows = (results ?? []).map((r) => ({ ...r, sessions: JSON.parse(r.sessions) }));
  return c.json(rows);
});

manage.post('/schedule-amendments/:id/approve', requireAdmin, async (c) => {
  const id = Number(c.req.param('id'));
  const amendment = await c.env.DB.prepare(
    `SELECT id, schedule_id AS scheduleId, student_id AS studentId, type, sessions, rate_per_session AS rate
     FROM schedule_amendments WHERE id = ? AND status = 'pending'`,
  )
    .bind(id)
    .first<{ id: number; scheduleId: number; studentId: string; type: string; sessions: string; rate: number }>();
  if (!amendment) return c.json({ error: 'ไม่พบคำร้องที่รออนุมัติ' }, 404);

  const schedule = await loadEditableSchedule(c, amendment.scheduleId);
  if (!schedule) return c.json({ error: 'ไม่พบตารางเรียน' }, 404);

  const decision = await decideAmendment(
    c,
    { id: amendment.id, scheduleId: amendment.scheduleId, studentId: amendment.studentId, type: amendment.type, sessions: JSON.parse(amendment.sessions), rate: amendment.rate },
    schedule,
  );
  return c.json({ ok: true, ...decision });
});

manage.post('/schedule-amendments/:id/reject', requireAdmin, async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.json<{ reason?: string }>().catch(() => ({ reason: undefined }));
  const user = c.get('user');

  const result = await c.env.DB.prepare(
    `UPDATE schedule_amendments SET status = 'rejected', reject_reason = ?, approved_by = ?, approved_at = CURRENT_TIMESTAMP
     WHERE id = ? AND status = 'pending'`,
  )
    .bind(body.reason?.trim() || null, user.email, id)
    .run();
  if (result.meta.changes === 0) return c.json({ error: 'ไม่พบคำร้องที่รออนุมัติ' }, 404);

  await logAudit(c.env.DB, user, 'REJECT_AMENDMENT', null, String(id), true);
  return c.json({ ok: true, message: 'ปฏิเสธคำร้องแล้ว' });
});

// Teacher cancels their own pending request; admin can cancel a pending or
// not-yet-paid request (releasing any reserved credit and disabling any
// Stripe link that was created for it).
manage.post('/schedule-amendments/:id/cancel', requirePermission('data:write'), async (c) => {
  const id = Number(c.req.param('id'));
  const user = c.get('user');
  const admin = isAdmin(user);

  const amendment = await c.env.DB.prepare(
    `SELECT id, schedule_id AS scheduleId, student_id AS studentId, status, credits_used AS creditsUsed,
            payment_link_id AS paymentLinkId, created_by AS createdBy
     FROM schedule_amendments WHERE id = ?`,
  )
    .bind(id)
    .first<{ id: number; scheduleId: number; studentId: string; status: string; creditsUsed: number; paymentLinkId: number | null; createdBy: string | null }>();
  if (!amendment) return c.json({ error: 'ไม่พบคำร้อง' }, 404);

  const cancellable = admin ? ['pending', 'awaiting_payment'] : ['pending'];
  if (!cancellable.includes(amendment.status)) return c.json({ error: 'คำร้องนี้ยกเลิกไม่ได้แล้ว' }, 400);
  if (!admin && (amendment.createdBy ?? '').toLowerCase() !== user.email.toLowerCase()) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  if (amendment.creditsUsed > 0) {
    const schedule = await loadEditableSchedule(c, amendment.scheduleId);
    await c.env.DB.prepare(`INSERT INTO student_credits (student_id, hours, reason, schedule_id, created_by) VALUES (?, ?, ?, ?, ?)`)
      .bind(amendment.studentId, amendment.creditsUsed, `คืนเครดิตจากคำร้องที่ยกเลิก เดือน ${schedule?.month ?? ''}`, amendment.scheduleId, user.email)
      .run();
  }
  if (amendment.paymentLinkId && c.env.STRIPE_SECRET_KEY) {
    const link = await c.env.DB.prepare(`SELECT stripe_payment_link_id AS plId, status FROM payment_links WHERE id = ?`)
      .bind(amendment.paymentLinkId)
      .first<{ plId: string; status: string }>();
    if (link && link.status === 'active') {
      await deactivateStripePaymentLink(c.env.STRIPE_SECRET_KEY, link.plId).catch(() => {});
      await c.env.DB.prepare(`UPDATE payment_links SET status = 'deactivated' WHERE id = ?`).bind(amendment.paymentLinkId).run();
    }
  }

  await c.env.DB.prepare(`UPDATE schedule_amendments SET status = 'cancelled' WHERE id = ?`).bind(id).run();
  await logAudit(c.env.DB, user, 'CANCEL_AMENDMENT', amendment.studentId, String(id), true);
  return c.json({ ok: true, message: 'ยกเลิกคำร้องแล้ว' });
});

// ===== Teacher visibility management (admin only) =====

// The identities the Worker has actually seen (from the audit log), so the
// admin can assign visibility to exactly the string a teacher's requests
// carry. If the Auth0 email Action is not configured these are `auth0|...`
// subs, not emails — assignments must then use the sub.
manage.get('/staff-identities', requireAdmin, async (c) => {
  // Prefer the staff directory (has display names); fall back to the audit
  // log for identities seen before the directory existed.
  const { results } = await c.env.DB.prepare(
    `SELECT s.identity AS identity, s.name AS name, s.is_admin AS isAdmin, s.last_seen AS lastSeen
     FROM staff s ORDER BY s.last_seen DESC LIMIT 50`,
  ).all();
  if (results && results.length) return c.json(results);

  const { results: fallback } = await c.env.DB.prepare(
    `SELECT user_email AS identity, user_email AS name, 0 AS isAdmin, MAX(created_at) AS lastSeen
     FROM audit_logs WHERE user_email IS NOT NULL AND user_email != ''
     GROUP BY user_email ORDER BY lastSeen DESC LIMIT 25`,
  ).all();
  return c.json(fallback ?? []);
});

manage.get('/teacher-assignments', requireAdmin, async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT ts.teacher_email AS teacher, COALESCE(st.name, ts.teacher_email) AS teacherName, ts.student_id AS studentId
     FROM teacher_students ts LEFT JOIN staff st ON st.identity = ts.teacher_email COLLATE NOCASE
     ORDER BY ts.teacher_email, ts.student_id`,
  ).all<{ teacher: string; teacherName: string; studentId: string }>();

  const grouped = new Map<string, { teacherName: string; studentIds: string[] }>();
  for (const row of results ?? []) {
    if (!grouped.has(row.teacher)) grouped.set(row.teacher, { teacherName: row.teacherName, studentIds: [] });
    grouped.get(row.teacher)!.studentIds.push(row.studentId);
  }
  return c.json([...grouped.entries()].map(([teacher, v]) => ({ teacher, teacherName: v.teacherName, studentIds: v.studentIds })));
});

// ===== Bookings list (calendar/table for the booking screen) =====

manage.get('/bookings', requirePermission('data:read'), async (c) => {
  const from = isYmd(c.req.query('from')) ? c.req.query('from')! : bangkokToday();
  const { results } = await c.env.DB.prepare(
    `SELECT b.id, b.student_id AS studentId, COALESCE(s.name, b.student_id) AS studentName, s.course AS course,
            b.booking_date AS date, b.booking_time AS time, b.notes, b.created_by AS createdBy, b.meet_link AS meetLink
     FROM bookings b LEFT JOIN students s ON s.id = b.student_id
     WHERE b.status = 'booked' AND b.booking_date >= ?
     ORDER BY b.booking_date, b.booking_time LIMIT 200`,
  )
    .bind(from)
    .all<{ studentId: string }>();
  const visible = await visibleStudentIds(c.env.DB, c.get('user'));
  const rows = visible === null ? (results ?? []) : (results ?? []).filter((r) => visible.has(r.studentId));
  return c.json(rows);
});

// ===== Finance overview (admin): all transactions + per-teacher income =====

manage.get('/finance', requireAdmin, async (c) => {
  const month = isYm(c.req.query('month')) ? c.req.query('month')! : bangkokMonth();

  const [totals, bySource, byRecorder, transactions, links, discounts] = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count FROM payments WHERE paid_date LIKE ? || '%'`).bind(month),
    c.env.DB.prepare(`SELECT source, COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count FROM payments WHERE paid_date LIKE ? || '%' GROUP BY source`).bind(month),
    c.env.DB.prepare(
      `SELECT COALESCE(p.recorded_by, '-') AS identity, COALESCE(st.name, p.recorded_by, '-') AS name,
              COALESCE(SUM(p.amount), 0) AS total, COUNT(*) AS count
       FROM payments p LEFT JOIN staff st ON st.identity = p.recorded_by COLLATE NOCASE
       WHERE p.paid_date LIKE ? || '%' GROUP BY p.recorded_by ORDER BY total DESC`,
    ).bind(month),
    c.env.DB.prepare(
      `SELECT p.id, p.paid_date AS date, p.amount, p.method, p.source,
              p.proof_url AS proof, p.stripe_session_id AS stripeSessionId,
              COALESCE(s.name, pl.customer_name, p.student_id, 'ลูกค้า') AS studentName, p.student_id AS studentId,
              COALESCE(st.name, p.recorded_by, '-') AS recordedBy, pl.discount_amount AS discountAmount
       FROM payments p
       LEFT JOIN students s ON s.id = p.student_id
       LEFT JOIN payment_links pl ON pl.stripe_payment_link_id = p.stripe_payment_link_id
       LEFT JOIN staff st ON st.identity = p.recorded_by COLLATE NOCASE
       WHERE p.paid_date LIKE ? || '%' ORDER BY p.paid_date DESC, p.id DESC LIMIT 200`,
    ).bind(month),
    c.env.DB.prepare(`SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count FROM payment_links WHERE status = 'active'`),
    c.env.DB.prepare(
      `SELECT COALESCE(SUM(pl.discount_amount), 0) AS total, COUNT(*) AS count
       FROM payments p JOIN payment_links pl ON pl.stripe_payment_link_id = p.stripe_payment_link_id
       WHERE p.paid_date LIKE ? || '%' AND pl.discount_amount > 0`,
    ).bind(month),
  ]);

  // Per-teacher income = this month's payments from each teacher's
  // admin-assigned students (mirrors what each teacher sees for themselves).
  const { results: assignRows } = await c.env.DB.prepare(
    `SELECT ts.teacher_email AS teacher, COALESCE(st.name, ts.teacher_email) AS teacherName,
            COALESCE(SUM(CASE WHEN p.id IS NOT NULL THEN p.amount ELSE 0 END), 0) AS total,
            COUNT(p.id) AS count, COUNT(DISTINCT ts.student_id) AS students
     FROM teacher_students ts
     LEFT JOIN staff st ON st.identity = ts.teacher_email COLLATE NOCASE
     LEFT JOIN payments p ON p.student_id = ts.student_id AND p.paid_date LIKE ? || '%'
     GROUP BY ts.teacher_email ORDER BY total DESC`,
  )
    .bind(month)
    .all();

  const sourceRows = (bySource.results ?? []) as Array<{ source: string; total: number; count: number }>;
  return c.json({
    month,
    total: (totals.results?.[0] as { total: number }).total,
    count: (totals.results?.[0] as { count: number }).count,
    manualTotal: sourceRows.find((r) => r.source === 'manual')?.total ?? 0,
    stripeTotal: sourceRows.find((r) => r.source === 'stripe')?.total ?? 0,
    pendingLinks: links.results?.[0] ?? { total: 0, count: 0 },
    discounts: discounts.results?.[0] ?? { total: 0, count: 0 },
    byRecorder: byRecorder.results ?? [],
    byTeacher: assignRows ?? [],
    transactions: transactions.results ?? [],
  });
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
