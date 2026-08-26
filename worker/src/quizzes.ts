// Online learning & testing system (ระบบทดสอบและเรียนออนไลน์).
//
// The original quiz model remains the assessment/content engine used by
// on-demand courses. Student-specific 1-to-1 exams are represented by the
// same proven question/attempt engine plus tutored_exam_assignments, which
// binds one quiz to exactly one student and enforces teacher visibility.
import { Hono } from 'hono';
import type { AppBindings, AuthUser } from './types';
import { isAdmin, requireAdmin, portalTokenMatchesStudent } from './auth';
import { logAudit } from './db';
import { courseGateForQuiz } from './courses';
import { isPlusMember } from './plus';

const MAX_TITLE = 300;
const MAX_TEXT = 2_000;
const MAX_LESSON = 60_000;
const MAX_PROMPT = 4_000;
const MAX_QUESTIONS = 100;
const MAX_OPTIONS = 10;
const QUESTION_TYPES = new Set(['single', 'multiple', 'truefalse', 'short']);
const AUDIENCES = new Set(['on_demand', 'tutored']);
const normAudience = (a: string | undefined): string => (AUDIENCES.has(a ?? '') ? (a as string) : 'on_demand');

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
  videoName?: string | null;
  videoSize?: number | null;
  hasVideoFile?: number;
  slideName?: string | null;
  slideSize?: number | null;
  hasSlides?: number;
  category: string | null;
  audience: string;
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

export interface QuestionRow {
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
  audience?: string;
  timeLimitMin?: number | null;
  passScore?: number;
  allowRetake?: boolean;
  showAnswers?: boolean;
  questions?: QuestionInput[];
}

interface TutoredAssignmentBody {
  studentId?: string;
  availableFrom?: string | null;
  dueAt?: string | null;
  publish?: boolean;
}

const AUTHOR_JOIN = `LEFT JOIN staff st ON st.identity = q.author_identity COLLATE NOCASE`;
const AUTHOR_NAME_FIELD = `COALESCE(st.name, q.author_name) AS authorName`;
const REVIEWER_JOIN = `LEFT JOIN staff rst ON rst.identity = q.reviewed_by COLLATE NOCASE`;
const REVIEWED_BY_FIELD = `COALESCE(rst.name, q.reviewed_by) AS reviewedBy`;

const QUIZ_FIELDS = `q.id, q.title, q.title_th AS titleTh, q.description, q.description_th AS descriptionTh,
  q.lesson, q.lesson_th AS lessonTh, q.video_url AS videoUrl, q.category, q.audience, q.status, q.time_limit_min AS timeLimitMin,
  q.video_name AS videoName, q.video_size AS videoSize, (q.video_key IS NOT NULL) AS hasVideoFile,
  q.slide_name AS slideName, q.slide_size AS slideSize, (q.slide_key IS NOT NULL) AS hasSlides,
  q.pass_score AS passScore, q.allow_retake AS allowRetake, q.show_answers AS showAnswers,
  q.author_identity AS authorIdentity, ${AUTHOR_NAME_FIELD}, ${REVIEWED_BY_FIELD},
  q.created_at AS createdAt, q.updated_at AS updatedAt, q.published_at AS publishedAt`;

function canEdit(user: AuthUser, quiz: { authorIdentity?: string }): boolean {
  return isAdmin(user) || (quiz.authorIdentity ?? '').toLowerCase() === user.email.toLowerCase();
}

export function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

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
    return { type, prompt, options: JSON.stringify(options), answer: JSON.stringify([...new Set(valid)].sort((a, b) => a - b)), explanation, points };
  }

  if (type === 'truefalse') {
    if (typeof input.answer !== 'boolean') return { error: 'กรุณาเลือกจริงหรือเท็จ' };
    return { type, prompt, options: null, answer: JSON.stringify(input.answer), explanation, points };
  }

  const accepted = (Array.isArray(input.answer) ? input.answer : [input.answer])
    .map((a) => String(a ?? '').trim())
    .filter((a) => a.length > 0);
  if (accepted.length === 0) return { error: 'กรุณากรอกคำตอบที่ยอมรับได้' };
  return { type, prompt, options: null, answer: JSON.stringify(accepted), explanation, points };
}

