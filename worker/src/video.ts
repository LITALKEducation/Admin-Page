// Lesson videos hosted in R2 (worker/migrations/0032).
//
// Two things make this more than "upload a file, serve a file":
//
//   * A Worker request body is capped at ~100 MB, and a lesson recording is
//     routinely bigger. So the admin panel does not POST the file — it drives
//     an R2 MULTIPART upload part by part, and each part is its own small
//     request. start → part × N → complete, with abort for a cancelled or
//     failed run so R2 does not keep the orphaned parts.
//
//   * A <video src> cannot send an Authorization header, so the stream
//     endpoint has to authenticate from the URL. The portal asks for a
//     short-lived ticket over the normal authenticated API — that call is
//     where ownership and the course sequencing gate are checked — and plays
//     a URL carrying it. See TICKET_TTL_MS below.
//
// Serving is Range-aware. Without a 206 the browser cannot seek: Safari in
// particular will not play a video at all from an endpoint that ignores
// Range, so serveObject() below is the load-bearing half of playback.
import { Hono } from 'hono';
import type { AppBindings, AuthUser } from './types';
import { isAdmin, portalTokenMatchesStudent } from './auth';
import { logAudit, extname } from './db';
import { courseGateForQuiz } from './courses';

// Part size the admin panel is told to use. R2 requires every part except the
// last to be the same size and at least 5 MiB; 10 MiB keeps each request well
// under the Worker body cap on every plan while staying inside the 10,000-part
// limit for anything up to MAX_VIDEO_BYTES.
export const PART_SIZE = 10 * 1024 * 1024;
const MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB
const MAX_PARTS = Math.ceil(MAX_VIDEO_BYTES / PART_SIZE);

// Long enough for any lesson plus a pause for lunch, short enough that a
// copied URL is dead the same day. The ticket is re-minted every time the
// lesson page opens, so this is a ceiling on a leak, not a session length.
const TICKET_TTL_MS = 4 * 60 * 60 * 1000;

// Containers a browser can actually play. Deliberately narrow: an .avi or
// .mkv uploads happily and then plays for nobody, which is a worse failure
// than being told at upload time.
const ALLOWED_MIME = new Set(['video/mp4', 'video/webm', 'video/ogg', 'video/quicktime']);

interface QuizVideoRow {
  id: number;
  authorIdentity: string;
  videoKey: string | null;
  videoMime: string | null;
  videoSize: number | null;
  videoName: string | null;
}

const VIDEO_FIELDS = `id, author_identity AS authorIdentity, video_key AS videoKey,
  video_mime AS videoMime, video_size AS videoSize, video_name AS videoName`;

function canEdit(user: AuthUser, quiz: { authorIdentity?: string }): boolean {
  return isAdmin(user) || (quiz.authorIdentity ?? '').toLowerCase() === user.email.toLowerCase();
}

