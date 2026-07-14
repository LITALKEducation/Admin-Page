import { Hono } from 'hono';
import type { AppBindings } from './types';
import { requirePermission, requireAdmin, isAdmin } from './auth';
import { logAudit } from './db';
import { createStripePaymentLink, deactivateStripePaymentLink, listActivePromotionCodes, StripeError, withPolicyNote, withPrefilledPromoCode } from './stripe';
import { createStudentAuth0User } from './auth0mgmt';
import { bangkokToday, bangkokMonth, daysAgo, isYmd } from './dates';
import { visibleStudentIds, canSeeStudent, activateApprovedSchedulesForStudent, activateAwaitingAmendmentsForStudent } from './manage';
import { createMeetEvent, deleteMeetEvent } from './googlemeet';
import { mintPaymentShortLink } from './shortlinks';

export { bangkokToday, bangkokMonth } from './dates';

const core = new Hono<AppBindings>();

// ===== Students =====

core.get('/students', requirePermission('data:read'), async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, name, nickname, email, phone, course FROM students WHERE deleted_at IS NULL ORDER BY name`,
  ).all<{ id: string }>();
  // Teachers with admin-assigned students only see those students.
  const visible = await visibleStudentIds(c.env.DB, c.get('user'));
  const rows = visible === null ? results : (results ?? []).filter((s) => visible.has(s.id));
  return c.json(rows);
});

// Admin-only: teachers cannot create student accounts.
core.post('/students', requireAdmin, async (c) => {
  const body = await c.req.json<{ name?: string; nickname?: string; email?: string; phone?: string; course?: string }>();
  if (!body.name || typeof body.name !== 'string') return c.json({ error: 'Missing name' }, 400);
  if (!body.course || typeof body.course !== 'string') return c.json({ error: 'Missing course' }, 400);

  const user = c.get('user');
  // Ids follow the existing sheet convention (e.g. litalk10387): lowercase,
  // since they double as the Auth0 login email's local part. Retry on the
  // rare collision.
  for (let attempt = 0; attempt < 20; attempt++) {
    const id = 'litalk' + String(Math.floor(10000 + Math.random() * 90000));
    try {
      await c.env.DB.prepare(
        `INSERT INTO students (id, name, nickname, email, phone, course, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(id, body.name, body.nickname ?? null, body.email ?? null, body.phone ?? null, body.course, user.email)
        .run();
      await logAudit(c.env.DB, user, 'CREATE_STUDENT', id, null, true);

      // Auto-create the student's Auth0 login (parity with the old GAS flow).
      let message = `สร้างบัญชีนักเรียนสำเร็จ (รหัส ${id})`;
      if (c.env.AUTH0_MGMT_CLIENT_ID && c.env.AUTH0_MGMT_CLIENT_SECRET) {
        try {
          const creds = await createStudentAuth0User(c.env, id, body.name);
          await c.env.DB.prepare(`UPDATE students SET auth0_user_id = ? WHERE id = ?`).bind(creds.userId, id).run();
          message += ` — บัญชีเข้าสู่ระบบ: ${creds.email} รหัสผ่านชั่วคราว: ${creds.password}`;
        } catch (err) {
          message += ` — แต่สร้างบัญชีเข้าสู่ระบบไม่สำเร็จ (${err instanceof Error ? err.message : 'Auth0 error'}) กรุณาสร้างใน Auth0 เอง`;
        }
      }
      return c.json({ ok: true, id, message });
    } catch (err) {
      if (String(err).includes('UNIQUE')) continue;
      throw err;
    }
  }
  return c.json({ error: 'Could not generate a unique student id' }, 500);
});

// ===== Study logs =====

