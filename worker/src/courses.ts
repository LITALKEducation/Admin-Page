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
import { logAudit, extname } from './db';
import { createStripePaymentLink, withPolicyNote } from './stripe';

const MAX_TITLE = 300;
const MAX_TEXT = 2_000;
const MAX_OVERVIEW = 40_000;
const MAX_ITEMS = 100;
const MAX_COVER_BYTES = 4 * 1024 * 1024; // 4 MB

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
  discountSatang: number | null;
  includedInPlus?: number;
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
  discountSatang?: number | null;
  includedInPlus?: number | boolean;
  currency?: string;
  // Each item is a quiz plus its role in the course path.
  items?: { quizId: number; kind?: string }[];
}

// The price a student actually pays: the discount when one is set and lower
// than the list price, otherwise the list price. Mirrors the SQL EFFECTIVE_PRICE
// expression so the server charges what the catalogue advertises.
function effectivePriceSatang(priceSatang: number, discountSatang: number | null | undefined): number {
  const price = Math.max(0, Math.round(priceSatang || 0));
  if (discountSatang == null) return price;
  const disc = Math.round(discountSatang);
  return disc >= 0 && disc < price ? disc : price;
}

// Coerce an incoming discount to what we store: NULL when omitted/blank,
// otherwise a clamped integer satang. Zero is kept (an on-sale-for-free deal).
function normalizeDiscount(discountSatang: number | null | undefined): number | null {
  if (discountSatang == null) return null;
  return Math.min(100_000_000, Math.max(0, Math.round(discountSatang)));
}

const ITEM_KINDS = new Set(['pretest', 'lesson', 'posttest']);

const AUTHOR_JOIN = `LEFT JOIN staff st ON st.identity = c.author_identity COLLATE NOCASE`;
const AUTHOR_NAME_FIELD = `COALESCE(st.name, c.author_name) AS authorName`;
const REVIEWER_JOIN = `LEFT JOIN staff rst ON rst.identity = c.reviewed_by COLLATE NOCASE`;
const REVIEWED_BY_FIELD = `COALESCE(rst.name, c.reviewed_by) AS reviewedBy`;

