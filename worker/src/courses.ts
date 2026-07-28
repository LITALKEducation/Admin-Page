// Paid courses (คอร์สเรียน). A course bundles published quizzes/lessons behind
// a one-time Stripe payment. Two faces, like quizzes.ts:
//
//   * Management routes (after verifyAuth) — the admin console authors
//     courses, picks which quizzes they contain, publishes, and reads
//     enrollments. Any staff can author; publishing is admin-only.
//
//   * Portal routes (before verifyAuth) — the student site lists courses,
//     opens a course, and starts a Stripe checkout. Enrollment (written by the
//     checkout webhook) unlocks the course's quizzes; see quizzes.ts, which
//     imports the gating helpers below.
import { Hono } from 'hono';
import type { AppBindings, AuthUser, Env } from './types';
import { isAdmin, requireAdmin, portalTokenMatchesStudent } from './auth';
import { logAudit } from './db';
import { createStripePaymentLink, withPolicyNote } from './stripe';

const MAX_TITLE = 300;
const MAX_TEXT = 2_000;
const MAX_OVERVIEW = 40_000;
const MAX_ITEMS = 100;

interface CourseRow {
  id: number;
  title: string;
  titleTh: string | null;
  description: string | null;
  descriptionTh: string | null;
  overview: string | null;
  overviewTh: string | null;
  category: string | null;
  priceSatang: number;
  currency: string;
  status: string;
  authorIdentity?: string;
  authorName: string | null;
  reviewedBy?: string | null;
  createdAt?: string;
  updatedAt?: string;
  publishedAt: string | null;
}

interface CourseBody {
  title?: string;
  titleTh?: string;
  description?: string;
  descriptionTh?: string;
  overview?: string;
  overviewTh?: string;
  category?: string;
  priceSatang?: number;
  currency?: string;
  quizIds?: number[];
}

const AUTHOR_JOIN = `LEFT JOIN staff st ON st.identity = c.author_identity COLLATE NOCASE`;
const AUTHOR_NAME_FIELD = `COALESCE(st.name, c.author_name) AS authorName`;
const REVIEWER_JOIN = `LEFT JOIN staff rst ON rst.identity = c.reviewed_by COLLATE NOCASE`;
const REVIEWED_BY_FIELD = `COALESCE(rst.name, c.reviewed_by) AS reviewedBy`;

const COURSE_FIELDS = `c.id, c.title, c.title_th AS titleTh, c.description, c.description_th AS descriptionTh,
  c.overview, c.overview_th AS overviewTh, c.category, c.price_satang AS priceSatang, c.currency, c.status,
  c.author_identity AS authorIdentity, ${AUTHOR_NAME_FIELD}, ${REVIEWED_BY_FIELD},
  c.created_at AS createdAt, c.updated_at AS updatedAt, c.published_at AS publishedAt`;

/* ===================== Shared helpers (imported by quizzes.ts) ===================== */

// The id of the course a quiz belongs to, or null if it's a free standalone
// quiz. Used to decide whether a quiz needs enrollment to open.
export async function courseIdForQuiz(db: D1Database, quizId: number): Promise<number | null> {
  const row = await db.prepare(`SELECT course_id AS courseId FROM course_items WHERE quiz_id = ?`).bind(quizId).first<{ courseId: number }>();
  return row?.courseId ?? null;
}

export async function isEnrolled(db: D1Database, courseId: number, studentId: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 AS ok FROM course_enrollments WHERE course_id = ? AND student_id = ? COLLATE NOCASE AND status = 'active'`)
    .bind(courseId, studentId)
    .first<{ ok: number }>();
  return !!row;
}

// True when the student may open this quiz: either it's free (no course) or
// they're enrolled in the course that owns it. Central gate for quizzes.ts.
export async function canAccessQuiz(db: D1Database, quizId: number, studentId: string): Promise<boolean> {
  const courseId = await courseIdForQuiz(db, quizId);
  if (courseId == null) return true;
  return isEnrolled(db, courseId, studentId);
}

// Grant (or re-affirm) enrollment. Idempotent via UNIQUE(course_id, student_id)
// — a redelivered checkout webhook is a harmless no-op. Called from the Stripe
// webhook (recordCheckoutPayment) and from the free-course path below.
export async function grantEnrollment(
  db: D1Database,
  courseId: number,
  studentId: string,
  amount: number,
  stripeSessionId: string | null,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO course_enrollments (course_id, student_id, amount, stripe_session_id, status)
       VALUES (?, ?, ?, ?, 'active')
       ON CONFLICT(course_id, student_id) DO UPDATE SET status = 'active'`,
    )
    .bind(courseId, studentId, amount, stripeSessionId)
    .run();
}