core.post('/study-logs', requirePermission('data:write'), async (c) => {
  const body = await c.req.json<{ studentId?: string; date?: string; feedback?: string; video?: string }>();
  if (!body.studentId) return c.json({ error: 'Missing studentId' }, 400);
  if (!body.feedback) return c.json({ error: 'Missing feedback' }, 400);
  const logDate = isYmd(body.date) ? body.date : bangkokToday();

  const user = c.get('user');
  const visible = await visibleStudentIds(c.env.DB, user);
  if (!canSeeStudent(visible, body.studentId)) return c.json({ error: 'Forbidden' }, 403);
  await c.env.DB.prepare(
    `INSERT INTO study_logs (student_id, log_date, feedback, video_url, created_by) VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(body.studentId, logDate, body.feedback, body.video ?? null, user.email)
    .run();
  await logAudit(c.env.DB, user, 'ADD_STUDY_LOG', body.studentId, null, true);
  return c.json({ ok: true, message: 'บันทึกการเรียนสำเร็จ' });
});

// List a student's study logs (for viewing / picking one to edit).
core.get('/students/:id/study-logs', requirePermission('data:read'), async (c) => {
  const studentId = c.req.param('id');
  if (!studentId) return c.json({ error: 'Missing student id' }, 400);
  const visible = await visibleStudentIds(c.env.DB, c.get('user'));
  if (!canSeeStudent(visible, studentId)) return c.json({ error: 'Forbidden' }, 403);
  const { results } = await c.env.DB.prepare(
    `SELECT id, log_date AS date, feedback, video_url AS video, created_by AS createdBy, created_at AS createdAt
     FROM study_logs WHERE student_id = ? ORDER BY log_date DESC, id DESC LIMIT 100`,
  )
    .bind(studentId)
    .all();
  return c.json(results ?? []);
});

// Edit an existing study log (teachers may edit logs of students they can see).
core.patch('/study-logs/:id', requirePermission('data:write'), async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.json<{ date?: string; feedback?: string; video?: string }>();
  if (!body.feedback || typeof body.feedback !== 'string') return c.json({ error: 'Missing feedback' }, 400);

  const log = await c.env.DB.prepare(`SELECT student_id AS studentId FROM study_logs WHERE id = ?`)
    .bind(id)
    .first<{ studentId: string }>();
  if (!log) return c.json({ error: 'ไม่พบบันทึกการเรียน' }, 404);

  const user = c.get('user');
  const visible = await visibleStudentIds(c.env.DB, user);
  if (!canSeeStudent(visible, log.studentId)) return c.json({ error: 'Forbidden' }, 403);

  const logDate = isYmd(body.date) ? body.date : undefined;
  await c.env.DB.prepare(
    `UPDATE study_logs SET feedback = ?, video_url = ?, log_date = COALESCE(?, log_date) WHERE id = ?`,
  )
    .bind(body.feedback, body.video ?? null, logDate ?? null, id)
    .run();
  await logAudit(c.env.DB, user, 'EDIT_STUDY_LOG', log.studentId, String(id), true);
  return c.json({ ok: true, message: 'แก้ไขบันทึกการเรียนสำเร็จ' });
});

// ===== Payments (manual record) =====

core.post('/payments', requirePermission('data:write'), async (c) => {
  const body = await c.req.json<{ studentId?: string; total?: number | string; method?: string; date?: string; proof?: string }>();
  const amount = Number(body.total);
  if (!body.studentId) return c.json({ error: 'Missing studentId' }, 400);
  if (!Number.isFinite(amount) || amount <= 0) return c.json({ error: 'Invalid amount' }, 400);
  const paidDate = isYmd(body.date) ? body.date : bangkokToday();

  const user = c.get('user');
  const visible = await visibleStudentIds(c.env.DB, user);
  if (!canSeeStudent(visible, body.studentId)) return c.json({ error: 'Forbidden' }, 403);

  await c.env.DB.prepare(
    `INSERT INTO payments (student_id, amount, method, paid_date, proof_url, source, recorded_by)
     VALUES (?, ?, ?, ?, ?, 'manual', ?)`,
  )
    .bind(body.studentId, amount, body.method ?? null, paidDate, body.proof ?? null, user.email)
    .run();
  await logAudit(c.env.DB, user, 'ADD_PAYMENT', body.studentId, null, true);

  // A successful payment starts the student's approved monthly schedule (or
  // add-hours request) immediately (sessions become bookings).
  const activated = await activateApprovedSchedulesForStudent(c.env.DB, c.env, body.studentId);
  const amendmentsActivated = await activateAwaitingAmendmentsForStudent(c.env.DB, c.env, body.studentId);
  let message = 'บันทึกการชำระเงินสำเร็จ';
  if (activated > 0) message += ' — ตารางเรียนที่อนุมัติไว้เริ่มทำงานแล้ว';
  if (amendmentsActivated > 0) message += ' — เพิ่มคาบเรียนตามคำร้องเรียบร้อยแล้ว';
  return c.json({ ok: true, message });
});

// Admin-only: correct a recorded payment's amount / method / date.
core.patch('/payments/:id', requireAdmin, async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.json<{ total?: number | string; method?: string; date?: string }>();
  const amount = Number(body.total);
  if (!Number.isFinite(amount) || amount <= 0) return c.json({ error: 'Invalid amount' }, 400);

  const existing = await c.env.DB.prepare(`SELECT id, student_id AS studentId FROM payments WHERE id = ?`)
    .bind(id)
    .first<{ id: number; studentId: string | null }>();
  if (!existing) return c.json({ error: 'ไม่พบรายการชำระเงิน' }, 404);

  const paidDate = isYmd(body.date) ? body.date : undefined;
  await c.env.DB.prepare(
    `UPDATE payments SET amount = ?, method = COALESCE(?, method), paid_date = COALESCE(?, paid_date) WHERE id = ?`,
  )
    .bind(amount, body.method ?? null, paidDate ?? null, id)
    .run();
  await logAudit(c.env.DB, c.get('user'), 'EDIT_PAYMENT', existing.studentId, String(id), true);
  return c.json({ ok: true, message: 'แก้ไขรายการชำระเงินสำเร็จ' });
});

// ===== Bookings =====

core.post('/bookings', requirePermission('data:write'), async (c) => {
  const body = await c.req.json<{ studentId?: string; bookingDate?: string; bookingTime?: string; notes?: string }>();
  if (!body.studentId) return c.json({ error: 'Missing studentId' }, 400);
  if (!isYmd(body.bookingDate)) return c.json({ error: 'Invalid bookingDate' }, 400);
  if (typeof body.bookingTime !== 'string' || !/^\d{2}:\d{2}$/.test(body.bookingTime)) {
    return c.json({ error: 'Invalid bookingTime' }, 400);
  }

  const user = c.get('user');
  const visible = await visibleStudentIds(c.env.DB, user);
  if (!canSeeStudent(visible, body.studentId)) return c.json({ error: 'Forbidden' }, 403);

  const taken = await c.env.DB.prepare(
    `SELECT 1 FROM bookings WHERE booking_date = ? AND booking_time = ? AND status = 'booked'`,
  )
    .bind(body.bookingDate, body.bookingTime)
    .first();
  if (taken) return c.json({ error: 'ช่วงเวลานี้ถูกจองแล้ว กรุณาเลือกเวลาอื่น' }, 409);

  const student = await c.env.DB.prepare(`SELECT name, course FROM students WHERE id = ?`)
    .bind(body.studentId)
    .first<{ name: string; course: string | null }>();
  const meet = await createMeetEvent(c.env, {
    studentName: student?.name ?? body.studentId,
    course: student?.course,
    date: body.bookingDate!,
    time: body.bookingTime!,
  });

  try {
    await c.env.DB.prepare(
      `INSERT INTO bookings (student_id, booking_date, booking_time, notes, created_by, meet_link, calendar_event_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(body.studentId, body.bookingDate, body.bookingTime, body.notes ?? null, user.email, meet?.meetLink ?? null, meet?.eventId ?? null)
      .run();
  } catch (err) {
    if (String(err).includes('UNIQUE')) {
      return c.json({ error: 'ช่วงเวลานี้ถูกจองแล้ว กรุณาเลือกเวลาอื่น' }, 409);
    }
    throw err;
  }
  await logAudit(c.env.DB, user, 'CREATE_BOOKING', body.studentId, null, true);
  let message = `จองเวลาเรียนวันที่ ${body.bookingDate} เวลา ${body.bookingTime} สำเร็จ`;
  if (meet?.meetLink) message += ' — สร้างลิงก์ Google Meet ให้แล้ว';
  return c.json({ ok: true, message, meetLink: meet?.meetLink ?? null });
});

// A booking may only be edited/cancelled by whoever created it, or by an
// admin — everyone else's rows are read-only (requested "ลบของตนเองได้,
// ของผู้อื่นแก้ไม่ได้ ยกเว้นแอดมิน"). Returns the row when allowed, else the
// HTTP response to short-circuit with.
async function loadOwnedBooking(c: import('hono').Context<AppBindings>, id: number) {
  if (!Number.isFinite(id)) return { error: c.json({ error: 'Invalid booking id' }, 400) };
  const booking = await c.env.DB.prepare(
    `SELECT id, student_id AS studentId, booking_date AS date, booking_time AS time,
            created_by AS createdBy, calendar_event_id AS calendarEventId, status
     FROM bookings WHERE id = ?`,
  )
    .bind(id)
    .first<{ id: number; studentId: string; date: string; time: string; createdBy: string | null; calendarEventId: string | null; status: string }>();
  if (!booking) return { error: c.json({ error: 'ไม่พบรายการจองนี้' }, 404) };

  const user = c.get('user');
  const owns = !!booking.createdBy && booking.createdBy.toLowerCase() === user.email.toLowerCase();
  if (!owns && !isAdmin(user)) {
    await logAudit(c.env.DB, user, 'FORBIDDEN:BOOKING_OWNER', booking.studentId, String(id), false);
    return { error: c.json({ error: 'แก้ไขได้เฉพาะรายการที่คุณสร้างเอง (หรือแอดมิน)' }, 403) };
  }
  return { booking };
}

// Set/replace a booking's meeting link by hand (Google Meet, Zoom, Teams, …).
// Any http(s) URL is accepted; an empty value clears it.
core.patch('/bookings/:id', requirePermission('data:write'), async (c) => {
  const id = Number(c.req.param('id'));
  const { booking, error } = await loadOwnedBooking(c, id);
  if (error) return error;

  const body = await c.req.json<{ meetLink?: string | null }>();
  const raw = (body.meetLink ?? '').trim();
  if (raw && !/^https?:\/\/\S+$/i.test(raw)) {
    return c.json({ error: 'ลิงก์ต้องขึ้นต้นด้วย http:// หรือ https://' }, 400);
  }
  const meetLink = raw || null;

  const user = c.get('user');
  await c.env.DB.prepare(`UPDATE bookings SET meet_link = ? WHERE id = ?`).bind(meetLink, id).run();
  await logAudit(c.env.DB, user, 'EDIT_BOOKING_LINK', booking!.studentId, String(id), true);
  return c.json({ ok: true, meetLink, message: meetLink ? 'บันทึกลิงก์เรียนแล้ว' : 'ลบลิงก์เรียนแล้ว' });
});

// Cancel a booking (parity with the withdraw flow: status -> 'cancelled', so
// it drops off the student's schedule) and tear down its Google Calendar/Meet
// event. History is kept rather than hard-deleted.
core.delete('/bookings/:id', requirePermission('data:write'), async (c) => {
  const id = Number(c.req.param('id'));
  const { booking, error } = await loadOwnedBooking(c, id);
  if (error) return error;

  const user = c.get('user');
  await c.env.DB.prepare(`UPDATE bookings SET status = 'cancelled' WHERE id = ?`).bind(id).run();
  // Best-effort: a failed calendar cleanup shouldn't block the cancellation.
  await deleteMeetEvent(c.env, booking!.calendarEventId).catch(() => {});
  await logAudit(c.env.DB, user, 'CANCEL_BOOKING', booking!.studentId, String(id), true);
  return c.json({ ok: true, message: `ยกเลิกคลาสวันที่ ${booking!.date} เวลา ${booking!.time} แล้ว` });
});

// ===== Dashboard =====

core.get('/dashboard', requirePermission('data:read'), async (c) => {
  const range = c.req.query('range') ?? 'today';
  const today = bangkokToday();
  const month = bangkokMonth();
  const year = today.slice(0, 4);
  const start =
    range === 'week' ? daysAgo(6) : range === 'month' ? `${month}-01` : range === 'year' ? `${year}-01-01` : today;
  const revenueLabel =
    range === 'week'
      ? 'รายรับ 7 วันล่าสุด'
      : range === 'month'
        ? 'รายรับเดือนนี้'
        : range === 'year'
          ? 'รายรับปีนี้'
          : 'รายรับวันนี้';

  // This week's teaching schedule (Mon–Sun containing today), for the
  // teacher weekly-summary card.
  const dow = new Date(today + 'T00:00:00Z').getUTCDay(); // 0=Sun
  const mondayOffset = (dow + 6) % 7;
  const weekStart = daysAgo(mondayOffset);
  const weekEnd = new Date(new Date(weekStart + 'T00:00:00Z').getTime() + 6 * 86400_000).toISOString().slice(0, 10);

  const [classes, booked, revenue, unpaidRows, todayClasses, recentPayments, weekRows] = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM study_logs WHERE log_date BETWEEN ? AND ?`).bind(start, today),
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM bookings WHERE booking_date >= ? AND status = 'booked'`).bind(today),
    c.env.DB.prepare(`SELECT COALESCE(SUM(amount), 0) AS n FROM payments WHERE paid_date BETWEEN ? AND ?`).bind(start, today),
    // "Unpaid" = studied this month but no payment recorded this month.
    c.env.DB.prepare(
      `SELECT DISTINCT l.student_id AS id, COALESCE(s.name, l.student_id) AS name
       FROM study_logs l LEFT JOIN students s ON s.id = l.student_id
       WHERE l.log_date LIKE ? || '%'
         AND l.student_id NOT IN (SELECT student_id FROM payments WHERE student_id IS NOT NULL AND paid_date LIKE ? || '%')
       LIMIT 20`,
    ).bind(month, month),
    c.env.DB.prepare(
      `SELECT b.booking_time AS time, COALESCE(s.name, b.student_id) AS name, s.course AS course, b.student_id AS studentId,
              b.meet_link AS meetLink,
              EXISTS(SELECT 1 FROM study_logs l WHERE l.student_id = b.student_id AND l.log_date = ?) AS done
       FROM bookings b LEFT JOIN students s ON s.id = b.student_id
       WHERE b.booking_date = ? AND b.status = 'booked'
       ORDER BY b.booking_time`,
    ).bind(today, today),
    c.env.DB.prepare(
      `SELECT COALESCE(s.name, pl.customer_name, p.student_id, 'ลูกค้า') AS name, p.method AS method,
              p.paid_date AS dateYMD, p.amount AS total, p.student_id AS studentId
       FROM payments p
       LEFT JOIN students s ON s.id = p.student_id
       LEFT JOIN payment_links pl ON pl.stripe_payment_link_id = p.stripe_payment_link_id
       ORDER BY p.paid_date DESC, p.id DESC LIMIT 5`,
    ),
    c.env.DB.prepare(
      `SELECT b.booking_date AS date, b.booking_time AS time, COALESCE(s.name, b.student_id) AS name,
              s.course AS course, b.student_id AS studentId
       FROM bookings b LEFT JOIN students s ON s.id = b.student_id
       WHERE b.booking_date BETWEEN ? AND ? AND b.status = 'booked'
       ORDER BY b.booking_date, b.booking_time`,
    ).bind(weekStart, weekEnd),
  ]);

  // Restricted teachers only see their assigned students in the per-student
  // lists (the headline counters stay school-wide).
  const visible = await visibleStudentIds(c.env.DB, c.get('user'));
  const unpaid = ((unpaidRows.results ?? []) as Array<{ id: string; name: string }>).filter((u) => canSeeStudent(visible, u.id));
  const todayRows = ((todayClasses.results ?? []) as Array<{ studentId: string }>).filter((r) => canSeeStudent(visible, r.studentId));
  const recentRows = ((recentPayments.results ?? []) as Array<{ studentId: string | null }>).filter(
    (r) => visible === null || (r.studentId !== null && visible.has(r.studentId)),
  );
  const weekClasses = ((weekRows.results ?? []) as Array<{ studentId: string }>).filter((r) => canSeeStudent(visible, r.studentId));
  return c.json({
    stats: {
      classes: (classes.results?.[0] as { n: number }).n,
      booked: (booked.results?.[0] as { n: number }).n,
      revenue: (revenue.results?.[0] as { n: number }).n,
      revenueLabel,
      unpaid: unpaid.length,
    },
    todayClasses: todayRows,
    weekClasses,
    weekStart,
    weekEnd,
    alerts: unpaid.slice(0, 5).map((u) => ({
      type: 'unpaid',
      studentId: u.id,
      text: `${u.name} ยังไม่มีการบันทึกชำระเงินในเดือนนี้`,
      actionLabel: 'บันทึกการชำระเงิน',
      screen: 'payments',
    })),
    recentPayments: recentRows,
  });
});