export function gradeQuestion(q: QuestionRow, submitted: unknown): { correct: boolean; earned: number } {
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
    stmts.push(db.prepare(`INSERT INTO quiz_questions (quiz_id, position, type, prompt, options, answer, explanation, points)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(quizId, i, n.type, n.prompt, n.options, n.answer, n.explanation, n.points));
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
  if (body.timeLimitMin != null && body.timeLimitMin !== null && (body.timeLimitMin < 0 || body.timeLimitMin > 600)) return 'เวลาจำกัดไม่ถูกต้อง';
  return null;
}

function normaliseTime(value: string | null | undefined): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

async function canAssignStudent(db: D1Database, user: AuthUser, studentId: string): Promise<boolean> {
  const student = await db.prepare(`SELECT id FROM students WHERE id = ? COLLATE NOCASE AND deleted_at IS NULL`).bind(studentId).first();
  if (!student) return false;
  if (isAdmin(user)) return true;
  const assigned = await db.prepare(
    `SELECT 1 AS ok FROM teacher_students WHERE teacher_email = ? COLLATE NOCASE AND student_id = ? COLLATE NOCASE LIMIT 1`,
  ).bind(user.email, studentId).first<{ ok: number }>();
  return !!assigned;
}

async function tutoredGate(db: D1Database, quizId: number, studentId: string): Promise<{ allowed: boolean; message?: string }> {
  const row = await db.prepare(
    `SELECT student_id AS studentId, available_from AS availableFrom, due_at AS dueAt
       FROM tutored_exam_assignments WHERE quiz_id = ?`,
  ).bind(quizId).first<{ studentId: string; availableFrom: string | null; dueAt: string | null }>();
  if (!row || row.studentId.toLowerCase() !== studentId.toLowerCase()) return { allowed: false, message: 'แบบทดสอบนี้ไม่ได้ถูกออกให้บัญชีของคุณ' };
  const now = Date.now();
  if (row.availableFrom && Date.parse(row.availableFrom) > now) return { allowed: false, message: 'แบบทดสอบนี้ยังไม่ถึงเวลาเปิดทำ' };
  if (row.dueAt && Date.parse(row.dueAt) < now) return { allowed: false, message: 'หมดเวลาทำแบบทดสอบนี้แล้ว' };
  return { allowed: true };
}

const quizzes = new Hono<AppBindings>();

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

quizzes.get('/quizzes/:id', async (c) => {
  const user = c.get('user');
  const id = Number(c.req.param('id'));
  const quiz = await c.env.DB.prepare(`SELECT ${QUIZ_FIELDS} FROM quizzes q ${AUTHOR_JOIN} ${REVIEWER_JOIN} WHERE q.id = ?`).bind(id).first<QuizRow>();
  if (!quiz) return c.json({ error: 'ไม่พบแบบทดสอบ' }, 404);
  if (!canEdit(user, quiz)) return c.json({ error: 'Forbidden' }, 403);
  const { results } = await c.env.DB.prepare(`SELECT id, position, type, prompt, options, answer, explanation, points
     FROM quiz_questions WHERE quiz_id = ? ORDER BY position, id`).bind(id).all<QuestionRow>();
  const questions = (results ?? []).map((q) => ({ id: q.id, position: q.position, type: q.type, prompt: q.prompt, options: parseJson<string[]>(q.options, []), answer: parseJson<unknown>(q.answer, null), explanation: q.explanation, points: q.points }));
  return c.json({ status: 'success', quiz, questions });
});

quizzes.post('/quizzes', async (c) => {
  const user = c.get('user');
  const body = await c.req.json<QuizBody>().catch(() => ({}) as QuizBody);
  const invalid = validateQuizBody(body);
  if (invalid) return c.json({ error: invalid }, 400);
  const result = await c.env.DB.prepare(`INSERT INTO quizzes
       (title, title_th, description, description_th, lesson, lesson_th, video_url, category, audience,
        status, time_limit_min, pass_score, allow_retake, show_answers, author_identity, author_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?)`).bind(
      body.title!.trim(), body.titleTh?.trim() || null, body.description?.trim() || null, body.descriptionTh?.trim() || null,
      body.lesson ?? null, body.lessonTh ?? null, body.videoUrl?.trim() || null, body.category?.trim() || null, normAudience(body.audience),
      body.timeLimitMin ?? null, Math.max(0, Math.min(100, Math.round(body.passScore ?? 0))), body.allowRetake === false ? 0 : 1,
      body.showAnswers === false ? 0 : 1, user.email, user.name || user.email,
    ).run();
  const quizId = Number(result.meta.last_row_id);
  if (Array.isArray(body.questions) && body.questions.length > 0) {
    const err = await replaceQuestions(c.env.DB, quizId, body.questions);
    if (err) { await c.env.DB.prepare(`DELETE FROM quizzes WHERE id = ?`).bind(quizId).run(); return c.json({ error: err }, 400); }
  }
  await logAudit(c.env.DB, user, 'QUIZ_CREATE', null, String(quizId), true);
  return c.json({ ok: true, id: quizId });
});

quizzes.patch('/quizzes/:id', async (c) => {
  const user = c.get('user');
  const id = Number(c.req.param('id'));
  const quiz = await c.env.DB.prepare(`SELECT id, author_identity AS authorIdentity FROM quizzes WHERE id = ?`).bind(id).first<{ id: number; authorIdentity: string }>();
  if (!quiz) return c.json({ error: 'ไม่พบแบบทดสอบ' }, 404);
  if (!canEdit(user, quiz)) return c.json({ error: 'Forbidden' }, 403);
  const body = await c.req.json<QuizBody>().catch(() => ({}) as QuizBody);
  const invalid = validateQuizBody(body);
  if (invalid) return c.json({ error: invalid }, 400);
  if (Array.isArray(body.questions)) { const err = await replaceQuestions(c.env.DB, id, body.questions); if (err) return c.json({ error: err }, 400); }
  await c.env.DB.prepare(`UPDATE quizzes SET title = ?, title_th = ?, description = ?, description_th = ?, lesson = ?, lesson_th = ?, video_url = ?, category = ?,
       audience = ?, time_limit_min = ?, pass_score = ?, allow_retake = ?, show_answers = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(
      body.title!.trim(), body.titleTh?.trim() || null, body.description?.trim() || null, body.descriptionTh?.trim() || null,
      body.lesson ?? null, body.lessonTh ?? null, body.videoUrl?.trim() || null, body.category?.trim() || null, normAudience(body.audience),
      body.timeLimitMin ?? null, Math.max(0, Math.min(100, Math.round(body.passScore ?? 0))), body.allowRetake === false ? 0 : 1,
      body.showAnswers === false ? 0 : 1, id,
    ).run();
  await logAudit(c.env.DB, user, 'QUIZ_EDIT', null, String(id), true);
  return c.json({ ok: true });
});

quizzes.post('/quizzes/:id/status', requireAdmin, async (c) => {
  const user = c.get('user');
  const id = Number(c.req.param('id'));
  const body = await c.req.json<{ status?: string }>().catch(() => ({}) as never);
  if (!['draft', 'published', 'archived'].includes(body.status ?? '')) return c.json({ error: 'สถานะไม่ถูกต้อง' }, 400);
  const quiz = await c.env.DB.prepare(`SELECT id FROM quizzes WHERE id = ?`).bind(id).first();
  if (!quiz) return c.json({ error: 'ไม่พบแบบทดสอบ' }, 404);
  await c.env.DB.prepare(`UPDATE quizzes SET status = ?, reviewed_by = ?, published_at = CASE WHEN ? = 'published' AND published_at IS NULL THEN CURRENT_TIMESTAMP ELSE published_at END, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(body.status, user.email, body.status, id).run();
  await logAudit(c.env.DB, user, `QUIZ_${body.status!.toUpperCase()}`, null, String(id), true);
  return c.json({ ok: true });
});

quizzes.delete('/quizzes/:id', async (c) => {
  const user = c.get('user');
  const id = Number(c.req.param('id'));
  const quiz = await c.env.DB.prepare(`SELECT id, author_identity AS authorIdentity FROM quizzes WHERE id = ?`).bind(id).first<{ id: number; authorIdentity: string }>();
  if (!quiz) return c.json({ error: 'ไม่พบแบบทดสอบ' }, 404);
  if (!canEdit(user, quiz)) return c.json({ error: 'Forbidden' }, 403);
  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM tutored_exam_assignments WHERE quiz_id = ?`).bind(id),
    c.env.DB.prepare(`DELETE FROM quiz_questions WHERE quiz_id = ?`).bind(id),
    c.env.DB.prepare(`DELETE FROM quiz_attempts WHERE quiz_id = ?`).bind(id),
    c.env.DB.prepare(`DELETE FROM quizzes WHERE id = ?`).bind(id),
  ]);
  await logAudit(c.env.DB, user, 'QUIZ_DELETE', null, String(id), true);
  return c.json({ ok: true });
});