/* ===================== internal helpers ===================== */

function canEdit(user: AuthUser, course: { authorIdentity?: string }): boolean {
  return isAdmin(user) || (course.authorIdentity ?? '').toLowerCase() === user.email.toLowerCase();
}

function validateCourse(body: CourseBody): string | null {
  if (!body.title?.trim() && !body.titleTh?.trim()) return 'กรุณากรอกชื่อคอร์ส';
  if ((body.title ?? '').length > MAX_TITLE || (body.titleTh ?? '').length > MAX_TITLE) return 'ชื่อยาวเกินไป';
  if ((body.description ?? '').length > MAX_TEXT || (body.descriptionTh ?? '').length > MAX_TEXT) return 'คำอธิบายยาวเกินไป';
  if ((body.overview ?? '').length > MAX_OVERVIEW || (body.overviewTh ?? '').length > MAX_OVERVIEW) return 'เนื้อหายาวเกินไป';
  if (body.priceSatang != null && (!Number.isInteger(body.priceSatang) || body.priceSatang < 0 || body.priceSatang > 100_000_000))
    return 'ราคาไม่ถูกต้อง';
  return null;
}

// Replace a course's quiz set. Only quizzes not already claimed by another
// course may be attached (UNIQUE(quiz_id) enforces it too, but we filter here
// for a clean error rather than a constraint failure).
async function replaceItems(db: D1Database, courseId: number, quizIds: number[]): Promise<string | null> {
  const ids = [...new Set(quizIds.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0))];
  if (ids.length > MAX_ITEMS) return 'บทเรียนในคอร์สมากเกินไป';
  const stmts: D1PreparedStatement[] = [db.prepare(`DELETE FROM course_items WHERE course_id = ?`).bind(courseId)];
  ids.forEach((quizId, i) => {
    stmts.push(
      db
        .prepare(`INSERT OR IGNORE INTO course_items (course_id, quiz_id, position) VALUES (?, ?, ?)`)
        .bind(courseId, quizId, i),
    );
  });
  await db.batch(stmts);
  return null;
}

/* ===================== Management routes (after verifyAuth) ===================== */

const courses = new Hono<AppBindings>();

courses.get('/courses', async (c) => {
  const user = c.get('user');
  const base = `SELECT ${COURSE_FIELDS},
      (SELECT COUNT(*) FROM course_items ci WHERE ci.course_id = c.id) AS itemCount,
      (SELECT COUNT(*) FROM course_enrollments ce WHERE ce.course_id = c.id AND ce.status = 'active') AS enrollCount
    FROM courses c ${AUTHOR_JOIN} ${REVIEWER_JOIN}`;
  const stmt = isAdmin(user)
    ? c.env.DB.prepare(`${base} ORDER BY c.id DESC`)
    : c.env.DB.prepare(`${base} WHERE c.author_identity = ? COLLATE NOCASE ORDER BY c.id DESC`).bind(user.email);
  const { results } = await stmt.all();
  return c.json({ status: 'success', isAdmin: isAdmin(user), courses: results ?? [] });
});

// Full course with its quiz ids (staff view).
courses.get('/courses/:id', async (c) => {
  const user = c.get('user');
  const id = Number(c.req.param('id'));
  const course = await c.env.DB.prepare(`SELECT ${COURSE_FIELDS} FROM courses c ${AUTHOR_JOIN} ${REVIEWER_JOIN} WHERE c.id = ?`)
    .bind(id)
    .first<CourseRow>();
  if (!course) return c.json({ error: 'ไม่พบคอร์ส' }, 404);
  if (!canEdit(user, course)) return c.json({ error: 'Forbidden' }, 403);
  const { results } = await c.env.DB.prepare(
    `SELECT ci.quiz_id AS quizId, q.title, q.title_th AS titleTh FROM course_items ci
     JOIN quizzes q ON q.id = ci.quiz_id WHERE ci.course_id = ? ORDER BY ci.position, ci.id`,
  )
    .bind(id)
    .all();
  return c.json({ status: 'success', course, items: results ?? [] });
});