// ===== Monthly earnings ("what will I get this month") =====

core.get('/earnings', requirePermission('data:read'), async (c) => {
  const month = c.req.query('month') && /^\d{4}-\d{2}$/.test(c.req.query('month')!) ? c.req.query('month')! : bangkokMonth();
  const user = c.get('user');
  const visible = await visibleStudentIds(c.env.DB, user);

  // Teachers see ONLY the combined income of their assigned students — not
  // the school-wide total or the per-user breakdown.
  if (visible !== null) {
    const ids = [...visible];
    let assignedTotal = 0;
    let assignedCount = 0;
    if (ids.length) {
      const row = await c.env.DB.prepare(
        `SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count FROM payments
         WHERE paid_date LIKE ? || '%' AND student_id IN (${ids.map(() => '?').join(',')})`,
      )
        .bind(month, ...ids)
        .first<{ total: number; count: number }>();
      assignedTotal = row?.total ?? 0;
      assignedCount = row?.count ?? 0;
    }
    const mineRow = await c.env.DB.prepare(
      `SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count FROM payments WHERE paid_date LIKE ? || '%' AND recorded_by = ? COLLATE NOCASE`,
    )
      .bind(month, user.email)
      .first<{ total: number; count: number }>();
    return c.json({
      restricted: true,
      month,
      assigned: { total: assignedTotal, count: assignedCount },
      studentCount: ids.length,
      mine: { total: mineRow?.total ?? 0, count: mineRow?.count ?? 0 },
    });
  }

  const [totals, byUser, bySource, pending] = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count FROM payments WHERE paid_date LIKE ? || '%'`).bind(month),
    c.env.DB.prepare(
      `SELECT COALESCE(recorded_by, '-') AS email, COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
       FROM payments WHERE paid_date LIKE ? || '%' GROUP BY recorded_by ORDER BY total DESC`,
    ).bind(month),
    c.env.DB.prepare(
      `SELECT source, COALESCE(SUM(amount), 0) AS total FROM payments WHERE paid_date LIKE ? || '%' GROUP BY source`,
    ).bind(month),
    c.env.DB.prepare(`SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count FROM payment_links WHERE status = 'active'`),
  ]);

  const byUserRows = (byUser.results ?? []) as Array<{ email: string; total: number; count: number }>;
  const sourceRows = (bySource.results ?? []) as Array<{ source: string; total: number }>;
  const mine = byUserRows.find((r) => r.email === user.email);

  return c.json({
    restricted: false,
    month,
    total: (totals.results?.[0] as { total: number }).total,
    count: (totals.results?.[0] as { count: number }).count,
    manualTotal: sourceRows.find((r) => r.source === 'manual')?.total ?? 0,
    stripeTotal: sourceRows.find((r) => r.source === 'stripe')?.total ?? 0,
    mine: { total: mine?.total ?? 0, count: mine?.count ?? 0 },
    byUser: byUserRows,
    pendingLinks: pending.results?.[0] ?? { total: 0, count: 0 },
  });
});

// ===== Stripe payment links =====

// Lists active Promotion Codes for the "create payment link" form's dropdown.
core.get('/payment-links/promotion-codes', requireAdmin, async (c) => {
  if (!c.env.STRIPE_SECRET_KEY) return c.json({ error: 'Stripe is not configured (missing STRIPE_SECRET_KEY secret)' }, 503);
  try {
    return c.json(await listActivePromotionCodes(c.env.STRIPE_SECRET_KEY));
  } catch (err) {
    if (err instanceof StripeError) return c.json({ error: `Stripe: ${err.message}` }, 502);
    throw err;
  }
});

// Admin-only: teachers cannot bill through Stripe.
core.post('/payment-links', requireAdmin, async (c) => {
  if (!c.env.STRIPE_SECRET_KEY) return c.json({ error: 'Stripe is not configured (missing STRIPE_SECRET_KEY secret)' }, 503);

  const body = await c.req.json<{ studentId?: string; customerName?: string; amount?: number | string; description?: string; promoCode?: string }>();
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) return c.json({ error: 'Invalid amount' }, 400);
  if (!body.studentId && !body.customerName) return c.json({ error: 'Missing studentId or customerName' }, 400);

  let customerName = body.customerName ?? '';
  if (body.studentId) {
    const student = await c.env.DB.prepare(`SELECT name FROM students WHERE id = ? AND deleted_at IS NULL`).bind(body.studentId).first<{ name: string }>();
    if (!student) return c.json({ error: 'Student not found' }, 404);
    customerName = student.name;
  }

  const user = c.get('user');
  const description = body.description?.trim() || `ค่าเรียน LITALK Education - ${customerName}`;
  const promoCode = body.promoCode?.trim() || null;

  let link;
  try {
    link = await createStripePaymentLink(c.env.STRIPE_SECRET_KEY, {
      productName: description,
      productDescription: withPolicyNote(),
      amountSatang: Math.round(amount * 100),
      currency: 'thb',
      metadata: {
        student_id: body.studentId ?? '',
        customer_name: customerName,
        created_by: user.email,
      },
    });
  } catch (err) {
    if (err instanceof StripeError) return c.json({ error: `Stripe: ${err.message}` }, 502);
    throw err;
  }
  const url = withPrefilledPromoCode(link.url, promoCode ?? undefined);
  const shortUrl = await mintPaymentShortLink(c.env.DB, c.env, { target: url, studentId: body.studentId, createdBy: user.email });

  const result = await c.env.DB.prepare(
    `INSERT INTO payment_links (stripe_payment_link_id, url, short_url, student_id, customer_name, description, amount, currency, promo_code, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'thb', ?, ?)`,
  )
    .bind(link.id, url, shortUrl, body.studentId ?? null, customerName, description, amount, promoCode, user.email)
    .run();
  await logAudit(c.env.DB, user, 'CREATE_PAYMENT_LINK', body.studentId ?? null, link.id, true);

  return c.json({ ok: true, id: Number(result.meta.last_row_id), url, shortUrl, paymentLinkId: link.id });
});

core.get('/payment-links', requirePermission('data:read'), async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT pl.id, pl.url, pl.short_url AS shortUrl, pl.student_id AS studentId, pl.customer_name AS customerName, pl.description,
            pl.amount, pl.status, pl.promo_code AS promoCode, pl.discount_amount AS discountAmount,
            pl.created_by AS createdBy, pl.created_at AS createdAt
     FROM payment_links pl ORDER BY pl.id DESC LIMIT 30`,
  ).all();
  return c.json(results);
});