quizzes.get('/quizzes/:id/attempts', async (c) => {
  const user = c.get('user');
  const id = Number(c.req.param('id'));
  const quiz = await c.env.DB.prepare(`SELECT id, author_identity AS authorIdentity FROM quizzes WHERE id = ?`).bind(id).first<{ id: number; authorIdentity: string }>();
  if (!quiz) return c.json({ error: 'ไม่พบแบบทดสอบ' }, 404);
  if (!canEdit(user, quiz)) return c.json({ error: 'Forbidden' }, 403);
  const { results } = await c.env.DB.prepare(`SELECT qa.id, qa.student_id AS studentId, s.name AS studentName, s.nickname AS studentNickname,
            qa.score, qa.max_score AS maxScore, qa.passed, qa.submitted_at AS submittedAt
     FROM quiz_attempts qa LEFT JOIN students s ON s.id = qa.student_id COLLATE NOCASE
     WHERE qa.quiz_id = ? ORDER BY qa.submitted_at DESC, qa.id DESC LIMIT 500`).bind(id).all();
  return c.json({ status: 'success', attempts: results ?? [] });
});

quizzes.get('/quiz-attempts', async (c) => {
  const user = c.get('user');
  const admin = isAdmin(user);
  const base = `SELECT qa.id, qa.student_id AS studentId, s.name AS studentName, s.nickname AS studentNickname,
       s.account_type AS accountType, qa.quiz_id AS quizId, q.title AS quizTitle, q.title_th AS quizTitleTh,
       qa.score, qa.max_score AS maxScore, qa.passed, qa.submitted_at AS submittedAt
     FROM quiz_attempts qa JOIN quizzes q ON q.id = qa.quiz_id LEFT JOIN students s ON s.id = qa.student_id COLLATE NOCASE`;
  const stmt = admin ? c.env.DB.prepare(`${base} ORDER BY qa.submitted_at DESC, qa.id DESC LIMIT 2000`) : c.env.DB.prepare(`${base} WHERE q.author_identity = ? COLLATE NOCASE ORDER BY qa.submitted_at DESC, qa.id DESC LIMIT 2000`).bind(user.email);
  const { results } = await stmt.all();
  return c.json({ status: 'success', attempts: results ?? [] });
});