// Quizzes that can be added to a course: published, and not already owned by a
// different course. Feeds the course editor's picker.
courses.get('/courses/:id/available-quizzes', async (c) => {
  const id = Number(c.req.param('id'));
  const { results } = await c.env.DB.prepare(
    `SELECT q.id, q.title, q.title_th AS titleTh, q.status,
            (SELECT ci.course_id FROM course_items ci WHERE ci.quiz_id = q.id) AS courseId
     FROM quizzes q
     WHERE q.status = 'published'
       AND ( (SELECT ci.course_id FROM course_items ci WHERE ci.quiz_id = q.id) IS NULL
             OR (SELECT ci.course_id FROM course_items ci WHERE ci.quiz_id = q.id) = ? )
     ORDER BY q.id DESC LIMIT 500`,
  )
    .bind(id)
    .all();
  return c.json({ status: 'success', quizzes: results ?? [] });
});

courses.post('/courses', async (c) => {
  const user = c.get('user');
  const body = await c.req.json<CourseBody>().catch(() => ({}) as CourseBody);
  const invalid = validateCourse(body);
  if (invalid) return c.json({ error: invalid }, 400);

  const result = await c.env.DB.prepare(
    `INSERT INTO courses
       (title, title_th, description, description_th, overview, overview_th, category,
        price_satang, currency, status, author_identity, author_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
  )
    .bind(
      (body.title || body.titleTh)!.trim(),
      body.titleTh?.trim() || null,
      body.description?.trim() || null,
      body.descriptionTh?.trim() || null,
      body.overview ?? null,
      body.overviewTh ?? null,
      body.category?.trim() || null,
      Math.max(0, Math.round(body.priceSatang ?? 0)),
      (body.currency || 'thb').toLowerCase(),
      user.email,
      user.name || user.email,
    )
    .run();
  const id = Number(result.meta.last_row_id);
  if (Array.isArray(body.quizIds)) {
    const err = await replaceItems(c.env.DB, id, body.quizIds);
    if (err) {
      await c.env.DB.prepare(`DELETE FROM courses WHERE id = ?`).bind(id).run();
      return c.json({ error: err }, 400);
    }
  }
  await logAudit(c.env.DB, user, 'COURSE_CREATE', null, String(id), true);
  return c.json({ ok: true, id });
});

courses.patch('/courses/:id', async (c) => {
  const user = c.get('user');
  const id = Number(c.req.param('id'));
  const course = await c.env.DB.prepare(`SELECT id, author_identity AS authorIdentity FROM courses WHERE id = ?`)
    .bind(id)
    .first<{ id: number; authorIdentity: string }>();
  if (!course) return c.json({ error: 'ไม่พบคอร์ส' }, 404);
  if (!canEdit(user, course)) return c.json({ error: 'Forbidden' }, 403);

  const body = await c.req.json<CourseBody>().catch(() => ({}) as CourseBody);
  const invalid = validateCourse(body);
  if (invalid) return c.json({ error: invalid }, 400);

  if (Array.isArray(body.quizIds)) {
    const err = await replaceItems(c.env.DB, id, body.quizIds);
    if (err) return c.json({ error: err }, 400);
  }
  await c.env.DB.prepare(
    `UPDATE courses SET title = ?, title_th = ?, description = ?, description_th = ?, overview = ?, overview_th = ?,
       category = ?, price_satang = ?, currency = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
  )
    .bind(
      (body.title || body.titleTh)!.trim(),
      body.titleTh?.trim() || null,
      body.description?.trim() || null,
      body.descriptionTh?.trim() || null,
      body.overview ?? null,
      body.overviewTh ?? null,
      body.category?.trim() || null,
      Math.max(0, Math.round(body.priceSatang ?? 0)),
      (body.currency || 'thb').toLowerCase(),
      id,
    )
    .run();
  await logAudit(c.env.DB, user, 'COURSE_EDIT', null, String(id), true);
  return c.json({ ok: true });
});