core.post('/payment-links/:id/deactivate', requirePermission('data:write'), async (c) => {
  if (!c.env.STRIPE_SECRET_KEY) return c.json({ error: 'Stripe is not configured (missing STRIPE_SECRET_KEY secret)' }, 503);
  const id = c.req.param('id');
  const row = await c.env.DB.prepare(`SELECT stripe_payment_link_id AS plId, status FROM payment_links WHERE id = ?`)
    .bind(id)
    .first<{ plId: string; status: string }>();
  if (!row) return c.json({ error: 'Not found' }, 404);
  if (row.status !== 'active') return c.json({ error: 'Link is not active' }, 400);

  try {
    await deactivateStripePaymentLink(c.env.STRIPE_SECRET_KEY, row.plId);
  } catch (err) {
    if (err instanceof StripeError) return c.json({ error: `Stripe: ${err.message}` }, 502);
    throw err;
  }
  await c.env.DB.prepare(`UPDATE payment_links SET status = 'deactivated' WHERE id = ?`).bind(id).run();
  await logAudit(c.env.DB, c.get('user'), 'DEACTIVATE_PAYMENT_LINK', null, row.plId, true);
  return c.json({ ok: true });
});

// ===== One-time import from the old Google Sheet =====
// Accepts JSON arrays exported from the Sheet (see worker/README.md).
// Students upsert by id; the other tables plain-insert, so run it once.