// 1-to-1 exam list. Admins can see all; teachers only see exams they authored
// for students that are currently assigned to them.
quizzes.get('/tutored-exams', async (c) => {
  const user = c.get('user');
  const base = `SELECT ${QUIZ_FIELDS}, tea.student_id AS studentId, s.name AS studentName, s.nickname AS studentNickname,
      tea.available_from AS availableFrom, tea.due_at AS dueAt, tea.assigned_by AS assignedBy,
      (SELECT COUNT(*) FROM quiz_questions qq WHERE qq.quiz_id = q.id) AS questionCount,
      (SELECT COUNT(*) FROM quiz_attempts qa WHERE qa.quiz_id = q.id AND qa.student_id = tea.student_id COLLATE NOCASE) AS attemptCount
    FROM quizzes q
    JOIN tutored_exam_assignments tea ON tea.quiz_id = q.id
    LEFT JOIN students s ON s.id = tea.student_id COLLATE NOCASE
    ${AUTHOR_JOIN} ${REVIEWER_JOIN}`;
  const stmt = isAdmin(user)
    ? c.env.DB.prepare(`${base} ORDER BY q.updated_at DESC, q.id DESC`)
    : c.env.DB.prepare(`${base} WHERE q.author_identity = ? COLLATE NOCASE AND EXISTS (
        SELECT 1 FROM teacher_students ts WHERE ts.teacher_email = ? COLLATE NOCASE AND ts.student_id = tea.student_id COLLATE NOCASE
      ) ORDER BY q.updated_at DESC, q.id DESC`).bind(user.email, user.email);
  const { results } = await stmt.all();
  return c.json({ status: 'success', exams: results ?? [] });
});

