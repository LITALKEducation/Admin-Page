// โหมดติวสอบ — practice exams น้องลิลลี่ writes, a LITALK+ benefit
// (worker/migrations/0035).
//
// The learner asks to be tested on a lesson or a topic; Lilly returns a set of
// questions; the Worker stores them, serves them WITHOUT the answers, grades
// the submission itself, and keeps the score. So it behaves like any other
// graded test here rather than like a chat transcript.
//
// Three rules, and the first two are why this is not just a chat prompt:
//
//   * The model never grades. Gemini writes the questions; gradeQuestion in
//     quizzes.ts marks them, exactly as it marks a teacher's quiz. A model
//     asked to mark its own exam will happily agree with a wrong answer.
//   * Answers are never sent before submission, same as a real quiz. The
//     browser gets prompts and options only.
//   * Generated exams live in their own table, never in `quizzes` — see the
//     migration for why. Nothing here can reach the published catalogue.
import { Hono } from 'hono';
import type { AppBindings, Env } from './types';
import { portalTokenMatchesStudent } from './auth';
import { logAudit } from './db';
import { isPlusMember } from './plus';
import { chatReply, ChatNotConfiguredError } from './gemini';
import { gradeQuestion, parseJson, type QuestionRow } from './quizzes';

const MIN_QUESTIONS = 3;
const MAX_QUESTIONS = 20;
const DEFAULT_QUESTIONS = 10;
const MAX_TOPIC = 200;
// Generating costs a model call, so it is rate-limited on its own rather than
// against the chat quota — a member with unlimited chat should still not be
// able to spin up exams in a loop.
const MAX_EXAMS_PER_DAY = 20;

type QuestionType = 'single' | 'multiple' | 'truefalse' | 'short';
const QUESTION_TYPES = new Set<QuestionType>(['single', 'multiple', 'truefalse', 'short']);

interface StoredQuestion {
  id: number;
  type: string;
  prompt: string;
  options: string | null; // JSON, matching quiz_questions
  answer: string; // JSON, matching quiz_questions
  explanation: string | null;
  points: number;
}

/* ===================== Generation ===================== */