core.post('/import', requirePermission('data:write'), async (c) => {
  const body = await c.req.json<{
    students?: Array<{ id: string; name: string; nickname?: string; email?: string; phone?: string; course?: string }>;
    studyLogs?: Array<{ studentId: string; date: string; feedback?: string; video?: string }>;
    payments?: Array<{ studentId?: string; total: number; method?: string; date: string; proof?: string }>;
    bookings?: Array<{ studentId: string; date: string; time: string; notes?: string }>;
  }>();

  const user = c.get('user');
  const stmts: D1PreparedStatement[] = [];

  for (const s of body.students ?? []) {
    if (!s.id || !s.name) continue;
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO students (id, name, nickname, email, phone, course, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, nickname = excluded.nickname, email = excluded.email,
           phone = excluded.phone, course = excluded.course`,
      ).bind(s.id, s.name, s.nickname ?? null, s.email ?? null, s.phone ?? null, s.course ?? null, user.email),
    );
  }
  for (const l of body.studyLogs ?? []) {
    if (!l.studentId || !isYmd(l.date)) continue;
    stmts.push(
      c.env.DB.prepare(`INSERT INTO study_logs (student_id, log_date, feedback, video_url, created_by) VALUES (?, ?, ?, ?, ?)`)
        .bind(l.studentId, l.date, l.feedback ?? null, l.video ?? null, user.email),
    );
  }
  for (const p of body.payments ?? []) {
    const amount = Number(p.total);
    if (!Number.isFinite(amount) || amount <= 0 || !isYmd(p.date)) continue;
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO payments (student_id, amount, method, paid_date, proof_url, source, recorded_by) VALUES (?, ?, ?, ?, ?, 'manual', ?)`,
      ).bind(p.studentId ?? null, amount, p.method ?? null, p.date, p.proof ?? null, user.email),
    );
  }
  for (const b of body.bookings ?? []) {
    if (!b.studentId || !isYmd(b.date) || typeof b.time !== 'string') continue;
    stmts.push(
      c.env.DB.prepare(
        `INSERT OR IGNORE INTO bookings (student_id, booking_date, booking_time, notes, created_by) VALUES (?, ?, ?, ?, ?)`,
      ).bind(b.studentId, b.date, b.time, b.notes ?? null, user.email),
    );
  }

  if (stmts.length > 5000) return c.json({ error: 'Too many rows in one request (max 5000); split the import' }, 400);
  if (stmts.length > 0) await c.env.DB.batch(stmts);
  await logAudit(c.env.DB, user, 'IMPORT', null, `${stmts.length} rows`, true);
  return c.json({ ok: true, imported: stmts.length });
});

export default core;