// Parse a single-range `bytes=` header against a known object size. Returns
// null for "no range asked for", and 'invalid' for a range that cannot be
// satisfied (which must answer 416, not 200 — a browser that gets a 200 for
// an out-of-range request tends to restart the download in a loop).
function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | 'invalid' {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return 'invalid';
  const [, rawStart, rawEnd] = m;
  if (rawStart === '' && rawEnd === '') return 'invalid';

  // `bytes=-500` is the LAST 500 bytes, not the first 500. Getting this
  // backwards serves the wrong bytes with a plausible-looking 206.
  if (rawStart === '') {
    const suffix = Number(rawEnd);
    if (!suffix) return 'invalid';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(rawStart);
  if (start >= size) return 'invalid';
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (end < start) return 'invalid';
  return { start, end };
}

// Serve an R2 object honouring Range. Shared by the admin preview and the
// student stream so seeking behaves identically in both.
async function serveObject(bucket: R2Bucket, key: string, mime: string | null, rangeHeader: string | undefined): Promise<Response> {
  const head = await bucket.head(key);
  if (!head) return new Response('Not found', { status: 404 });

  const range = parseRange(rangeHeader, head.size);
  if (range === 'invalid') {
    return new Response('Range not satisfiable', {
      status: 416,
      headers: { 'Content-Range': `bytes */${head.size}`, 'Accept-Ranges': 'bytes' },
    });
  }

  const contentType = mime || head.httpMetadata?.contentType || 'video/mp4';
  // private: this is one student's lesson, and the URL carries a ticket that
  // outlives no shared cache we would want it sitting in.
  const base: Record<string, string> = {
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=0, no-store',
    // Belt and braces against a save-as: the response is for playback.
    'Content-Disposition': 'inline',
  };

  if (!range) {
    const object = await bucket.get(key);
    if (!object) return new Response('Not found', { status: 404 });
    return new Response(object.body, { headers: { ...base, 'Content-Length': String(head.size) } });
  }

  const length = range.end - range.start + 1;
  const object = await bucket.get(key, { range: { offset: range.start, length } });
  if (!object) return new Response('Not found', { status: 404 });
  return new Response((object as R2ObjectBody).body, {
    status: 206,
    headers: {
      ...base,
      'Content-Length': String(length),
      'Content-Range': `bytes ${range.start}-${range.end}/${head.size}`,
    },
  });
}

/* ===================== Admin routes (after verifyAuth) ===================== */

export const video = new Hono<AppBindings>();

async function loadQuiz(c: { env: { DB: D1Database } }, id: number): Promise<QuizVideoRow | null> {
  return c.env.DB.prepare(`SELECT ${VIDEO_FIELDS} FROM quizzes WHERE id = ?`).bind(id).first<QuizVideoRow>();
}

// Begin a multipart upload. Answers with the key + uploadId the panel then
// quotes on every part, and the part size it must cut the file into.
video.post('/quizzes/:id/video/uploads', async (c) => {
  const user = c.get('user');
  const id = Number(c.req.param('id'));
  const quiz = await loadQuiz(c, id);
  if (!quiz) return c.json({ error: 'ไม่พบแบบทดสอบ' }, 404);
  if (!canEdit(user, quiz)) return c.json({ error: 'Forbidden' }, 403);

  const body = await c.req.json<{ name?: string; mime?: string; size?: number }>().catch(() => ({}) as never);
  const mime = (body.mime ?? '').split(';')[0].trim().toLowerCase();
  const size = Number(body.size);
  if (!ALLOWED_MIME.has(mime)) return c.json({ error: 'รองรับเฉพาะไฟล์ MP4, WebM, OGG หรือ MOV' }, 400);
  if (!Number.isFinite(size) || size <= 0) return c.json({ error: 'ขนาดไฟล์ไม่ถูกต้อง' }, 400);
  if (size > MAX_VIDEO_BYTES) return c.json({ error: 'ไฟล์ใหญ่เกินไป (สูงสุด 2 GB)' }, 400);

  const key = `quiz/videos/${id}-${crypto.randomUUID()}${extname(body.name ?? '') || '.mp4'}`;
  const upload = await c.env.BUCKET.createMultipartUpload(key, { httpMetadata: { contentType: mime } });
  return c.json({ ok: true, key, uploadId: upload.uploadId, partSize: PART_SIZE });
});

// One part. The body is the raw slice — not form data — so nothing has to
// buffer a second copy of it to parse a multipart envelope.
video.put('/quizzes/:id/video/uploads/:uploadId/parts/:partNumber', async (c) => {
  const user = c.get('user');
  const id = Number(c.req.param('id'));
  const quiz = await loadQuiz(c, id);
  if (!quiz) return c.json({ error: 'ไม่พบแบบทดสอบ' }, 404);
  if (!canEdit(user, quiz)) return c.json({ error: 'Forbidden' }, 403);

  const key = c.req.query('key') ?? '';
  const partNumber = Number(c.req.param('partNumber'));
  // The key comes from the client, so confirm it is one we minted for THIS
  // quiz before writing to it — otherwise a part could be pushed into any
  // path in the bucket.
  if (!key.startsWith(`quiz/videos/${id}-`)) return c.json({ error: 'คีย์ไฟล์ไม่ถูกต้อง' }, 400);
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > MAX_PARTS) {
    return c.json({ error: 'ลำดับส่วนไฟล์ไม่ถูกต้อง' }, 400);
  }
  // Buffered rather than streamed: R2 needs a part's length up front, and a
  // request stream does not reliably carry one. PART_SIZE is 10 MiB, well
  // inside a Worker's memory, which is what keeps this affordable.
  const bytes = await c.req.arrayBuffer();
  if (bytes.byteLength === 0) return c.json({ error: 'ไม่พบข้อมูล' }, 400);
  if (bytes.byteLength > PART_SIZE) return c.json({ error: 'ส่วนไฟล์ใหญ่เกินกำหนด' }, 400);

  const upload = c.env.BUCKET.resumeMultipartUpload(key, c.req.param('uploadId'));
  try {
    const part = await upload.uploadPart(partNumber, bytes);
    return c.json({ ok: true, partNumber: part.partNumber, etag: part.etag });
  } catch {
    return c.json({ error: 'อัปโหลดส่วนไฟล์ไม่สำเร็จ' }, 502);
  }
});

