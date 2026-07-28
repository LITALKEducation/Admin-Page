// Online learning & testing system (ระบบทดสอบและเรียนออนไลน์).
//
// A quiz couples an optional Markdown lesson (the "learn" half) with a set of
// auto-graded questions (the "test" half). This module has two faces:
//
//   * Management routes (mounted AFTER verifyAuth in index.ts) — the admin
//     console uses these to author quizzes, edit questions, publish, and read
//     student results. Any staff account can author; publishing is admin-only,
//     matching the blog editorial model (see blog.ts).
//
//   * Portal routes (mounted BEFORE verifyAuth, like blogPublic) — the student
//     site uses these to list published quizzes, open one to study/take, and
//     submit an attempt that the Worker grades. Every portal route proves the
//     caller owns the student id with portalTokenMatchesStudent, exactly like
//     the rest of /portal/*.
import { Hono } from 'hono';
import type { AppBindings, AuthUser } from './types';
import { isAdmin, requireAdmin, portalTokenMatchesStudent } from './auth';
import { logAudit } from './db';
import { courseGateForQuiz } from './courses';

const MAX_TITLE = 300;
const MAX_TEXT = 2_000;
const MAX_LESSON = 60_000;
const MAX_PROMPT = 4_000;
const MAX_QUESTIONS = 100;
const MAX_OPTIONS = 10;
const QUESTION_TYPES = new Set(['single', 'multiple', 'truefalse', 'short']);

/* ===================== Types ===================== */

type QuestionType = 'single' | 'multiple' | 'truefalse' | 'short';

interface QuizRow {
  id: number;
  title: string;
  titleTh: string | null;
  description: string | null;
  descriptionTh: string | null;
  lesson: string | null;
  lessonTh: string | null;
  videoUrl: string | null;
  category: string | null;
  status: string;
  timeLimitMin: number | null;
  passScore: number;
  allowRetake: number;
  showAnswers: number;
  authorIdentity?: string;
  authorName: string | null;
  reviewedBy?: string | null;
  createdAt?: string;
  updatedAt?: string;
  publishedAt: string | null;
}

interface QuestionRow {
  id: number;
  quizId?: number;
  position: number;
  type: string;
  prompt: string;
  options: string | null;
  answer: string;
  explanation: string | null;
  points: number;
}

interface QuestionInput {
  type?: string;
  prompt?: string;
  options?: string[];
  answer?: unknown;
  explanation?: string;
  points?: number;
}

interface QuizBody {
  title?: string;
  titleTh?: string;
  description?: string;
  descriptionTh?: string;
  lesson?: string;
  lessonTh?: string;
  videoUrl?: string;
  category?: string;
  timeLimitMin?: number | null;
  passScore?: number;
  allowRetake?: boolean;
  showAnswers?: boolean;
  questions?: QuestionInput[];
}

// The same "prefer the live staff directory name" join the blog uses, so a
// renamed author/reviewer never shows a stale email.
const AUTHOR_JOIN = `LEFT JOIN staff st ON st.identity = q.author_identity COLLATE NOCASE`;
const AUTHOR_NAME_FIELD = `COALESCE(st.name, q.author_name) AS authorName`;
const REVIEWER_JOIN = `LEFT JOIN staff rst ON rst.identity = q.reviewed_by COLLATE NOCASE`;
const REVIEWED_BY_FIELD = `COALESCE(rst.name, q.reviewed_by) AS reviewedBy`;

const QUIZ_FIELDS = `q.id, q.title, q.title_th AS titleTh, q.description, q.description_th AS descriptionTh,
  q.lesson, q.lesson_th AS lessonTh, q.video_url AS videoUrl, q.category, q.status, q.time_limit_min AS timeLimitMin,
  q.pass_score AS passScore, q.allow_retake AS allowRetake, q.show_answers AS showAnswers,
  q.author_identity AS authorIdentity, ${AUTHOR_NAME_FIELD}, ${REVIEWED_BY_FIELD},
  q.created_at AS createdAt, q.updated_at AS updatedAt, q.published_at AS publishedAt`;

/* ===================== Helpers ===================== */