// Bind an authored quiz to one tutored student. This is deliberately separate
// from generic quiz authoring so course assessments never acquire student
// ownership by accident. Teachers may publish their own 1-to-1 exams because
// the server verifies the target is one of their assigned students.
quizzes.put('/tutored-exams/:id/assignment', async (c) => {
  const user = c.get('user');
  const id = Number(c.req.param('id'));
  const quiz = await c.env.DB.prepare(`SELECT id, author_identity AS authorIdentity FROM quizzes WHERE id = ?`).bind(id).first<{ id: number; authorIdentity: string }>();
  if (!quiz) return c.json({ error: 'ไม่พบแบบทดสอบ' }, 404);
  if (!canEdit(user, quiz)) return c.json({ error: 'Forbidden' }, 403);
  const body = await c.req.json<TutoredAssignmentBody>().catch(() => ({}) as TutoredAssignmentBody);
  const studentId = (body.studentId ?? '').trim();
  if (!studentId) return c.json({ error: 'กรุณาเลือกนักเรียน' }, 400);
  if (!(await canAssignStudent(c.env.DB, user, studentId))) return c.json({ error: 'ไม่มีสิทธิ์ออกข้อสอบให้นักเรียนคนนี้' }, 403);
  const availableFrom = normaliseTime(body.availableFrom);
  const dueAt = normaliseTime(body.dueAt);
  if (availableFrom && dueAt && Date.parse(dueAt) <= Date.parse(availableFrom)) return c.json({ error: 'วันสิ้นสุดต้องอยู่หลังวันเปิดทำ' }, 400);

  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO tutored_exam_assignments (quiz_id, student_id, assigned_by, available_from, due_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(quiz_id) DO UPDATE SET student_id = excluded.student_id, assigned_by = excluded.assigned_by,
        available_from = excluded.available_from, due_at = excluded.due_at, updated_at = CURRENT_TIMESTAMP`).bind(id, studentId, user.email, availableFrom, dueAt),
    c.env.DB.prepare(`UPDATE quizzes SET audience = 'tutored', status = ?, reviewed_by = ?,
      published_at = CASE WHEN ? = 'published' AND published_at IS NULL THEN CURRENT_TIMESTAMP ELSE published_at END,
      updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(body.publish ? 'published' : 'draft', user.email, body.publish ? 'published' : 'draft', id),
  ]);
  await logAudit(c.env.DB, user, body.publish ? 'TUTORED_EXAM_ISSUE' : 'TUTORED_EXAM_DRAFT', studentId, String(id), true);
  return c.json({ ok: true, id, status: body.publish ? 'published' : 'draft' });
});

export const quizzesPortal = new Hono<AppBindings>();

