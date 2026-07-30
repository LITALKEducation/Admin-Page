// Lesson slides as downloadable PDFs (worker/migrations/0034) — a LITALK+
// benefit, and the "คลังสไลด์" of the tier list.
//
// Deliberately much simpler than video.ts, because none of what made that
// module complicated applies here:
//
//   * No multipart upload. A slide deck fits inside a Worker request body,
//     so this is one formData POST like the course cover.
//   * No Range serving. A PDF is fetched whole, not seeked.
//   * No playback ticket. A download goes through an ordinary authenticated
//     fetch — nothing has to survive being put in an element's src, which is
//     the only reason the video stream needed a ticket at all.
//
// Access is the one thing it does share: the same course gate as the lesson
// it belongs to, plus membership. Both are checked server-side; the portal
// hides the button as presentation, not as enforcement.
import { Hono } from 'hono';
import type { AppBindings, AuthUser } from './types';
import { isAdmin, portalTokenMatchesStudent } from './auth';
import { logAudit, extname } from './db';
import { courseGateForQuiz } from './courses';
import { isPlusMember } from './plus';

// Comfortably inside the Worker body cap, and large for a slide deck. A file
// past this is usually an export with uncompressed images in it.
const MAX_SLIDE_BYTES = 40 * 1024 * 1024; // 40 MB

// PDF only. "ดาวน์โหลดเป็น PDF" is the promise, and accepting a .pptx would
// mean half the learners cannot open what they downloaded on a phone.
const ALLOWED_MIME = 'application/pdf';

interface QuizSlideRow {
  id: number;
  authorIdentity: string;
  slideKey: string | null;
  slideMime: string | null;
  slideName: string | null;
}

function canEdit(user: AuthUser, quiz: { authorIdentity?: string }): boolean {
  return isAdmin(user) || (quiz.authorIdentity ?? '').toLowerCase() === user.email.toLowerCase();
}

async function loadQuiz(db: D1Database, id: number): Promise<QuizSlideRow | null> {
  return db
    .prepare(
      `SELECT id, author_identity AS authorIdentity, slide_key AS slideKey,
              slide_mime AS slideMime, slide_name AS slideName
         FROM quizzes WHERE id = ?`,
    )
    .bind(id)
    .first<QuizSlideRow>();
}

// Content-Disposition with a filename that may be Thai. The plain filename=
// parameter is ASCII-only, so a UTF-8 name goes in filename*= and the ASCII
// slot gets a stripped fallback — without both, some browsers save the file
// with a mangled name and others reject the header outright.
function downloadHeaders(name: string | null, mime: string | null): Record<string, string> {
  const safe = (name || 'slides.pdf').replace(/["\\]/g, '');
  const ascii = safe.replace(/[^\x20-\x7E]/g, '_') || 'slides.pdf';
  return {
    'Content-Type': mime || ALLOWED_MIME,
    'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`,
    'Cache-Control': 'private, no-store',
  };
}

/* ===================== Admin routes (after verifyAuth) ===================== */

export const slides = new Hono<AppBindings>();

// Upload / replace a lesson's slide deck. One POST — see the module note.
slides.post('/quizzes/:id/slides', async (c) => {
  const user = c.get('user');
  const id = Number(c.req.param('id'));
  const quiz = await loadQuiz(c.env.DB, id);
  if (!quiz) return c.json({ error: 'ไม่พบแบบทดสอบ' }, 404);
  if (!canEdit(user, quiz)) return c.json({ error: 'Forbidden' }, 403);

  const form = await c.req.formData();
  const file = form.get('file') as unknown as File | string | null;
  if (typeof file === 'string' || file === null) return c.json({ error: 'ไม่พบไฟล์' }, 400);
  if ((file.type || '').split(';')[0].trim().toLowerCase() !== ALLOWED_MIME) {
    return c.json({ error: 'รองรับเฉพาะไฟล์ PDF' }, 400);
  }
  if (file.size > MAX_SLIDE_BYTES) return c.json({ error: 'ไฟล์ใหญ่เกินไป (สูงสุด 40 MB)' }, 400);

  const key = `quiz/slides/${id}-${crypto.randomUUID()}${extname(file.name) || '.pdf'}`;
  await c.env.BUCKET.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: ALLOWED_MIME } });
  await c.env.DB.prepare(
    `UPDATE quizzes SET slide_key = ?, slide_mime = ?, slide_size = ?, slide_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
  )
    .bind(key, ALLOWED_MIME, file.size, (file.name || '').slice(0, 300) || null, id)
    .run();
  // Only after the row points at the new object: an orphan costs storage, a
  // row pointing at a deleted object costs the lesson.
  if (quiz.slideKey && quiz.slideKey !== key) await c.env.BUCKET.delete(quiz.slideKey).catch(() => {});
  await logAudit(c.env.DB, user, 'QUIZ_SLIDES_UPLOAD', null, String(id), true);
  return c.json({ ok: true, name: file.name, size: file.size });
});

slides.delete('/quizzes/:id/slides', async (c) => {
  const user = c.get('user');
  const id = Number(c.req.param('id'));
  const quiz = await loadQuiz(c.env.DB, id);
  if (!quiz) return c.json({ error: 'ไม่พบแบบทดสอบ' }, 404);
  if (!canEdit(user, quiz)) return c.json({ error: 'Forbidden' }, 403);
  if (!quiz.slideKey) return c.json({ ok: true });

  await c.env.DB.prepare(
    `UPDATE quizzes SET slide_key = NULL, slide_mime = NULL, slide_size = NULL, slide_name = NULL,
     updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
  )
    .bind(id)
    .run();
  await c.env.BUCKET.delete(quiz.slideKey).catch(() => {});
  await logAudit(c.env.DB, user, 'QUIZ_SLIDES_DELETE', null, String(id), true);
  return c.json({ ok: true });
});