function canEdit(user: AuthUser, quiz: { authorIdentity?: string }): boolean {
  return isAdmin(user) || (quiz.authorIdentity ?? '').toLowerCase() === user.email.toLowerCase();
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

// Validate + normalise one question from the editor into the row shape we
// store. Returns an error string, or the cleaned pieces to bind.
function normaliseQuestion(input: QuestionInput): { error: string } | {
  type: QuestionType;
  prompt: string;
  options: string | null;
  answer: string;
  explanation: string | null;
  points: number;
} {
  const type = (input.type ?? 'single') as QuestionType;
  if (!QUESTION_TYPES.has(type)) return { error: 'ประเภทคำถามไม่ถูกต้อง' };
  const prompt = (input.prompt ?? '').trim();
  if (!prompt) return { error: 'คำถามต้องไม่ว่าง' };
  if (prompt.length > MAX_PROMPT) return { error: 'คำถามยาวเกินไป' };
  const points = Number.isFinite(input.points) ? Math.max(1, Math.min(100, Math.round(input.points as number))) : 1;
  const explanation = (input.explanation ?? '').trim() || null;

  if (type === 'single' || type === 'multiple') {
    const options = (input.options ?? []).map((o) => String(o ?? '').trim()).filter((o) => o.length > 0);
    if (options.length < 2) return { error: 'ต้องมีตัวเลือกอย่างน้อย 2 ข้อ' };
    if (options.length > MAX_OPTIONS) return { error: 'ตัวเลือกมากเกินไป' };
    if (type === 'single') {
      const idx = Number(input.answer);
      if (!Number.isInteger(idx) || idx < 0 || idx >= options.length) return { error: 'กรุณาเลือกคำตอบที่ถูกต้อง' };
      return { type, prompt, options: JSON.stringify(options), answer: JSON.stringify(idx), explanation, points };
    }
    const arr = Array.isArray(input.answer) ? input.answer.map((n) => Number(n)) : [];
    const valid = arr.filter((n) => Number.isInteger(n) && n >= 0 && n < options.length);
    if (valid.length === 0) return { error: 'กรุณาเลือกคำตอบที่ถูกต้องอย่างน้อยหนึ่งข้อ' };
    return {
      type,
      prompt,
      options: JSON.stringify(options),
      answer: JSON.stringify([...new Set(valid)].sort((a, b) => a - b)),
      explanation,
      points,
    };
  }

  if (type === 'truefalse') {
    if (typeof input.answer !== 'boolean') return { error: 'กรุณาเลือกจริงหรือเท็จ' };
    return { type, prompt, options: null, answer: JSON.stringify(input.answer), explanation, points };
  }

  // short answer: one or more accepted strings, matched case-insensitively.
  const accepted = (Array.isArray(input.answer) ? input.answer : [input.answer])
    .map((a) => String(a ?? '').trim())
    .filter((a) => a.length > 0);
  if (accepted.length === 0) return { error: 'กรุณากรอกคำตอบที่ยอมรับได้' };
  return { type, prompt, options: null, answer: JSON.stringify(accepted), explanation, points };
}

// Grade one stored question against the student's submitted answer. Returns
// the points earned (all-or-nothing per question) and whether it was correct.
function gradeQuestion(q: QuestionRow, submitted: unknown): { correct: boolean; earned: number } {
  const wrong = { correct: false, earned: 0 };
  const right = { correct: true, earned: q.points };
  switch (q.type) {
    case 'single': {
      const correctIdx = parseJson<number>(q.answer, -1);
      return Number(submitted) === correctIdx ? right : wrong;
    }
    case 'multiple': {
      const correctSet = parseJson<number[]>(q.answer, []);
      const got = Array.isArray(submitted) ? submitted.map((n) => Number(n)) : [];
      const a = [...new Set(correctSet)].sort((x, y) => x - y);
      const b = [...new Set(got)].sort((x, y) => x - y);
      return a.length === b.length && a.every((v, i) => v === b[i]) ? right : wrong;
    }
    case 'truefalse': {
      const correct = parseJson<boolean>(q.answer, false);
      return submitted === correct ? right : wrong;
    }
    case 'short': {
      const accepted = parseJson<string[]>(q.answer, []).map((s) => s.toLowerCase().trim());
      const given = String(submitted ?? '').toLowerCase().trim();
      return given.length > 0 && accepted.includes(given) ? right : wrong;
    }
    default:
      return wrong;
  }
}

// Replace a quiz's whole question set in one transaction-ish batch. The
// editor always sends the full list, so wiping and re-inserting keeps ids
// off the client and avoids diffing.
async function replaceQuestions(db: D1Database, quizId: number, questions: QuestionInput[]): Promise<string | null> {
  if (questions.length > MAX_QUESTIONS) return 'คำถามมากเกินไป';
  const normalised: ReturnType<typeof normaliseQuestion>[] = [];
  for (const q of questions) {
    const n = normaliseQuestion(q);
    if ('error' in n) return n.error;
    normalised.push(n);
  }
  const stmts: D1PreparedStatement[] = [db.prepare(`DELETE FROM quiz_questions WHERE quiz_id = ?`).bind(quizId)];
  normalised.forEach((n, i) => {
    if ('error' in n) return;
    stmts.push(
      db
        .prepare(
          `INSERT INTO quiz_questions (quiz_id, position, type, prompt, options, answer, explanation, points)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(quizId, i, n.type, n.prompt, n.options, n.answer, n.explanation, n.points),
    );
  });
  await db.batch(stmts);
  return null;
}

function validateQuizBody(body: QuizBody): string | null {
  if (!body.title?.trim()) return 'กรุณากรอกชื่อแบบทดสอบ';
  if (body.title.length > MAX_TITLE || (body.titleTh ?? '').length > MAX_TITLE) return 'ชื่อยาวเกินไป';
  if ((body.description ?? '').length > MAX_TEXT || (body.descriptionTh ?? '').length > MAX_TEXT) return 'คำอธิบายยาวเกินไป';
  if ((body.lesson ?? '').length > MAX_LESSON || (body.lessonTh ?? '').length > MAX_LESSON) return 'บทเรียนยาวเกินไป';
  if ((body.videoUrl ?? '').length > 2_000) return 'ลิงก์วีดีโอยาวเกินไป';
  if (body.passScore != null && (body.passScore < 0 || body.passScore > 100)) return 'เกณฑ์ผ่านต้องอยู่ระหว่าง 0-100';
  if (body.timeLimitMin != null && body.timeLimitMin !== null && (body.timeLimitMin < 0 || body.timeLimitMin > 600)) {
    return 'เวลาจำกัดไม่ถูกต้อง';
  }
  return null;
}

/* ===================== Management routes (after verifyAuth) ===================== */

const quizzes = new Hono<AppBindings>();

// Admins see every quiz; other staff see only their own — same as the blog.
quizzes.get('/quizzes', async (c) => {
  const user = c.get('user');
  const base = `SELECT ${QUIZ_FIELDS},
      (SELECT COUNT(*) FROM quiz_questions qq WHERE qq.quiz_id = q.id) AS questionCount,
      (SELECT COUNT(*) FROM quiz_attempts qa WHERE qa.quiz_id = q.id) AS attemptCount
    FROM quizzes q ${AUTHOR_JOIN} ${REVIEWER_JOIN}`;
  const stmt = isAdmin(user)
    ? c.env.DB.prepare(`${base} ORDER BY q.id DESC`)
    : c.env.DB.prepare(`${base} WHERE q.author_identity = ? COLLATE NOCASE ORDER BY q.id DESC`).bind(user.email);
  const { results } = await stmt.all<QuizRow & { questionCount: number; attemptCount: number }>();
  return c.json({ status: 'success', isAdmin: isAdmin(user), quizzes: results ?? [] });
});

// Full quiz with its questions (answers included — this is the staff view).
quizzes.get('/quizzes/:id', async (c) => {
  const user = c.get('user');
  const id = Number(c.req.param('id'));
  const quiz = await c.env.DB.prepare(`SELECT ${QUIZ_FIELDS} FROM quizzes q ${AUTHOR_JOIN} ${REVIEWER_JOIN} WHERE q.id = ?`)
    .bind(id)
    .first<QuizRow>();
  if (!quiz) return c.json({ error: 'ไม่พบแบบทดสอบ' }, 404);
  if (!canEdit(user, quiz)) return c.json({ error: 'Forbidden' }, 403);
  const { results } = await c.env.DB.prepare(
    `SELECT id, position, type, prompt, options, answer, explanation, points
     FROM quiz_questions WHERE quiz_id = ? ORDER BY position, id`,
  )
    .bind(id)
    .all<QuestionRow>();
  const questions = (results ?? []).map((q) => ({
    id: q.id,
    position: q.position,
    type: q.type,
    prompt: q.prompt,
    options: parseJson<string[]>(q.options, []),
    answer: parseJson<unknown>(q.answer, null),
    explanation: q.explanation,
    points: q.points,
  }));
  return c.json({ status: 'success', quiz, questions });
});

// Create a quiz (plus its questions in one shot). Starts as 'draft'.
quizzes.post('/quizzes', async (c) => {
  const user = c.get('user');
  const body = await c.req.json<QuizBody>().catch(() => ({}) as QuizBody);
  const invalid = validateQuizBody(body);
  if (invalid) return c.json({ error: invalid }, 400);

  const result = await c.env.DB.prepare(
    `INSERT INTO quizzes
       (title, title_th, description, description_th, lesson, lesson_th, video_url, category,
        status, time_limit_min, pass_score, allow_retake, show_answers, author_identity, author_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      body.title!.trim(),
      body.titleTh?.trim() || null,
      body.description?.trim() || null,
      body.descriptionTh?.trim() || null,
      body.lesson ?? null,
      body.lessonTh ?? null,
      body.videoUrl?.trim() || null,
      body.category?.trim() || null,
      body.timeLimitMin ?? null,
      Math.max(0, Math.min(100, Math.round(body.passScore ?? 0))),
      body.allowRetake === false ? 0 : 1,
      body.showAnswers === false ? 0 : 1,
      user.email,
      user.name || user.email,
    )
    .run();
  const quizId = Number(result.meta.last_row_id);

  if (Array.isArray(body.questions) && body.questions.length > 0) {
    const err = await replaceQuestions(c.env.DB, quizId, body.questions);
    if (err) {
      // Roll back the just-created quiz so a bad question set doesn't leave
      // an empty orphan behind.
      await c.env.DB.prepare(`DELETE FROM quizzes WHERE id = ?`).bind(quizId).run();
      return c.json({ error: err }, 400);
    }
  }

  await logAudit(c.env.DB, user, 'QUIZ_CREATE', null, String(quizId), true);
  return c.json({ ok: true, id: quizId });
});

// Edit a quiz (metadata + questions). Author or admin only.
quizzes.patch('/quizzes/:id', async (c) => {
  const user = c.get('user');
  const id = Number(c.req.param('id'));
  const quiz = await c.env.DB.prepare(`SELECT id, author_identity AS authorIdentity FROM quizzes WHERE id = ?`)
    .bind(id)
    .first<{ id: number; authorIdentity: string }>();
  if (!quiz) return c.json({ error: 'ไม่พบแบบทดสอบ' }, 404);
  if (!canEdit(user, quiz)) return c.json({ error: 'Forbidden' }, 403);

  const body = await c.req.json<QuizBody>().catch(() => ({}) as QuizBody);
  const invalid = validateQuizBody(body);
  if (invalid) return c.json({ error: invalid }, 400);

  if (Array.isArray(body.questions)) {
    const err = await replaceQuestions(c.env.DB, id, body.questions);
    if (err) return c.json({ error: err }, 400);
  }

  await c.env.DB.prepare(
    `UPDATE quizzes SET
       title = ?, title_th = ?, description = ?, description_th = ?, lesson = ?, lesson_th = ?, video_url = ?, category = ?,
       time_limit_min = ?, pass_score = ?, allow_retake = ?, show_answers = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
  )
    .bind(
      body.title!.trim(),
      body.titleTh?.trim() || null,
      body.description?.trim() || null,
      body.descriptionTh?.trim() || null,
      body.lesson ?? null,
      body.lessonTh ?? null,
      body.videoUrl?.trim() || null,
      body.category?.trim() || null,
      body.timeLimitMin ?? null,
      Math.max(0, Math.min(100, Math.round(body.passScore ?? 0))),
      body.allowRetake === false ? 0 : 1,
      body.showAnswers === false ? 0 : 1,
      id,
    )
    .run();

  await logAudit(c.env.DB, user, 'QUIZ_EDIT', null, String(id), true);
  return c.json({ ok: true });
});

// Publish / archive / back-to-draft — admin only, like blog approval.
quizzes.post('/quizzes/:id/status', requireAdmin, async (c) => {
  const user = c.get('user');
  const id = Number(c.req.param('id'));
  const body = await c.req.json<{ status?: string }>().catch(() => ({}) as never);
  if (!['draft', 'published', 'archived'].includes(body.status ?? '')) {
    return c.json({ error: 'สถานะไม่ถูกต้อง' }, 400);
  }
  const quiz = await c.env.DB.prepare(`SELECT id FROM quizzes WHERE id = ?`).bind(id).first();
  if (!quiz) return c.json({ error: 'ไม่พบแบบทดสอบ' }, 404);

  await c.env.DB.prepare(
    `UPDATE quizzes SET status = ?, reviewed_by = ?,
       published_at = CASE WHEN ? = 'published' AND published_at IS NULL THEN CURRENT_TIMESTAMP ELSE published_at END,
       updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
  )
    .bind(body.status, user.email, body.status, id)
    .run();

  await logAudit(c.env.DB, user, `QUIZ_${body.status!.toUpperCase()}`, null, String(id), true);
  return c.json({ ok: true });
});

// Delete a quiz (questions + attempts cascade). Author or admin.
quizzes.delete('/quizzes/:id', async (c) => {
  const user = c.get('user');
  const id = Number(c.req.param('id'));
  const quiz = await c.env.DB.prepare(`SELECT id, author_identity AS authorIdentity FROM quizzes WHERE id = ?`)
    .bind(id)
    .first<{ id: number; authorIdentity: string }>();
  if (!quiz) return c.json({ error: 'ไม่พบแบบทดสอบ' }, 404);
  if (!canEdit(user, quiz)) return c.json({ error: 'Forbidden' }, 403);
  // Delete children explicitly rather than relying on ON DELETE CASCADE —
  // D1 does not enforce foreign keys unless PRAGMA foreign_keys is on.
  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM quiz_questions WHERE quiz_id = ?`).bind(id),
    c.env.DB.prepare(`DELETE FROM quiz_attempts WHERE quiz_id = ?`).bind(id),
    c.env.DB.prepare(`DELETE FROM quizzes WHERE id = ?`).bind(id),
  ]);
  await logAudit(c.env.DB, user, 'QUIZ_DELETE', null, String(id), true);
  return c.json({ ok: true });
});

// Attempts / results for a quiz — author or admin. Joins the students table
// for a friendly name, matching how other screens show "who".
quizzes.get('/quizzes/:id/attempts', async (c) => {
  const user = c.get('user');
  const id = Number(c.req.param('id'));
  const quiz = await c.env.DB.prepare(`SELECT id, author_identity AS authorIdentity FROM quizzes WHERE id = ?`)
    .bind(id)
    .first<{ id: number; authorIdentity: string }>();
  if (!quiz) return c.json({ error: 'ไม่พบแบบทดสอบ' }, 404);
  if (!canEdit(user, quiz)) return c.json({ error: 'Forbidden' }, 403);
  const { results } = await c.env.DB.prepare(
    `SELECT qa.id, qa.student_id AS studentId, s.name AS studentName, s.nickname AS studentNickname,
            qa.score, qa.max_score AS maxScore, qa.passed, qa.submitted_at AS submittedAt
     FROM quiz_attempts qa
     LEFT JOIN students s ON s.id = qa.student_id COLLATE NOCASE
     WHERE qa.quiz_id = ? ORDER BY qa.submitted_at DESC, qa.id DESC LIMIT 500`,
  )
    .bind(id)
    .all();
  return c.json({ status: 'success', attempts: results ?? [] });
});

/* ===================== Portal routes (before verifyAuth) ===================== */

export const quizzesPortal = new Hono<AppBindings>();

// The published quizzes a student can see, each annotated with their best
// attempt so the list can show "passed / score / retake".
quizzesPortal.get('/portal/:studentId/quizzes', async (c) => {
  const studentId = c.req.param('studentId');
  if (!(await portalTokenMatchesStudent(c, studentId))) {
    return c.json({ status: 'error', message: 'Unauthorized' }, 401);
  }
  const { results } = await c.env.DB.prepare(
    `SELECT q.id, q.title, q.title_th AS titleTh, q.description, q.description_th AS descriptionTh,
            q.category, q.time_limit_min AS timeLimitMin, q.pass_score AS passScore,
            q.allow_retake AS allowRetake, q.published_at AS publishedAt,
            (SELECT COUNT(*) FROM quiz_questions qq WHERE qq.quiz_id = q.id) AS questionCount,
            (q.lesson IS NOT NULL AND q.lesson != '') AS hasLesson,
            (SELECT COUNT(*) FROM quiz_attempts qa WHERE qa.quiz_id = q.id AND qa.student_id = ? COLLATE NOCASE) AS attempts,
            (SELECT MAX(qa.score) FROM quiz_attempts qa WHERE qa.quiz_id = q.id AND qa.student_id = ? COLLATE NOCASE) AS bestScore,
            (SELECT MAX(qa.passed) FROM quiz_attempts qa WHERE qa.quiz_id = q.id AND qa.student_id = ? COLLATE NOCASE) AS passed
     FROM quizzes q
     WHERE q.status = 'published'
       AND NOT EXISTS (SELECT 1 FROM course_items ci WHERE ci.quiz_id = q.id)
     ORDER BY q.published_at DESC, q.id DESC LIMIT 200`,
  )
    .bind(studentId, studentId, studentId)
    .all();
  return c.json({ status: 'success', quizzes: results ?? [] });
});

// A single quiz to study/take: lesson + questions WITHOUT the correct answers
// (never send those to the browser before grading). Also reports whether the
// student may still attempt it.
quizzesPortal.get('/portal/:studentId/quizzes/:quizId', async (c) => {
  const studentId = c.req.param('studentId');
  const quizId = Number(c.req.param('quizId'));
  if (!(await portalTokenMatchesStudent(c, studentId))) {
    return c.json({ status: 'error', message: 'Unauthorized' }, 401);
  }
  const quiz = await c.env.DB.prepare(
    `SELECT id, title, title_th AS titleTh, description, description_th AS descriptionTh,
            lesson, lesson_th AS lessonTh, video_url AS videoUrl, category, time_limit_min AS timeLimitMin,
            pass_score AS passScore, allow_retake AS allowRetake, show_answers AS showAnswers
     FROM quizzes WHERE id = ? AND status = 'published'`,
  )
    .bind(quizId)
    .first<QuizRow>();
  if (!quiz) return c.json({ status: 'error', message: 'ไม่พบแบบทดสอบ' }, 404);

  // Course sequencing gate: enrollment, then Pretest → Lessons → Posttest.
  // Reports the course id + reason so the portal can steer the student.
  const gate = await courseGateForQuiz(c.env.DB, quizId, studentId);
  if (!gate.allowed) {
    return c.json({ status: 'error', message: gate.message, courseId: gate.courseId, reason: gate.reason, locked: true }, 403);
  }

  const { results } = await c.env.DB.prepare(
    `SELECT id, position, type, prompt, options, points FROM quiz_questions WHERE quiz_id = ? ORDER BY position, id`,
  )
    .bind(quizId)
    .all<QuestionRow>();
  const questions = (results ?? []).map((q) => ({
    id: q.id,
    type: q.type,
    prompt: q.prompt,
    options: parseJson<string[]>(q.options, []),
    points: q.points,
  }));

  const prior = await c.env.DB.prepare(
    `SELECT COUNT(*) AS attempts, MAX(score) AS bestScore, MAX(passed) AS passed
     FROM quiz_attempts WHERE quiz_id = ? AND student_id = ? COLLATE NOCASE`,
  )
    .bind(quizId, studentId)
    .first<{ attempts: number; bestScore: number | null; passed: number | null }>();
  const attempts = prior?.attempts ?? 0;
  const canAttempt = quiz.allowRetake === 1 || attempts === 0;

  return c.json({ status: 'success', quiz, questions, prior: { ...prior, canAttempt } });
});

// Submit an attempt. The Worker grades it (auto-grade for every supported
// type), stores the result, and returns the score plus — if the quiz allows
// it — per-question correctness and explanations.
quizzesPortal.post('/portal/:studentId/quizzes/:quizId/attempts', async (c) => {
  const studentId = c.req.param('studentId');
  const quizId = Number(c.req.param('quizId'));
  if (!(await portalTokenMatchesStudent(c, studentId))) {
    return c.json({ status: 'error', message: 'Unauthorized' }, 401);
  }
  const quiz = await c.env.DB.prepare(
    `SELECT id, pass_score AS passScore, allow_retake AS allowRetake, show_answers AS showAnswers
     FROM quizzes WHERE id = ? AND status = 'published'`,
  )
    .bind(quizId)
    .first<{ id: number; passScore: number; allowRetake: number; showAnswers: number }>();
  if (!quiz) return c.json({ status: 'error', message: 'ไม่พบแบบทดสอบ' }, 404);

  // A course quiz can't be submitted out of sequence either.
  const gate = await courseGateForQuiz(c.env.DB, quizId, studentId);
  if (!gate.allowed) {
    return c.json({ status: 'error', message: gate.message, courseId: gate.courseId, reason: gate.reason, locked: true }, 403);
  }

  // Enforce single-attempt quizzes server-side, not just in the UI.
  if (quiz.allowRetake === 0) {
    const existing = await c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM quiz_attempts WHERE quiz_id = ? AND student_id = ? COLLATE NOCASE`,
    )
      .bind(quizId, studentId)
      .first<{ n: number }>();
    if ((existing?.n ?? 0) > 0) return c.json({ status: 'error', message: 'แบบทดสอบนี้ทำได้เพียงครั้งเดียว' }, 409);
  }

  const body = await c.req.json<{ answers?: Record<string, unknown>; startedAt?: string }>().catch(() => ({}) as never);
  const submitted = body.answers ?? {};

  const { results } = await c.env.DB.prepare(
    `SELECT id, type, answer, explanation, points FROM quiz_questions WHERE quiz_id = ? ORDER BY position, id`,
  )
    .bind(quizId)
    .all<QuestionRow>();
  const questions = results ?? [];

  let score = 0;
  let maxScore = 0;
  const breakdown = questions.map((q) => {
    maxScore += q.points;
    const graded = gradeQuestion(q, submitted[String(q.id)]);
    score += graded.earned;
    return {
      id: q.id,
      correct: graded.correct,
      earned: graded.earned,
      points: q.points,
      ...(quiz.showAnswers === 1
        ? { correctAnswer: parseJson<unknown>(q.answer, null), explanation: q.explanation }
        : {}),
    };
  });

  const passed = maxScore > 0 && quiz.passScore > 0 ? Math.round((score / maxScore) * 100) >= quiz.passScore : score === maxScore;

  const inserted = await c.env.DB.prepare(
    `INSERT INTO quiz_attempts (quiz_id, student_id, answers, score, max_score, passed, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      quizId,
      studentId,
      JSON.stringify(submitted).slice(0, 20_000),
      score,
      maxScore,
      passed ? 1 : 0,
      body.startedAt ?? null,
    )
    .run();

  await logAudit(c.env.DB, null, 'QUIZ_ATTEMPT', studentId, String(quizId), true);
  return c.json({
    status: 'success',
    attemptId: Number(inserted.meta.last_row_id),
    score,
    maxScore,
    percent: maxScore > 0 ? Math.round((score / maxScore) * 100) : 0,
    passed,
    showAnswers: quiz.showAnswers === 1,
    breakdown,
  });
});

export default quizzes;