// Gemini is asked for JSON and usually obliges, but it also likes to wrap it in
// a ```json fence or add a sentence before it. Pull out the first array or
// object rather than trusting the whole reply to parse.
function extractJson(raw: string): unknown {
  const text = raw.replace(/```json/gi, '```').replace(/```/g, '').trim();
  try {
    return JSON.parse(text);
  } catch {
    /* fall through to a bracket scan */
  }
  const start = text.search(/[[{]/);
  if (start === -1) return null;
  const open = text[start];
  const close = open === '[' ? ']' : '}';
  const end = text.lastIndexOf(close);
  if (end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

// Normalise one model-written question into the row shape gradeQuestion
// expects, or null if it cannot be trusted. Everything here is defensive: the
// model is an untrusted source of structure, and a malformed question that
// slipped through would be unanswerable or would mark a correct answer wrong.
function normaliseGenerated(input: unknown, id: number): StoredQuestion | null {
  if (!input || typeof input !== 'object') return null;
  const q = input as Record<string, unknown>;
  const type = String(q.type ?? 'single') as QuestionType;
  if (!QUESTION_TYPES.has(type)) return null;
  const prompt = String(q.prompt ?? '').trim();
  if (!prompt || prompt.length > 2000) return null;
  const explanation = q.explanation != null ? String(q.explanation).trim().slice(0, 2000) || null : null;
  const base = { id, type, prompt, explanation, points: 1 };

  if (type === 'single' || type === 'multiple') {
    const options = (Array.isArray(q.options) ? q.options : [])
      .map((o) => String(o ?? '').trim())
      .filter((o) => o.length > 0)
      .slice(0, 10);
    if (options.length < 2) return null;
    if (type === 'single') {
      const idx = Number(q.answer);
      if (!Number.isInteger(idx) || idx < 0 || idx >= options.length) return null;
      return { ...base, options: JSON.stringify(options), answer: JSON.stringify(idx) };
    }
    const picked = (Array.isArray(q.answer) ? q.answer : [])
      .map((n) => Number(n))
      .filter((n) => Number.isInteger(n) && n >= 0 && n < options.length);
    if (!picked.length) return null;
    return {
      ...base,
      options: JSON.stringify(options),
      answer: JSON.stringify([...new Set(picked)].sort((a, b) => a - b)),
    };
  }

  if (type === 'truefalse') {
    if (typeof q.answer !== 'boolean') return null;
    return { ...base, options: null, answer: JSON.stringify(q.answer) };
  }

  const accepted = (Array.isArray(q.answer) ? q.answer : [q.answer])
    .map((a) => String(a ?? '').trim())
    .filter((a) => a.length > 0)
    .slice(0, 10);
  if (!accepted.length) return null;
  return { ...base, options: null, answer: JSON.stringify(accepted) };
}

const SYSTEM_PROMPT = [
  'You are น้องลิลลี่ (Nong Lilly), LITALK Education\'s tutor, writing a practice exam for one student.',
  'Reply with JSON ONLY — a single array, no prose, no markdown fence.',
  'Each element: {"type":"single"|"multiple"|"truefalse"|"short","prompt":string,"options":string[],"answer":<see below>,"explanation":string}',
  'answer is: the 0-based index for "single"; an array of 0-based indices for "multiple"; true/false for "truefalse"; an array of accepted strings for "short".',
  '"options" is required for single/multiple (2-5 of them) and must be omitted or empty otherwise.',
  'Always include a short "explanation" in Thai saying WHY the answer is right — it is the part the student learns from.',
  'Write prompts in the language the student is studying (English) but explanations in Thai.',
  'Vary the question types. Do not repeat a question. Do not reference material you were not given.',
].join('\n');

async function generateQuestions(
  env: Env,
  opts: { topic: string; lesson: string | null; count: number },
): Promise<StoredQuestion[]> {
  const ask = [
    `Write ${opts.count} exam questions on: ${opts.topic}.`,
    opts.lesson ? `Base them on this lesson material:\n${opts.lesson.slice(0, 6000)}` : null,
    'Return the JSON array only.',
  ]
    .filter(Boolean)
    .join('\n\n');

  const reply = await chatReply(env, SYSTEM_PROMPT, [], ask);
  const parsed = extractJson(reply);
  const list = Array.isArray(parsed) ? parsed : [];
  const questions: StoredQuestion[] = [];
  list.forEach((item) => {
    if (questions.length >= MAX_QUESTIONS) return;
    const q = normaliseGenerated(item, questions.length + 1);
    if (q) questions.push(q);
  });
  return questions;
}

/* ===================== Portal routes (before verifyAuth) ===================== */

export const practiceExams = new Hono<AppBindings>();

// Strip the answers. The one rule this module cannot get wrong.
function forStudent(questions: StoredQuestion[]) {
  return questions.map((q) => ({
    id: q.id,
    type: q.type,
    prompt: q.prompt,
    options: parseJson<string[]>(q.options, []),
    points: q.points,
  }));
}

async function requireMember(c: { env: Env }, studentId: string): Promise<boolean> {
  return isPlusMember(c.env.DB, studentId);
}

// Generate a new exam. Members only — this is the benefit itself.
practiceExams.post('/portal/:studentId/practice-exams', async (c) => {
  const studentId = c.req.param('studentId');
  if (!(await portalTokenMatchesStudent(c, studentId))) {
    return c.json({ status: 'error', message: 'Unauthorized' }, 401);
  }
  if (!(await requireMember(c, studentId))) {
    return c.json({ status: 'error', message: 'โหมดติวสอบเป็นสิทธิ์ของสมาชิก LITALK+', requiresPlus: true }, 402);
  }

  const body = await c.req.json<{ sourceQuizId?: number; topic?: string; count?: number }>().catch(() => ({}) as never);
  const count = Math.min(MAX_QUESTIONS, Math.max(MIN_QUESTIONS, Math.round(Number(body.count) || DEFAULT_QUESTIONS)));

  const used = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM practice_exams WHERE student_id = ? COLLATE NOCASE AND created_at >= datetime('now', '-1 day')`,
  )
    .bind(studentId)
    .first<{ n: number }>();
  if ((used?.n ?? 0) >= MAX_EXAMS_PER_DAY) {
    return c.json({ status: 'error', message: `วันนี้สร้างข้อสอบครบ ${MAX_EXAMS_PER_DAY} ชุดแล้ว กรุณาลองใหม่พรุ่งนี้` }, 429);
  }

  // When generated from a lesson, feed Lilly that lesson's own material so the
  // exam tests what was taught rather than the topic in general.
  let lesson: string | null = null;
  let topic = (body.topic ?? '').trim().slice(0, MAX_TOPIC);
  const sourceQuizId = Number.isInteger(Number(body.sourceQuizId)) ? Number(body.sourceQuizId) : null;
  if (sourceQuizId) {
    const row = await c.env.DB.prepare(
      `SELECT title, title_th AS titleTh, lesson, lesson_th AS lessonTh
         FROM quizzes WHERE id = ? AND status = 'published'`,
    )
      .bind(sourceQuizId)
      .first<{ title: string; titleTh: string | null; lesson: string | null; lessonTh: string | null }>();
    if (!row) return c.json({ status: 'error', message: 'ไม่พบบทเรียน' }, 404);
    lesson = row.lessonTh || row.lesson;
    if (!topic) topic = row.titleTh || row.title;
  }
  if (!topic) return c.json({ status: 'error', message: 'กรุณาระบุหัวข้อที่ต้องการติว' }, 400);

  let questions: StoredQuestion[];
  try {
    questions = await generateQuestions(c.env, { topic, lesson, count });
  } catch (err) {
    if (err instanceof ChatNotConfiguredError) {
      return c.json({ status: 'error', message: 'โหมดติวสอบยังไม่พร้อมใช้งาน' }, 503);
    }
    console.error('practice exam generation failed', err);
    return c.json({ status: 'error', message: 'สร้างข้อสอบไม่สำเร็จ กรุณาลองใหม่' }, 502);
  }

  // A partial exam is worse than none: the learner would sit something shorter
  // than they asked for and score it out of a total that means nothing.
  if (questions.length < MIN_QUESTIONS) {
    return c.json({ status: 'error', message: 'สร้างข้อสอบไม่สำเร็จ กรุณาลองใหม่อีกครั้ง' }, 502);
  }

  const inserted = await c.env.DB.prepare(
    `INSERT INTO practice_exams (student_id, source_quiz_id, topic, questions, question_count)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(studentId, sourceQuizId, topic, JSON.stringify(questions), questions.length)
    .run();
  const id = Number(inserted.meta.last_row_id);
  await logAudit(c.env.DB, null, 'PRACTICE_EXAM_CREATE', studentId, String(id), true);

  return c.json({ status: 'success', exam: { id, topic, sourceQuizId, questionCount: questions.length }, questions: forStudent(questions) });
});

// Past exams and their scores — the history the chat-only version could not
// have kept.
practiceExams.get('/portal/:studentId/practice-exams', async (c) => {
  const studentId = c.req.param('studentId');
  if (!(await portalTokenMatchesStudent(c, studentId))) {
    return c.json({ status: 'error', message: 'Unauthorized' }, 401);
  }
  const member = await requireMember(c, studentId);
  const { results } = await c.env.DB.prepare(
    `SELECT id, topic, source_quiz_id AS sourceQuizId, question_count AS questionCount,
            score, max_score AS maxScore, submitted_at AS submittedAt, created_at AS createdAt
       FROM practice_exams WHERE student_id = ? COLLATE NOCASE
      ORDER BY id DESC LIMIT 100`,
  )
    .bind(studentId)
    .all();
  return c.json({ status: 'success', member, exams: results ?? [] });
});

// Reopen an unfinished exam. Answers still withheld.
practiceExams.get('/portal/:studentId/practice-exams/:examId', async (c) => {
  const studentId = c.req.param('studentId');
  const examId = Number(c.req.param('examId'));
  if (!(await portalTokenMatchesStudent(c, studentId))) {
    return c.json({ status: 'error', message: 'Unauthorized' }, 401);
  }
  const exam = await c.env.DB.prepare(
    `SELECT id, topic, source_quiz_id AS sourceQuizId, questions, question_count AS questionCount,
            score, max_score AS maxScore, submitted_at AS submittedAt
       FROM practice_exams WHERE id = ? AND student_id = ? COLLATE NOCASE`,
  )
    .bind(examId, studentId)
    .first<{ id: number; topic: string; sourceQuizId: number | null; questions: string; questionCount: number; score: number | null; maxScore: number | null; submittedAt: string | null }>();
  if (!exam) return c.json({ status: 'error', message: 'ไม่พบข้อสอบ' }, 404);

  const questions = parseJson<StoredQuestion[]>(exam.questions, []);
  return c.json({
    status: 'success',
    exam: {
      id: exam.id,
      topic: exam.topic,
      sourceQuizId: exam.sourceQuizId,
      questionCount: exam.questionCount,
      score: exam.score,
      maxScore: exam.maxScore,
      submittedAt: exam.submittedAt,
    },
    questions: forStudent(questions),
  });
});

// Submit and grade. The Worker marks it — never the model.
practiceExams.post('/portal/:studentId/practice-exams/:examId/submit', async (c) => {
  const studentId = c.req.param('studentId');
  const examId = Number(c.req.param('examId'));
  if (!(await portalTokenMatchesStudent(c, studentId))) {
    return c.json({ status: 'error', message: 'Unauthorized' }, 401);
  }
  const exam = await c.env.DB.prepare(
    `SELECT id, questions, submitted_at AS submittedAt FROM practice_exams WHERE id = ? AND student_id = ? COLLATE NOCASE`,
  )
    .bind(examId, studentId)
    .first<{ id: number; questions: string; submittedAt: string | null }>();
  if (!exam) return c.json({ status: 'error', message: 'ไม่พบข้อสอบ' }, 404);
  // One sitting per exam — generating a fresh one is the retake, and it is
  // also what makes the score history mean anything.
  if (exam.submittedAt) return c.json({ status: 'error', message: 'ข้อสอบชุดนี้ส่งไปแล้ว' }, 409);

  const body = await c.req.json<{ answers?: Record<string, unknown> }>().catch(() => ({}) as never);
  const submitted = body.answers ?? {};
  const questions = parseJson<StoredQuestion[]>(exam.questions, []);

  let score = 0;
  let maxScore = 0;
  const breakdown = questions.map((q) => {
    maxScore += q.points;
    // The same grader that marks a teacher's quiz, on the same row shape.
    const graded = gradeQuestion(q as unknown as QuestionRow, submitted[String(q.id)]);
    score += graded.earned;
    return {
      id: q.id,
      correct: graded.correct,
      earned: graded.earned,
      points: q.points,
      // Always detailed: only a member can reach this route at all, and the
      // explanation is the reason the mode exists.
      correctAnswer: parseJson<unknown>(q.answer, null),
      explanation: q.explanation,
    };
  });

  await c.env.DB.prepare(
    `UPDATE practice_exams SET answers = ?, score = ?, max_score = ?, submitted_at = CURRENT_TIMESTAMP WHERE id = ?`,
  )
    .bind(JSON.stringify(submitted).slice(0, 20_000), score, maxScore, examId)
    .run();
  await logAudit(c.env.DB, null, 'PRACTICE_EXAM_SUBMIT', studentId, String(examId), true);

  return c.json({
    status: 'success',
    score,
    maxScore,
    percent: maxScore > 0 ? Math.round((score / maxScore) * 100) : 0,
    breakdown,
  });
});