// Author preview — the same file the learner would get, so "check what you
// uploaded" does not mean "publish and hope".
slides.get('/quizzes/:id/slides', async (c) => {
  const user = c.get('user');
  const id = Number(c.req.param('id'));
  const quiz = await loadQuiz(c.env.DB, id);
  if (!quiz) return c.json({ error: 'ไม่พบแบบทดสอบ' }, 404);
  if (!canEdit(user, quiz)) return c.json({ error: 'Forbidden' }, 403);
  if (!quiz.slideKey) return c.json({ error: 'No slides' }, 404);
  const object = await c.env.BUCKET.get(quiz.slideKey);
  if (!object) return c.json({ error: 'Not found' }, 404);
  return new Response(object.body, { headers: downloadHeaders(quiz.slideName, quiz.slideMime) });
});

/* ===================== Portal routes (before verifyAuth) ===================== */

export const slidesPortal = new Hono<AppBindings>();

// The library: every lesson this learner can reach that has slides. Members
// only — it is the benefit itself, so a non-member gets an empty list and the
// `member` flag rather than a 403, which lets the portal render the pitch
// instead of an error.
slidesPortal.get('/portal/:studentId/slides', async (c) => {
  const studentId = c.req.param('studentId');
  if (!(await portalTokenMatchesStudent(c, studentId))) {
    return c.json({ status: 'error', message: 'Unauthorized' }, 401);
  }
  const member = await isPlusMember(c.env.DB, studentId);
  if (!member) return c.json({ status: 'success', member: false, slides: [] });

  // Published lessons with a deck, annotated with the course they belong to.
  // The per-lesson course gate still runs on download; this list is what the
  // learner may SEE, and a locked lesson's slides are not a secret worth
  // hiding the title of.
  const { results } = await c.env.DB.prepare(
    `SELECT q.id AS quizId, q.title, q.title_th AS titleTh, q.slide_name AS slideName,
            q.slide_size AS slideSize, ci.course_id AS courseId,
            COALESCE(c.title_th, c.title) AS courseTitle
       FROM quizzes q
       LEFT JOIN course_items ci ON ci.quiz_id = q.id
       LEFT JOIN courses c ON c.id = ci.course_id
      WHERE q.status = 'published' AND q.slide_key IS NOT NULL
      ORDER BY c.title IS NULL, c.title, q.id LIMIT 500`,
  ).all();
  return c.json({ status: 'success', member: true, slides: results ?? [] });
});

// Download one deck. Gated on all three: the caller owns the student id, the
// course sequencing gate lets them at the lesson, and they are a member.
slidesPortal.get('/portal/:studentId/quizzes/:quizId/slides', async (c) => {
  const studentId = c.req.param('studentId');
  const quizId = Number(c.req.param('quizId'));
  if (!(await portalTokenMatchesStudent(c, studentId))) {
    return c.json({ status: 'error', message: 'Unauthorized' }, 401);
  }

  const quiz = await c.env.DB.prepare(
    `SELECT slide_key AS slideKey, slide_mime AS slideMime, slide_name AS slideName
       FROM quizzes WHERE id = ? AND status = 'published'`,
  )
    .bind(quizId)
    .first<{ slideKey: string | null; slideMime: string | null; slideName: string | null }>();
  if (!quiz?.slideKey) return c.json({ status: 'error', message: 'ไม่พบสไลด์' }, 404);

  if (!(await isPlusMember(c.env.DB, studentId))) {
    // 402 rather than 403: this is not "you may never", it is "this needs a
    // membership", and the portal keys its upgrade prompt off the difference.
    return c.json({ status: 'error', message: 'สไลด์บทเรียนเป็นสิทธิ์ของสมาชิก LITALK+', requiresPlus: true }, 402);
  }

  const gate = await courseGateForQuiz(c.env.DB, quizId, studentId);
  if (!gate.allowed) {
    return c.json({ status: 'error', message: gate.message, courseId: gate.courseId, reason: gate.reason, locked: true }, 403);
  }

  const object = await c.env.BUCKET.get(quiz.slideKey);
  if (!object) return c.json({ status: 'error', message: 'ไม่พบสไลด์' }, 404);
  return new Response(object.body, { headers: downloadHeaders(quiz.slideName, quiz.slideMime) });
});