const COURSE_FIELDS = `c.id, c.title, c.title_th AS titleTh, c.description, c.description_th AS descriptionTh,
  c.overview, c.overview_th AS overviewTh, c.category, c.price_satang AS priceSatang,
  c.discount_satang AS discountSatang, c.included_in_plus AS includedInPlus, c.currency, c.status,
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

// One course item joined with this student's progress on its quiz.
interface ProgressRow {
  quizId: number;
  kind: string;
  position: number;
  title: string;
  titleTh: string | null;
  description: string | null;
  descriptionTh: string | null;
  videoUrl: string | null;
  passScore: number;
  questionCount: number;
  hasLesson: number;
  attempts: number;
  passed: number | null;
  bestScore: number | null;
  bestPercent: number | null;
}

// All of a course's items with the caller's attempt/pass state, in order.
export async function loadItemsWithProgress(db: D1Database, courseId: number, studentId: string): Promise<ProgressRow[]> {
  const { results } = await db
    .prepare(
      `SELECT ci.quiz_id AS quizId, ci.kind AS kind, ci.position AS position,
              q.title, q.title_th AS titleTh, q.description, q.description_th AS descriptionTh,
              q.video_url AS videoUrl, q.pass_score AS passScore,
              (SELECT COUNT(*) FROM quiz_questions qq WHERE qq.quiz_id = q.id) AS questionCount,
              (q.lesson IS NOT NULL AND q.lesson != '') AS hasLesson,
              (SELECT COUNT(*) FROM quiz_attempts qa WHERE qa.quiz_id = q.id AND qa.student_id = ? COLLATE NOCASE) AS attempts,
              (SELECT MAX(qa.passed) FROM quiz_attempts qa WHERE qa.quiz_id = q.id AND qa.student_id = ? COLLATE NOCASE) AS passed,
              (SELECT MAX(qa.score) FROM quiz_attempts qa WHERE qa.quiz_id = q.id AND qa.student_id = ? COLLATE NOCASE) AS bestScore,
              (SELECT MAX(CASE WHEN qa.max_score > 0 THEN CAST(qa.score AS REAL) * 100.0 / qa.max_score ELSE NULL END)
                 FROM quiz_attempts qa WHERE qa.quiz_id = q.id AND qa.student_id = ? COLLATE NOCASE) AS bestPercent
       FROM course_items ci JOIN quizzes q ON q.id = ci.quiz_id
       WHERE ci.course_id = ? ORDER BY ci.position, ci.id`,
    )
    .bind(studentId, studentId, studentId, studentId, courseId)
    .all<ProgressRow>();
  return results ?? [];
}

// Whether a course item counts as "done" for progress/to-do — lessons need a
// pass (or an attempt when they carry no pass mark), pretest/posttest just an
// attempt. Exported for the on-demand dashboard.
export function computeItemDone(r: ProgressRow): boolean {
  return r.kind === 'lesson' ? lessonDone(r) : attempted(r);
}

// "Attempted" is enough for a pretest/posttest (and for a quiz with no
// questions, which can never be submitted — treat it as satisfied so it can't
// dead-end the sequence).
function attempted(r: ProgressRow): boolean {
  return (r.questionCount ?? 0) === 0 || (r.attempts ?? 0) > 0;
}

// A lesson is "done" once passed — or, when it carries no pass mark (or no
// questions at all), once any attempt has been submitted.
function lessonDone(r: ProgressRow): boolean {
  if ((r.questionCount ?? 0) === 0) return true;
  if ((r.attempts ?? 0) === 0) return false;
  return r.passed === 1 || (r.passScore ?? 0) === 0;
}

export interface CourseGate {
  allowed: boolean;
  courseId?: number;
  reason?: 'enroll' | 'pretest' | 'lessons';
  message?: string;
}

// The single sequencing gate quizzes.ts consults before letting a student open
// or submit a course quiz: enrollment first, then Pretest → Lessons → Posttest.
export async function courseGateForQuiz(db: D1Database, quizId: number, studentId: string): Promise<CourseGate> {
  const item = await db
    .prepare(`SELECT course_id AS courseId, kind FROM course_items WHERE quiz_id = ?`)
    .bind(quizId)
    .first<{ courseId: number; kind: string }>();
  if (!item) return { allowed: true }; // free standalone quiz

  const courseId = item.courseId;
  if (!(await isEnrolled(db, courseId, studentId))) {
    return { allowed: false, courseId, reason: 'enroll', message: 'ต้องลงทะเบียนคอร์สนี้ก่อนจึงจะเข้าเรียนได้' };
  }
  if (item.kind === 'pretest') return { allowed: true, courseId };

  const progress = await loadItemsWithProgress(db, courseId, studentId);
  const pretest = progress.find((p) => p.kind === 'pretest');
  const pretestDone = !pretest || attempted(pretest);
  if (!pretestDone) {
    return { allowed: false, courseId, reason: 'pretest', message: 'กรุณาทำแบบทดสอบก่อนเรียน (Pretest) ก่อน' };
  }
  if (item.kind === 'lesson') return { allowed: true, courseId };

  // posttest — needs every lesson completed.
  const lessons = progress.filter((p) => p.kind === 'lesson');
  if (!lessons.every(lessonDone)) {
    return { allowed: false, courseId, reason: 'lessons', message: 'กรุณาเรียนและผ่านทุกบทเรียนก่อนทำ Posttest' };
  }
  return { allowed: true, courseId };
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
  if (
    body.discountSatang != null &&
    (!Number.isInteger(body.discountSatang) || body.discountSatang < 0 || body.discountSatang > 100_000_000)
  )
    return 'ราคาโปรโมชันไม่ถูกต้อง';
  return null;
}

// Replace a course's item set (quiz + role). Dedupes quizzes, clamps to at
// most one pretest and one posttest (extras fall back to 'lesson'), and stores
// them in the given order. UNIQUE(quiz_id) also guards a quiz being in two
// courses at once.
async function replaceItems(db: D1Database, courseId: number, items: { quizId: number; kind?: string }[]): Promise<string | null> {
  const seen = new Set<number>();
  const clean: { quizId: number; kind: string }[] = [];
  let hasPretest = false;
  let hasPosttest = false;
  for (const it of items) {
    const quizId = Number(it.quizId);
    if (!Number.isInteger(quizId) || quizId <= 0 || seen.has(quizId)) continue;
    let kind = ITEM_KINDS.has(it.kind ?? '') ? (it.kind as string) : 'lesson';
    if (kind === 'pretest' && hasPretest) kind = 'lesson';
    if (kind === 'posttest' && hasPosttest) kind = 'lesson';
    if (kind === 'pretest') hasPretest = true;
    if (kind === 'posttest') hasPosttest = true;
    seen.add(quizId);
    clean.push({ quizId, kind });
  }
  if (clean.length > MAX_ITEMS) return 'บทเรียนในคอร์สมากเกินไป';
  const stmts: D1PreparedStatement[] = [db.prepare(`DELETE FROM course_items WHERE course_id = ?`).bind(courseId)];
  clean.forEach((it, i) => {
    stmts.push(
      db
        .prepare(`INSERT OR IGNORE INTO course_items (course_id, quiz_id, position, kind) VALUES (?, ?, ?, ?)`)
        .bind(courseId, it.quizId, i, it.kind),
    );
  });
  await db.batch(stmts);
  return null;
}

/* ===================== Management routes (after verifyAuth) ===================== */

const courses = new Hono<AppBindings>();

courses.get('/courses', async (c) => {
  const user = c.get('user');
  const base = `SELECT ${COURSE_FIELDS}, (c.cover_key IS NOT NULL) AS hasCover,
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
  const course = await c.env.DB.prepare(`SELECT ${COURSE_FIELDS}, (c.cover_key IS NOT NULL) AS hasCover FROM courses c ${AUTHOR_JOIN} ${REVIEWER_JOIN} WHERE c.id = ?`)
    .bind(id)
    .first<CourseRow>();
  if (!course) return c.json({ error: 'ไม่พบคอร์ส' }, 404);
  if (!canEdit(user, course)) return c.json({ error: 'Forbidden' }, 403);
  const { results } = await c.env.DB.prepare(
    `SELECT ci.quiz_id AS quizId, ci.kind AS kind, q.title, q.title_th AS titleTh FROM course_items ci
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
        price_satang, discount_satang, included_in_plus, currency, status, author_identity, author_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
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
      normalizeDiscount(body.discountSatang),
      body.includedInPlus ? 1 : 0,
      (body.currency || 'thb').toLowerCase(),
      user.email,
      user.name || user.email,
    )
    .run();
  const id = Number(result.meta.last_row_id);
  if (Array.isArray(body.items)) {
    const err = await replaceItems(c.env.DB, id, body.items);
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

  if (Array.isArray(body.items)) {
    const err = await replaceItems(c.env.DB, id, body.items);
    if (err) return c.json({ error: err }, 400);
  }
  await c.env.DB.prepare(
    `UPDATE courses SET title = ?, title_th = ?, description = ?, description_th = ?, overview = ?, overview_th = ?,
       category = ?, price_satang = ?, discount_satang = ?, included_in_plus = ?, currency = ?,
       updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
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
      normalizeDiscount(body.discountSatang),
      body.includedInPlus ? 1 : 0,
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

// System-wide list of course enrollees (registrants). Admin sees every
// enrollment; other staff see enrollees of the courses they authored.
courses.get('/enrollments', async (c) => {
  const user = c.get('user');
  const admin = isAdmin(user);
  const base = `SELECT ce.id, ce.student_id AS studentId, s.name AS studentName, s.nickname AS studentNickname,
       s.email AS studentEmail, s.account_type AS accountType,
       ce.course_id AS courseId, c.title AS courseTitle, c.title_th AS courseTitleTh,
       ce.amount, ce.status, ce.enrolled_at AS enrolledAt
     FROM course_enrollments ce
     JOIN courses c ON c.id = ce.course_id
     LEFT JOIN students s ON s.id = ce.student_id COLLATE NOCASE
     WHERE ce.status = 'active'`;
  const stmt = admin
    ? c.env.DB.prepare(`${base} ORDER BY ce.enrolled_at DESC, ce.id DESC LIMIT 2000`)
    : c.env.DB.prepare(`${base} AND c.author_identity = ? COLLATE NOCASE ORDER BY ce.enrolled_at DESC, ce.id DESC LIMIT 2000`).bind(user.email);
  const { results } = await stmt.all();
  return c.json({ status: 'success', enrollments: results ?? [] });
});

// Upload / replace a course cover image (multipart form, field "file").
courses.post('/courses/:id/cover', async (c) => {
  const user = c.get('user');
  const id = Number(c.req.param('id'));
  const course = await c.env.DB.prepare(`SELECT cover_key AS coverKey, author_identity AS authorIdentity FROM courses WHERE id = ?`)
    .bind(id)
    .first<{ coverKey: string | null; authorIdentity: string }>();
  if (!course) return c.json({ error: 'ไม่พบคอร์ส' }, 404);
  if (!canEdit(user, course)) return c.json({ error: 'Forbidden' }, 403);

  const form = await c.req.formData();
  const file = form.get('file') as unknown as File | string | null;
  if (typeof file === 'string' || file === null) return c.json({ error: 'ไม่พบไฟล์' }, 400);
  if (!file.type.startsWith('image/')) return c.json({ error: 'ไฟล์ต้องเป็นรูปภาพ' }, 400);
  if (file.size > MAX_COVER_BYTES) return c.json({ error: 'รูปภาพใหญ่เกินไป (สูงสุด 4 MB)' }, 400);

  const bytes = new Uint8Array(await file.arrayBuffer());
  const key = `course/covers/${id}-${crypto.randomUUID().slice(0, 8)}${extname(file.name) || '.jpg'}`;
  await c.env.BUCKET.put(key, bytes, { httpMetadata: { contentType: file.type } });
  await c.env.DB.prepare(`UPDATE courses SET cover_key = ?, cover_mime = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .bind(key, file.type, id)
    .run();
  if (course.coverKey) await c.env.BUCKET.delete(course.coverKey).catch(() => {});
  await logAudit(c.env.DB, user, 'COURSE_COVER', null, String(id), true);
  return c.json({ ok: true });
});

// Serve the current cover to the editor regardless of publish status.
courses.get('/courses/:id/cover', async (c) => {
  const user = c.get('user');
  const id = Number(c.req.param('id'));
  const course = await c.env.DB.prepare(
    `SELECT cover_key AS coverKey, cover_mime AS coverMime, author_identity AS authorIdentity FROM courses WHERE id = ?`,
  )
    .bind(id)
    .first<{ coverKey: string | null; coverMime: string | null; authorIdentity: string }>();
  if (!course) return c.json({ error: 'ไม่พบคอร์ส' }, 404);
  if (!canEdit(user, course)) return c.json({ error: 'Forbidden' }, 403);
  if (!course.coverKey) return c.json({ error: 'No cover' }, 404);
  const object = await c.env.BUCKET.get(course.coverKey);
  if (!object) return c.json({ error: 'Not found' }, 404);
  return new Response(object.body, {
    headers: {
      'Content-Type': course.coverMime || object.httpMetadata?.contentType || 'image/jpeg',
      'Cache-Control': 'private, no-store',
    },
  });
});

/* ===================== Public routes (before verifyAuth, no login) ===================== */
// Powers the public on-demand course catalogue on the marketing site
// (litalkeducation.com/courses) — promotion + syllabus, no student data. Same
// shape idea as blogPublic.
export const coursesPublic = new Hono<AppBindings>();

coursesPublic.get('/courses/public', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT c.id, c.title, c.title_th AS titleTh, c.description, c.description_th AS descriptionTh,
            c.category, c.price_satang AS priceSatang, c.discount_satang AS discountSatang,
            c.included_in_plus AS includedInPlus, c.currency, c.published_at AS publishedAt,
            (c.cover_key IS NOT NULL) AS hasCover,
            (SELECT COUNT(*) FROM course_items ci WHERE ci.course_id = c.id) AS itemCount
     FROM courses c WHERE c.status = 'published'
     ORDER BY (c.discount_satang IS NOT NULL AND c.discount_satang < c.price_satang) DESC,
              c.published_at DESC, c.id DESC LIMIT 200`,
  ).all();
  return c.json({ status: 'success', courses: results ?? [] });
});

// Serve a published course's cover image (public, cacheable).
coursesPublic.get('/courses/public/:id/cover', async (c) => {
  const id = Number(c.req.param('id'));
  const row = await c.env.DB.prepare(
    `SELECT cover_key AS coverKey, cover_mime AS coverMime FROM courses WHERE id = ? AND status = 'published'`,
  )
    .bind(id)
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

coursesPublic.get('/courses/public/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const course = await c.env.DB.prepare(
    `SELECT id, title, title_th AS titleTh, description, description_th AS descriptionTh,
            overview, overview_th AS overviewTh, category, price_satang AS priceSatang,
            discount_satang AS discountSatang, included_in_plus AS includedInPlus, currency,
            (cover_key IS NOT NULL) AS hasCover
     FROM courses WHERE id = ? AND status = 'published'`,
  )
    .bind(id)
    .first<CourseRow>();
  if (!course) return c.json({ status: 'error', message: 'Not found' }, 404);
  // Syllabus for the promo page — titles only, no questions/answers.
  const { results } = await c.env.DB.prepare(
    `SELECT q.title, q.title_th AS titleTh, ci.kind AS kind,
            (SELECT COUNT(*) FROM quiz_questions qq WHERE qq.quiz_id = q.id) AS questionCount,
            (q.video_url IS NOT NULL AND q.video_url != '') AS hasVideo
     FROM course_items ci JOIN quizzes q ON q.id = ci.quiz_id
     WHERE ci.course_id = ? ORDER BY ci.position, ci.id`,
  )
    .bind(id)
    .all();
  return c.json({ status: 'success', course, items: results ?? [] });
});

/* ===================== Portal routes (before verifyAuth) ===================== */

export const coursesPortal = new Hono<AppBindings>();

// Published courses with this student's enrollment + price.
coursesPortal.get('/portal/:studentId/courses', async (c) => {
  const studentId = c.req.param('studentId');
  if (!(await portalTokenMatchesStudent(c, studentId))) return c.json({ status: 'error', message: 'Unauthorized' }, 401);
  const { results } = await c.env.DB.prepare(
    `SELECT c.id, c.title, c.title_th AS titleTh, c.description, c.description_th AS descriptionTh,
            c.category, c.price_satang AS priceSatang, c.discount_satang AS discountSatang,
            c.included_in_plus AS includedInPlus, c.currency, c.published_at AS publishedAt,
            (c.cover_key IS NOT NULL) AS hasCover,
            (SELECT COUNT(*) FROM course_items ci WHERE ci.course_id = c.id) AS itemCount,
            (SELECT COUNT(*) FROM course_enrollments ce WHERE ce.course_id = c.id AND ce.student_id = ? COLLATE NOCASE AND ce.status = 'active') AS enrolled
     FROM courses c WHERE c.status = 'published'
     ORDER BY (c.discount_satang IS NOT NULL AND c.discount_satang < c.price_satang) DESC,
              c.published_at DESC, c.id DESC LIMIT 200`,
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
            overview, overview_th AS overviewTh, category, price_satang AS priceSatang,
            discount_satang AS discountSatang, included_in_plus AS includedInPlus, currency,
            (cover_key IS NOT NULL) AS hasCover
     FROM courses WHERE id = ? AND status = 'published'`,
  )
    .bind(courseId)
    .first<CourseRow>();
  if (!course) return c.json({ status: 'error', message: 'ไม่พบคอร์ส' }, 404);
  const enrolled = await isEnrolled(c.env.DB, courseId, studentId);

  const progress = await loadItemsWithProgress(c.env.DB, courseId, studentId);
  const pretestRow = progress.find((p) => p.kind === 'pretest') ?? null;
  const lessonRows = progress.filter((p) => p.kind === 'lesson');
  const posttestRow = progress.find((p) => p.kind === 'posttest') ?? null;

  const pretestDone = !pretestRow || attempted(pretestRow);
  const lessonsAllDone = lessonRows.length === 0 || lessonRows.every(lessonDone);

  // Shape one item for the portal, with its done/locked state resolved so the
  // client just renders — the same rules the access gate enforces.
  const toItem = (p: ProgressRow, locked: boolean) => ({
    id: p.quizId,
    title: p.title,
    titleTh: p.titleTh,
    description: p.description,
    descriptionTh: p.descriptionTh,
    questionCount: p.questionCount,
    hasLesson: p.hasLesson,
    hasVideo: p.videoUrl ? 1 : 0,
    attempts: p.attempts,
    passed: p.passed === 1 ? 1 : 0,
    bestScore: p.bestScore,
    done: p.kind === 'lesson' ? lessonDone(p) : (p.attempts ?? 0) > 0,
    locked,
  });

  return c.json({
    status: 'success',
    course,
    enrolled,
    gates: { pretestDone, lessonsAllDone, hasPretest: !!pretestRow, hasPosttest: !!posttestRow },
    pretest: pretestRow ? toItem(pretestRow, false) : null,
    lessons: lessonRows.map((p) => toItem(p, !pretestDone)),
    posttest: posttestRow ? toItem(posttestRow, !(pretestDone && lessonsAllDone)) : null,
  });
});

// Start a purchase. Free courses enroll immediately; paid courses return a
// Stripe checkout URL whose webhook grants enrollment on payment.
coursesPortal.post('/portal/:studentId/courses/:courseId/checkout', async (c) => {
  const studentId = c.req.param('studentId');
  const courseId = Number(c.req.param('courseId'));
  if (!(await portalTokenMatchesStudent(c, studentId))) return c.json({ status: 'error', message: 'Unauthorized' }, 401);

  const course = await c.env.DB.prepare(
    `SELECT id, title, title_th AS titleTh, price_satang AS priceSatang, discount_satang AS discountSatang, currency
       FROM courses WHERE id = ? AND status = 'published'`,
  )
    .bind(courseId)
    .first<{ id: number; title: string; titleTh: string | null; priceSatang: number; discountSatang: number | null; currency: string }>();
  if (!course) return c.json({ status: 'error', message: 'ไม่พบคอร์ส' }, 404);

  if (await isEnrolled(c.env.DB, courseId, studentId)) {
    return c.json({ status: 'success', enrolled: true });
  }

  // Charge the effective price — the promo price when the course is on sale.
  const chargeSatang = effectivePriceSatang(course.priceSatang, course.discountSatang);

  // Free course (or on sale for free) — grant straight away, no Stripe round-trip.
  if (chargeSatang <= 0) {
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
      amountSatang: chargeSatang,
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

/* ===================== On-demand student dashboard ===================== */
// Everything the on-demand portal (study.html) needs in one call: the
// learner's profile, progress on each enrolled course, an aggregated to-do
// list, completed courses, receipts, and a couple of recommended courses.
coursesPortal.get('/portal/:studentId/dashboard', async (c) => {
  const studentId = c.req.param('studentId');
  if (!(await portalTokenMatchesStudent(c, studentId))) return c.json({ status: 'error', message: 'Unauthorized' }, 401);

  const student = await c.env.DB.prepare(
    `SELECT id, name, email, avatar_key AS avatarKey, account_type AS accountType FROM students WHERE id = ? COLLATE NOCASE AND deleted_at IS NULL`,
  )
    .bind(studentId)
    .first<{ id: string; name: string; email: string | null; avatarKey: string | null; accountType: string }>();
  if (!student) return c.json({ status: 'error', message: 'ไม่พบบัญชี' }, 404);

  // Enrolled courses (include archived so a bought course still appears).
  const { results: enrRows } = await c.env.DB.prepare(
    `SELECT ce.course_id AS courseId, ce.amount, ce.stripe_session_id AS stripeSessionId, ce.enrolled_at AS enrolledAt,
            c.title, c.title_th AS titleTh, c.price_satang AS priceSatang,
            p.paid_date AS paidDate, p.proof_url AS receiptUrl
     FROM course_enrollments ce
     JOIN courses c ON c.id = ce.course_id
     LEFT JOIN payments p ON p.stripe_session_id = ce.stripe_session_id
     WHERE ce.student_id = ? COLLATE NOCASE AND ce.status = 'active'
     ORDER BY ce.enrolled_at DESC`,
  )
    .bind(studentId)
    .all<{
      courseId: number; amount: number; stripeSessionId: string | null; enrolledAt: string;
      title: string; titleTh: string | null; priceSatang: number; paidDate: string | null; receiptUrl: string | null;
    }>();
  const enrollments = enrRows ?? [];

  const enrolled: unknown[] = [];
  const completed: unknown[] = [];
  const todo: unknown[] = [];

  for (const e of enrollments) {
    const items = await loadItemsWithProgress(c.env.DB, e.courseId, studentId);
    const pretest = items.find((p) => p.kind === 'pretest');
    const lessons = items.filter((p) => p.kind === 'lesson');
    const pretestDone = !pretest || computeItemDone(pretest);
    const lessonsAllDone = lessons.length === 0 || lessons.every(computeItemDone);

    let done = 0;
    const percents: number[] = [];
    for (const it of items) {
      const isDone = computeItemDone(it);
      if (isDone) done += 1;
      if ((it.questionCount ?? 0) > 0 && it.bestPercent != null) percents.push(it.bestPercent);
      if (!isDone) {
        const locked =
          it.kind === 'lesson' ? !pretestDone : it.kind === 'posttest' ? !(pretestDone && lessonsAllDone) : false;
        todo.push({
          courseId: e.courseId,
          courseTitle: e.titleTh || e.title,
          quizId: it.quizId,
          title: e.titleTh ? it.titleTh || it.title : it.title,
          kind: it.kind,
          hasVideo: it.videoUrl ? 1 : 0,
          reason: (it.attempts ?? 0) === 0 ? 'not_started' : 'not_passed',
          locked,
        });
      }
    }
    const total = items.length;
    const avgScore = percents.length ? Math.round(percents.reduce((a, b) => a + b, 0) / percents.length) : null;
    const card = {
      courseId: e.courseId,
      title: e.titleTh || e.title,
      total,
      done,
      progressPct: total ? Math.round((done / total) * 100) : 0,
      avgScore,
      enrolledAt: e.enrolledAt,
    };
    enrolled.push(card);
    if (total > 0 && done === total) completed.push(card);
  }

  const enrolledIds = enrollments.map((e) => e.courseId);
  // Omit the exclusion entirely when there's nothing enrolled yet, so a brand
  // new learner still gets recommendations (id NOT IN (NULL) matches nothing).
  const notEnrolled = enrolledIds.length ? `AND id NOT IN (${enrolledIds.map(() => '?').join(',')})` : '';
  const { results: recRows } = await c.env.DB.prepare(
    `SELECT id, title, title_th AS titleTh, description, description_th AS descriptionTh,
            category, price_satang AS priceSatang, discount_satang AS discountSatang,
            included_in_plus AS includedInPlus,
            (SELECT COUNT(*) FROM course_items ci WHERE ci.course_id = courses.id) AS itemCount
     FROM courses
     WHERE status = 'published' ${notEnrolled}
     ORDER BY (discount_satang IS NOT NULL AND discount_satang < price_satang) DESC,
              published_at DESC, id DESC LIMIT 2`,
  )
    .bind(...enrolledIds)
    .all();

  const receipts = enrollments.map((e) => ({
    courseId: e.courseId,
    title: e.titleTh || e.title,
    amount: e.amount,
    paidDate: e.paidDate || e.enrolledAt,
    receiptUrl: e.receiptUrl,
    free: (e.amount ?? 0) <= 0,
  }));

  return c.json({
    status: 'success',
    student: { id: student.id, name: student.name, email: student.email, hasAvatar: !!student.avatarKey, accountType: student.accountType },
    enrolled,
    completed,
    todo,
    recommended: recRows ?? [],
    receipts,
  });
});

export default courses;