courses.post('/courses/:id/status', requireAdmin, async (c) => {
  const user = c.get('user');
  const id = Number(c.req.param('id'));
  const body = await c.req.json<{ status?: string }>().catch(() => ({}) as never);
  if (!['draft', 'published', 'archived'].includes(body.status ?? '')) return c.json({ error: 'สถานะไม่ถูกต้อง' }, 400);
  const course = await c.env.DB.prepare(`SELECT id FROM courses WHERE id = ?`).bind(id).first();
  if (!course) return c.json({ error: 'ไม่พบคอร์ส' }, 404);
  await c.env.DB.prepare(
    `UPDATE courses SET status = ?, reviewed_by = ?,
       published_at = CASE WHEN ? = 'published' AND published_at IS NULL THEN CURRENT_TIMESTAMP ELSE published_at END,
       updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
  )
    .bind(body.status, user.email, body.status, id)
    .run();
  await logAudit(c.env.DB, user, `COURSE_${body.status!.toUpperCase()}`, null, String(id), true);
  return c.json({ ok: true });
});

courses.delete('/courses/:id', async (c) => {
  const user = c.get('user');
  const id = Number(c.req.param('id'));
  const course = await c.env.DB.prepare(`SELECT id, author_identity AS authorIdentity FROM courses WHERE id = ?`)
    .bind(id)
    .first<{ id: number; authorIdentity: string }>();
  if (!course) return c.json({ error: 'ไม่พบคอร์ส' }, 404);
  if (!canEdit(user, course)) return c.json({ error: 'Forbidden' }, 403);
  // Explicit child deletes — D1 doesn't enforce ON DELETE CASCADE.
  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM course_items WHERE course_id = ?`).bind(id),
    c.env.DB.prepare(`DELETE FROM course_enrollments WHERE course_id = ?`).bind(id),
    c.env.DB.prepare(`DELETE FROM courses WHERE id = ?`).bind(id),
  ]);
  await logAudit(c.env.DB, user, 'COURSE_DELETE', null, String(id), true);
  return c.json({ ok: true });
});

// Who's enrolled (paid) — author or admin.
courses.get('/courses/:id/enrollments', async (c) => {
  const user = c.get('user');
  const id = Number(c.req.param('id'));
  const course = await c.env.DB.prepare(`SELECT id, author_identity AS authorIdentity FROM courses WHERE id = ?`)
    .bind(id)
    .first<{ id: number; authorIdentity: string }>();
  if (!course) return c.json({ error: 'ไม่พบคอร์ส' }, 404);
  if (!canEdit(user, course)) return c.json({ error: 'Forbidden' }, 403);
  const { results } = await c.env.DB.prepare(
    `SELECT ce.id, ce.student_id AS studentId, s.name AS studentName, s.nickname AS studentNickname,
            ce.amount, ce.status, ce.enrolled_at AS enrolledAt
     FROM course_enrollments ce LEFT JOIN students s ON s.id = ce.student_id COLLATE NOCASE
     WHERE ce.course_id = ? ORDER BY ce.enrolled_at DESC LIMIT 1000`,
  )
    .bind(id)
    .all();
  return c.json({ status: 'success', enrollments: results ?? [] });
});

/* ===================== Portal routes (before verifyAuth) ===================== */

export const coursesPortal = new Hono<AppBindings>();

// Published courses with this student's enrollment + price.
coursesPortal.get('/portal/:studentId/courses', async (c) => {
  const studentId = c.req.param('studentId');
  if (!(await portalTokenMatchesStudent(c, studentId))) return c.json({ status: 'error', message: 'Unauthorized' }, 401);
  const { results } = await c.env.DB.prepare(
    `SELECT c.id, c.title, c.title_th AS titleTh, c.description, c.description_th AS descriptionTh,
            c.category, c.price_satang AS priceSatang, c.currency, c.published_at AS publishedAt,
            (SELECT COUNT(*) FROM course_items ci WHERE ci.course_id = c.id) AS itemCount,
            (SELECT COUNT(*) FROM course_enrollments ce WHERE ce.course_id = c.id AND ce.student_id = ? COLLATE NOCASE AND ce.status = 'active') AS enrolled
     FROM courses c WHERE c.status = 'published' ORDER BY c.published_at DESC, c.id DESC LIMIT 200`,
  )
    .bind(studentId)
    .all();
  return c.json({ status: 'success', courses: results ?? [] });
});