quizzesPortal.get('/portal/:studentId/quizzes', async (c) => {
  const studentId = c.req.param('studentId');
  if (!(await portalTokenMatchesStudent(c, studentId))) return c.json({ status: 'error', message: 'Unauthorized' }, 401);
  const { results } = await c.env.DB.prepare(`SELECT q.id, q.title, q.title_th AS titleTh, q.description, q.description_th AS descriptionTh,
            q.category, q.audience, q.time_limit_min AS timeLimitMin, q.pass_score AS passScore,
            q.allow_retake AS allowRetake, q.published_at AS publishedAt,
            (SELECT COUNT(*) FROM quiz_questions qq WHERE qq.quiz_id = q.id) AS questionCount,
            (q.lesson IS NOT NULL AND q.lesson != '') AS hasLesson,
            (q.video_key IS NOT NULL OR (q.video_url IS NOT NULL AND q.video_url != '')) AS hasVideo,
            (SELECT COUNT(*) FROM quiz_attempts qa WHERE qa.quiz_id = q.id AND qa.student_id = ? COLLATE NOCASE) AS attempts,
            (SELECT MAX(qa.score) FROM quiz_attempts qa WHERE qa.quiz_id = q.id AND qa.student_id = ? COLLATE NOCASE) AS bestScore,
            (SELECT MAX(qa.passed) FROM quiz_attempts qa WHERE qa.quiz_id = q.id AND qa.student_id = ? COLLATE NOCASE) AS passed
     FROM quizzes q
     WHERE q.status = 'published'
       AND NOT EXISTS (SELECT 1 FROM course_items ci WHERE ci.quiz_id = q.id)
       AND (
         q.audience = 'on_demand'
         OR EXISTS (SELECT 1 FROM tutored_exam_assignments tea WHERE tea.quiz_id = q.id
           AND tea.student_id = ? COLLATE NOCASE
           AND (tea.available_from IS NULL OR datetime(tea.available_from) <= datetime('now'))
           AND (tea.due_at IS NULL OR datetime(tea.due_at) >= datetime('now')))
       )
     ORDER BY q.published_at DESC, q.id DESC LIMIT 200`).bind(studentId, studentId, studentId, studentId).all();
  return c.json({ status: 'success', quizzes: results ?? [] });
});

quizzesPortal.get('/portal/:studentId/quizzes/:quizId', async (c) => {
  const studentId = c.req.param('studentId');
  const quizId = Number(c.req.param('quizId'));
  if (!(await portalTokenMatchesStudent(c, studentId))) return c.json({ status: 'error', message: 'Unauthorized' }, 401);
  const quiz = await c.env.DB.prepare(`SELECT id, title, title_th AS titleTh, description, description_th AS descriptionTh,
            lesson, lesson_th AS lessonTh, video_url AS videoUrl, (video_key IS NOT NULL) AS hasVideoFile,
            (slide_key IS NOT NULL) AS hasSlides, slide_name AS slideName, slide_size AS slideSize,
            category, audience, time_limit_min AS timeLimitMin, pass_score AS passScore, allow_retake AS allowRetake, show_answers AS showAnswers
     FROM quizzes WHERE id = ? AND status = 'published'`).bind(quizId).first<QuizRow>();
  if (!quiz) return c.json({ status: 'error', message: 'ไม่พบแบบทดสอบ' }, 404);
  if (quiz.audience === 'tutored') {
    const tg = await tutoredGate(c.env.DB, quizId, studentId);
    if (!tg.allowed) return c.json({ status: 'error', message: tg.message, locked: true }, 403);
  }
  const gate = await courseGateForQuiz(c.env.DB, quizId, studentId);
  if (!gate.allowed) return c.json({ status: 'error', message: gate.message, courseId: gate.courseId, reason: gate.reason, locked: true }, 403);
  const { results } = await c.env.DB.prepare(`SELECT id, position, type, prompt, options, points FROM quiz_questions WHERE quiz_id = ? ORDER BY position, id`).bind(quizId).all<QuestionRow>();
  const questions = (results ?? []).map((q) => ({ id: q.id, type: q.type, prompt: q.prompt, options: parseJson<string[]>(q.options, []), points: q.points }));
  const prior = await c.env.DB.prepare(`SELECT COUNT(*) AS attempts, MAX(score) AS bestScore, MAX(passed) AS passed FROM quiz_attempts WHERE quiz_id = ? AND student_id = ? COLLATE NOCASE`).bind(quizId, studentId).first<{ attempts: number; bestScore: number | null; passed: number | null }>();
  const attempts = prior?.attempts ?? 0;
  const canAttempt = quiz.allowRetake === 1 || attempts === 0;
  return c.json({ status: 'success', quiz, questions, prior: { ...prior, canAttempt } });
});