// Seal the upload and point the quiz at it. The previous video, if any, is
// deleted only after the row is updated — an orphaned object costs storage,
// a row pointing at a deleted object costs the lesson.
video.post('/quizzes/:id/video/uploads/:uploadId/complete', async (c) => {
  const user = c.get('user');
  const id = Number(c.req.param('id'));
  const quiz = await loadQuiz(c, id);
  if (!quiz) return c.json({ error: 'ไม่พบแบบทดสอบ' }, 404);
  if (!canEdit(user, quiz)) return c.json({ error: 'Forbidden' }, 403);

  const body = await c.req
    .json<{ key?: string; parts?: { partNumber: number; etag: string }[]; name?: string; mime?: string }>()
    .catch(() => ({}) as never);
  const key = body.key ?? '';
  if (!key.startsWith(`quiz/videos/${id}-`)) return c.json({ error: 'คีย์ไฟล์ไม่ถูกต้อง' }, 400);
  const parts = (body.parts ?? [])
    .map((p) => ({ partNumber: Number(p.partNumber), etag: String(p.etag ?? '') }))
    .filter((p) => Number.isInteger(p.partNumber) && p.partNumber >= 1 && p.etag);
  if (parts.length === 0) return c.json({ error: 'ไม่พบส่วนไฟล์' }, 400);
  parts.sort((a, b) => a.partNumber - b.partNumber);

  const upload = c.env.BUCKET.resumeMultipartUpload(key, c.req.param('uploadId'));
  let object: R2Object;
  try {
    object = await upload.complete(parts);
  } catch {
    await logAudit(c.env.DB, user, 'QUIZ_VIDEO_UPLOAD', null, String(id), false);
    return c.json({ error: 'รวมไฟล์ไม่สำเร็จ กรุณาอัปโหลดใหม่' }, 502);
  }

  const mime = (body.mime ?? '').split(';')[0].trim().toLowerCase();
  await c.env.DB.prepare(
    `UPDATE quizzes SET video_key = ?, video_mime = ?, video_size = ?, video_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
  )
    .bind(key, ALLOWED_MIME.has(mime) ? mime : 'video/mp4', object.size, (body.name ?? '').slice(0, 300) || null, id)
    .run();
  if (quiz.videoKey && quiz.videoKey !== key) await c.env.BUCKET.delete(quiz.videoKey).catch(() => {});
  await logAudit(c.env.DB, user, 'QUIZ_VIDEO_UPLOAD', null, String(id), true);

  return c.json({ ok: true, size: object.size, name: body.name ?? null, mime });
});

// Cancel: R2 keeps the uploaded parts (and bills for them) until told not to.
video.post('/quizzes/:id/video/uploads/:uploadId/abort', async (c) => {
  const user = c.get('user');
  const id = Number(c.req.param('id'));
  const quiz = await loadQuiz(c, id);
  if (!quiz) return c.json({ error: 'ไม่พบแบบทดสอบ' }, 404);
  if (!canEdit(user, quiz)) return c.json({ error: 'Forbidden' }, 403);

  const key = c.req.query('key') ?? '';
  if (!key.startsWith(`quiz/videos/${id}-`)) return c.json({ error: 'คีย์ไฟล์ไม่ถูกต้อง' }, 400);
  await c.env.BUCKET.resumeMultipartUpload(key, c.req.param('uploadId')).abort().catch(() => {});
  return c.json({ ok: true });
});

// Remove the video from the lesson. Tickets already issued are dropped too,
// so playback stops now rather than when they expire.
video.delete('/quizzes/:id/video', async (c) => {
  const user = c.get('user');
  const id = Number(c.req.param('id'));
  const quiz = await loadQuiz(c, id);
  if (!quiz) return c.json({ error: 'ไม่พบแบบทดสอบ' }, 404);
  if (!canEdit(user, quiz)) return c.json({ error: 'Forbidden' }, 403);
  if (!quiz.videoKey) return c.json({ ok: true });

  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE quizzes SET video_key = NULL, video_mime = NULL, video_size = NULL, video_name = NULL,
       updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    ).bind(id),
    c.env.DB.prepare(`DELETE FROM quiz_video_tickets WHERE quiz_id = ?`).bind(id),
  ]);
  await c.env.BUCKET.delete(quiz.videoKey).catch(() => {});
  await logAudit(c.env.DB, user, 'QUIZ_VIDEO_DELETE', null, String(id), true);
  return c.json({ ok: true });
});

// Admin preview. Same Range handling as the student stream — an author who
// cannot scrub through what they just uploaded has not really checked it.
// Reached with a fetch + Authorization, so no ticket is involved.
video.get('/quizzes/:id/video', async (c) => {
  const user = c.get('user');
  const id = Number(c.req.param('id'));
  const quiz = await loadQuiz(c, id);
  if (!quiz) return c.json({ error: 'ไม่พบแบบทดสอบ' }, 404);
  if (!canEdit(user, quiz)) return c.json({ error: 'Forbidden' }, 403);
  if (!quiz.videoKey) return c.json({ error: 'No video' }, 404);
  return serveObject(c.env.BUCKET, quiz.videoKey, quiz.videoMime, c.req.header('Range'));
});

/* ===================== Portal routes (before verifyAuth) ===================== */

export const videoPortal = new Hono<AppBindings>();

// Mint a playback ticket. This is the route that checks anything: the caller
// owns the student id, the quiz is published, it has a file, and the course
// sequencing gate lets this student at it. The stream endpoint below then
// only has to check the ticket.
videoPortal.post('/portal/:studentId/quizzes/:quizId/video-ticket', async (c) => {
  const studentId = c.req.param('studentId');
  const quizId = Number(c.req.param('quizId'));
  if (!(await portalTokenMatchesStudent(c, studentId))) {
    return c.json({ status: 'error', message: 'Unauthorized' }, 401);
  }
  const quiz = await c.env.DB.prepare(`SELECT video_key AS videoKey FROM quizzes WHERE id = ? AND status = 'published'`)
    .bind(quizId)
    .first<{ videoKey: string | null }>();
  if (!quiz?.videoKey) return c.json({ status: 'error', message: 'ไม่พบวีดีโอ' }, 404);

  const gate = await courseGateForQuiz(c.env.DB, quizId, studentId);
  if (!gate.allowed) {
    return c.json({ status: 'error', message: gate.message, courseId: gate.courseId, reason: gate.reason, locked: true }, 403);
  }

  const token = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
  const expiresAt = new Date(Date.now() + TICKET_TTL_MS).toISOString();
  await c.env.DB.batch([
    // Replace rather than accumulate: one row per student per lesson, and
    // reopening the page invalidates the URL the last one was in.
    c.env.DB.prepare(`DELETE FROM quiz_video_tickets WHERE quiz_id = ? AND student_id = ? COLLATE NOCASE`).bind(quizId, studentId),
    c.env.DB.prepare(`INSERT INTO quiz_video_tickets (token, quiz_id, student_id, expires_at) VALUES (?, ?, ?, ?)`)
      .bind(token, quizId, studentId, expiresAt),
  ]);
  return c.json({ status: 'success', token, expiresAt });
});

// The stream itself. Authenticated by the ticket in the query string, because
// this URL goes into a <video src> where no header can be attached.
//
// The sequencing gate is NOT re-run here: it was checked when the ticket was
// issued, and a student who has legitimately opened a lesson should be able
// to finish watching it. Re-running it would also put four D1 queries on
// every Range request, of which a single seek makes several.
videoPortal.get('/portal/:studentId/quizzes/:quizId/video', async (c) => {
  const studentId = c.req.param('studentId');
  const quizId = Number(c.req.param('quizId'));
  const token = c.req.query('t') ?? '';
  if (!token) return c.json({ status: 'error', message: 'Unauthorized' }, 401);

  const ticket = await c.env.DB.prepare(
    `SELECT expires_at AS expiresAt FROM quiz_video_tickets
     WHERE token = ? AND quiz_id = ? AND student_id = ? COLLATE NOCASE`,
  )
    .bind(token, quizId, studentId)
    .first<{ expiresAt: string }>();
  if (!ticket) return c.json({ status: 'error', message: 'Unauthorized' }, 401);
  if (new Date(ticket.expiresAt).getTime() < Date.now()) {
    await c.env.DB.prepare(`DELETE FROM quiz_video_tickets WHERE token = ?`).bind(token).run();
    return c.json({ status: 'error', message: 'ลิงก์วีดีโอหมดอายุ กรุณาโหลดหน้าใหม่' }, 401);
  }

  const quiz = await c.env.DB.prepare(
    `SELECT video_key AS videoKey, video_mime AS videoMime FROM quizzes WHERE id = ? AND status = 'published'`,
  )
    .bind(quizId)
    .first<{ videoKey: string | null; videoMime: string | null }>();
  if (!quiz?.videoKey) return c.json({ status: 'error', message: 'ไม่พบวีดีโอ' }, 404);
  return serveObject(c.env.BUCKET, quiz.videoKey, quiz.videoMime, c.req.header('Range'));
});

// Called from the daily cron alongside the other sweeps: expired tickets are
// dead weight, and nothing else deletes them (a student who never returns
// leaves their last one behind).
export async function purgeExpiredVideoTickets(db: D1Database): Promise<void> {
  await db.prepare(`DELETE FROM quiz_video_tickets WHERE expires_at < ?`).bind(new Date().toISOString()).run();
}