// A course's public detail. The overview is always shown; the quiz list is
// returned either way, but the student can only open a quiz once enrolled
// (enforced again in quizzes.ts when they try to load it).
coursesPortal.get('/portal/:studentId/courses/:courseId', async (c) => {
  const studentId = c.req.param('studentId');
  const courseId = Number(c.req.param('courseId'));
  if (!(await portalTokenMatchesStudent(c, studentId))) return c.json({ status: 'error', message: 'Unauthorized' }, 401);
  const course = await c.env.DB.prepare(
    `SELECT id, title, title_th AS titleTh, description, description_th AS descriptionTh,
            overview, overview_th AS overviewTh, category, price_satang AS priceSatang, currency
     FROM courses WHERE id = ? AND status = 'published'`,
  )
    .bind(courseId)
    .first<CourseRow>();
  if (!course) return c.json({ status: 'error', message: 'ไม่พบคอร์ส' }, 404);
  const enrolled = await isEnrolled(c.env.DB, courseId, studentId);
  const { results } = await c.env.DB.prepare(
    `SELECT q.id, q.title, q.title_th AS titleTh, q.description, q.description_th AS descriptionTh,
            (SELECT COUNT(*) FROM quiz_questions qq WHERE qq.quiz_id = q.id) AS questionCount,
            (q.lesson IS NOT NULL AND q.lesson != '') AS hasLesson,
            (SELECT MAX(qa.passed) FROM quiz_attempts qa WHERE qa.quiz_id = q.id AND qa.student_id = ? COLLATE NOCASE) AS passed
     FROM course_items ci JOIN quizzes q ON q.id = ci.quiz_id
     WHERE ci.course_id = ? ORDER BY ci.position, ci.id`,
  )
    .bind(studentId, courseId)
    .all();
  return c.json({ status: 'success', course, enrolled, items: results ?? [] });
});

// Start a purchase. Free courses enroll immediately; paid courses return a
// Stripe checkout URL whose webhook grants enrollment on payment.
coursesPortal.post('/portal/:studentId/courses/:courseId/checkout', async (c) => {
  const studentId = c.req.param('studentId');
  const courseId = Number(c.req.param('courseId'));
  if (!(await portalTokenMatchesStudent(c, studentId))) return c.json({ status: 'error', message: 'Unauthorized' }, 401);

  const course = await c.env.DB.prepare(
    `SELECT id, title, title_th AS titleTh, price_satang AS priceSatang, currency FROM courses WHERE id = ? AND status = 'published'`,
  )
    .bind(courseId)
    .first<{ id: number; title: string; titleTh: string | null; priceSatang: number; currency: string }>();
  if (!course) return c.json({ status: 'error', message: 'ไม่พบคอร์ส' }, 404);

  if (await isEnrolled(c.env.DB, courseId, studentId)) {
    return c.json({ status: 'success', enrolled: true });
  }

  // Free course — grant straight away, no Stripe round-trip.
  if (!course.priceSatang || course.priceSatang <= 0) {
    await grantEnrollment(c.env.DB, courseId, studentId, 0, null);
    await logAudit(c.env.DB, null, 'COURSE_ENROLL_FREE', studentId, String(courseId), true);
    return c.json({ status: 'success', enrolled: true });
  }

  if (!c.env.STRIPE_SECRET_KEY) return c.json({ status: 'error', message: 'ระบบชำระเงินยังไม่พร้อมใช้งาน' }, 503);

  const returnUrl = validatedReturnUrl(c.env, await c.req.json<{ returnUrl?: string }>().catch(() => ({})));
  const name = course.titleTh || course.title;
  try {
    const link = await createStripePaymentLink(c.env.STRIPE_SECRET_KEY, {
      productName: name,
      productDescription: withPolicyNote(`คอร์สเรียน: ${name}`),
      amountSatang: course.priceSatang,
      currency: (course.currency || 'thb').toLowerCase(),
      metadata: { type: 'course', course_id: String(courseId), student_id: studentId },
      afterCompletionUrl: returnUrl,
    });
    await logAudit(c.env.DB, null, 'COURSE_CHECKOUT', studentId, String(courseId), true);
    return c.json({ status: 'success', url: link.url });
  } catch (err) {
    console.error('course checkout failed', err);
    return c.json({ status: 'error', message: 'สร้างลิงก์ชำระเงินไม่สำเร็จ' }, 502);
  }
});

// Only allow a redirect back to one of our own origins (prevents open
// redirect through the Stripe after_completion URL). Falls back to the first
// allowed origin's /learn page.
function validatedReturnUrl(env: Env, body: { returnUrl?: string }): string {
  const allowed = env.ALLOWED_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean);
  const fallback = `${allowed[0] || 'https://litalkeducation.com'}/learn?paid=1`;
  const candidate = body.returnUrl;
  if (!candidate) return fallback;
  try {
    const url = new URL(candidate);
    if (allowed.some((o) => candidate.startsWith(o)) && url.protocol === 'https:') return candidate;
  } catch {
    /* not a URL */
  }
  return fallback;
}

export default courses;