quizzesPortal.post('/portal/:studentId/quizzes/:quizId/attempts', async (c) => {
  const studentId = c.req.param('studentId');
  const quizId = Number(c.req.param('quizId'));
  if (!(await portalTokenMatchesStudent(c, studentId))) return c.json({ status: 'error', message: 'Unauthorized' }, 401);
  const quiz = await c.env.DB.prepare(`SELECT id, audience, pass_score AS passScore, allow_retake AS allowRetake, show_answers AS showAnswers FROM quizzes WHERE id = ? AND status = 'published'`).bind(quizId).first<{ id: number; audience: string; passScore: number; allowRetake: number; showAnswers: number }>();
  if (!quiz) return c.json({ status: 'error', message: 'ไม่พบแบบทดสอบ' }, 404);
  if (quiz.audience === 'tutored') {
    const tg = await tutoredGate(c.env.DB, quizId, studentId);
    if (!tg.allowed) return c.json({ status: 'error', message: tg.message, locked: true }, 403);
  }
  const gate = await courseGateForQuiz(c.env.DB, quizId, studentId);
  if (!gate.allowed) return c.json({ status: 'error', message: gate.message, courseId: gate.courseId, reason: gate.reason, locked: true }, 403);
  if (quiz.allowRetake === 0) {
    const existing = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM quiz_attempts WHERE quiz_id = ? AND student_id = ? COLLATE NOCASE`).bind(quizId, studentId).first<{ n: number }>();
    if ((existing?.n ?? 0) > 0) return c.json({ status: 'error', message: 'แบบทดสอบนี้ทำได้เพียงครั้งเดียว' }, 409);
  }
  const body = await c.req.json<{ answers?: Record<string, unknown>; startedAt?: string }>().catch(() => ({}) as never);
  const submitted = body.answers ?? {};
  const { results } = await c.env.DB.prepare(`SELECT id, type, answer, explanation, points FROM quiz_questions WHERE quiz_id = ? ORDER BY position, id`).bind(quizId).all<QuestionRow>();
  const questions = results ?? [];
  const plusMember = await isPlusMember(c.env.DB, studentId);
  const detailedAnswers = quiz.showAnswers === 1 && plusMember;
  let score = 0;
  let maxScore = 0;
  const breakdown = questions.map((q) => {
    maxScore += q.points;
    const graded = gradeQuestion(q, submitted[String(q.id)]);
    score += graded.earned;
    return { id: q.id, correct: graded.correct, earned: graded.earned, points: q.points,
      ...(detailedAnswers ? { correctAnswer: parseJson<unknown>(q.answer, null), explanation: q.explanation } : {}) };
  });
  const passed = maxScore > 0 && quiz.passScore > 0 ? Math.round((score / maxScore) * 100) >= quiz.passScore : score === maxScore;
  const inserted = await c.env.DB.prepare(`INSERT INTO quiz_attempts (quiz_id, student_id, answers, score, max_score, passed, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(
      quizId, studentId, JSON.stringify(submitted).slice(0, 20_000), score, maxScore, passed ? 1 : 0, body.startedAt ?? null,
    ).run();
  await logAudit(c.env.DB, null, 'QUIZ_ATTEMPT', studentId, String(quizId), true);
  return c.json({ status: 'success', attemptId: Number(inserted.meta.last_row_id), score, maxScore,
    percent: maxScore > 0 ? Math.round((score / maxScore) * 100) : 0, passed, showAnswers: detailedAnswers,
    detailedLocked: quiz.showAnswers === 1 && !plusMember, breakdown });
});

export default quizzes;
