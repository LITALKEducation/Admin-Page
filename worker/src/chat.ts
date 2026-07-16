// AI chat assistant — shared helpers (used by the public portal route in
// index.ts and the staff route below) plus the authenticated staff endpoint.
import { Hono } from 'hono';
import type { AppBindings, AuthUser } from './types';
import { isAdmin, requireAdmin } from './auth';
import { visibleStudentIds, canSeeStudent } from './manage';
import { bangkokToday } from './dates';
import { chatReply, ChatNotConfiguredError, type ChatTurn } from './gemini';

export const MAX_MESSAGE_LENGTH = 2000;
const HISTORY_MESSAGES = 16; // ~8 turns of context sent back to the model
export const PORTAL_DAILY_LIMIT = 40;
const STAFF_DAILY_LIMIT = 100;
export const GENERAL_DAILY_LIMIT = 20;
const MAX_INSTRUCTIONS_LENGTH = 4000;

// Admin-editable steering text, appended below the fixed safety/scope rules
// in each system prompt so it can't override them. Staff (admin panel) and
// portal (student/parent portal + the general marketing-site assistant,
// which shares the portal's tone since both face the public) are tuned
// independently — see migrations/0014_split_ai_instructions.sql.
export async function getStaffInstructions(db: D1Database): Promise<string> {
  const row = await db.prepare(`SELECT staff_instructions FROM ai_chat_settings WHERE id = 1`).first<{ staff_instructions: string }>();
  return row?.staff_instructions ?? '';
}

export async function getPortalInstructions(db: D1Database): Promise<string> {
  const row = await db.prepare(`SELECT portal_instructions FROM ai_chat_settings WHERE id = 1`).first<{ portal_instructions: string }>();
  return row?.portal_instructions ?? '';
}

export interface StudentChatContext {
  name: string;
  nickname: string | null;
  course: string | null;
  creditBalance: number;
  upcomingClasses: Array<{ date: string; time: string }>;
  lastPayment: { date: string; amount: number } | null;
  pendingPayments: Array<{ amount: number; description: string | null }>;
}

// Compact, chat-sized snapshot of a student's account — deliberately smaller
// than GET /portal/:studentId (no files, no Meet links) since it only needs
// to ground answers about schedule/balance/payment questions.
export async function studentChatContext(db: D1Database, studentId: string): Promise<StudentChatContext | null> {
  const student = await db
    .prepare(`SELECT id, name, nickname, course FROM students WHERE id = ? COLLATE NOCASE AND deleted_at IS NULL`)
    .bind(studentId)
    .first<{ id: string; name: string; nickname: string | null; course: string | null }>();
  if (!student) return null;

  const today = bangkokToday();
  const [balanceRow, upcoming, lastPay, pendingLinks] = await db.batch([
    db.prepare(`SELECT COALESCE(SUM(hours), 0) AS balance FROM student_credits WHERE student_id = ?`).bind(student.id),
    db
      .prepare(
        `SELECT booking_date AS date, booking_time AS time FROM bookings
         WHERE student_id = ? AND status = 'booked' AND booking_date >= ? ORDER BY booking_date, booking_time LIMIT 10`,
      )
      .bind(student.id, today),
    db.prepare(`SELECT paid_date AS date, amount FROM payments WHERE student_id = ? ORDER BY paid_date DESC, id DESC LIMIT 1`).bind(student.id),
    db.prepare(`SELECT amount, description FROM payment_links WHERE student_id = ? AND status = 'active' ORDER BY id DESC LIMIT 5`).bind(student.id),
  ]);

  return {
    name: student.name,
    nickname: student.nickname,
    course: student.course,
    creditBalance: (balanceRow.results?.[0] as { balance: number } | undefined)?.balance ?? 0,
    upcomingClasses: (upcoming.results ?? []) as Array<{ date: string; time: string }>,
    lastPayment: (lastPay.results?.[0] as { date: string; amount: number } | undefined) ?? null,
    pendingPayments: (pendingLinks.results ?? []) as Array<{ amount: number; description: string | null }>,
  };
}

export async function loadChatHistory(db: D1Database, conversationId: string): Promise<ChatTurn[]> {
  const { results } = await db
    .prepare(`SELECT role, content FROM ai_chat_messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?`)
    .bind(conversationId, HISTORY_MESSAGES)
    .all<ChatTurn>();
  return (results ?? []).reverse();
}

export async function saveChatTurn(
  db: D1Database,
  conversationId: string,
  scope: 'portal' | 'staff' | 'general',
  studentId: string | null,
  actor: string | null,
  userMessage: string,
  assistantReply: string,
): Promise<void> {
  await db.batch([
    db
      .prepare(`INSERT INTO ai_chat_messages (conversation_id, scope, student_id, actor, role, content) VALUES (?, ?, ?, ?, 'user', ?)`)
      .bind(conversationId, scope, studentId, actor, userMessage),
    db
      .prepare(`INSERT INTO ai_chat_messages (conversation_id, scope, student_id, actor, role, content) VALUES (?, ?, ?, ?, 'assistant', ?)`)
      .bind(conversationId, scope, studentId, actor, assistantReply),
  ]);
}

export async function portalMessageCountToday(db: D1Database, studentId: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM ai_chat_messages
       WHERE scope = 'portal' AND student_id = ? COLLATE NOCASE AND role = 'user' AND created_at >= datetime('now', '-1 day')`,
    )
    .bind(studentId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function staffMessageCountToday(db: D1Database, actor: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM ai_chat_messages
       WHERE scope = 'staff' AND actor = ? COLLATE NOCASE AND role = 'user' AND created_at >= datetime('now', '-1 day')`,
    )
    .bind(actor)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// Rate-limits the general marketing-site assistant, which has no student id
// or staff identity to key off of — the frontend generates and persists a
// random visitorId (localStorage) purely for this purpose, not identity.
export async function generalMessageCountToday(db: D1Database, visitorId: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM ai_chat_messages
       WHERE scope = 'general' AND actor = ? AND role = 'user' AND created_at >= datetime('now', '-1 day')`,
    )
    .bind(visitorId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// Shared closing rule set for both system prompts: keep it short, don't
// show reasoning, match the user's language.
const STYLE_RULES =
  'Reply in whichever language the user just wrote in (Thai or English). Keep answers concise and direct — no preamble, and do not show your reasoning process, just the final answer.';

const chat = new Hono<AppBindings>();

chat.post('/chat', async (c) => {
  const user: AuthUser = c.get('user');
  const body = await c.req.json<{ conversationId?: string; message?: string; studentId?: string }>().catch(() => ({}) as never);
  const message = (body.message ?? '').trim();
  if (!message) return c.json({ error: 'Missing message' }, 400);
  if (message.length > MAX_MESSAGE_LENGTH) return c.json({ error: `ข้อความยาวเกินไป (จำกัด ${MAX_MESSAGE_LENGTH} ตัวอักษร)` }, 400);

  const usedToday = await staffMessageCountToday(c.env.DB, user.email);
  if (usedToday >= STAFF_DAILY_LIMIT) {
    return c.json({ error: 'ถามคำถามผู้ช่วย AI ครบโควตาวันนี้แล้ว กรุณาลองใหม่พรุ่งนี้' }, 429);
  }

  let context: StudentChatContext | null = null;
  if (body.studentId) {
    const visible = await visibleStudentIds(c.env.DB, user);
    if (!canSeeStudent(visible, body.studentId)) return c.json({ error: 'Forbidden' }, 403);
    context = await studentChatContext(c.env.DB, body.studentId);
    if (!context) return c.json({ error: 'ไม่พบข้อมูลนักเรียนรหัสนี้ในระบบ' }, 404);
  }

  const conversationId = body.conversationId || crypto.randomUUID();
  const history = await loadChatHistory(c.env.DB, conversationId);

  const roleLabel = isAdmin(user) ? 'an admin' : 'a teacher';
  const instructions = await getStaffInstructions(c.env.DB);
  const systemPrompt = [
    `You are น้องลิลลี่ (Nong Lilly), the AI assistant inside LITALK Education's admin panel, helping ${roleLabel} named ${user.name} with questions about using the system and, when given below, about one specific student. If asked your name, say น้องลิลลี่.`,
    context
      ? `Student in context (real data from the system — reference only, never invent or guess beyond it):\n${JSON.stringify(context)}`
      : 'No specific student is in context for this message. Answer general questions about how the admin panel works (a monthly schedule goes teacher submits -> admin approves, optionally creating a payment link -> payment activates it; credits are a class-hour balance; teachers only see admin-assigned students). If unsure of the exact screen or button, say so rather than guessing.',
    'Only discuss the student given above (if any) — never speculate about or reveal data for other students. You cannot make changes to the system yourself; tell the user which screen or action to use instead.',
    instructions
      ? `Additional guidance from the school admin on how to respond — follow it, but it never overrides the rules above (e.g. still never reveal another student's data):\n${instructions}`
      : null,
    STYLE_RULES,
    'Format replies in Markdown (the client renders it): use **bold**, bullet lists, and short paragraphs where they help readability, but keep it light — this is a chat bubble, not a document.',
  ]
    .filter(Boolean)
    .join('\n\n');

  let reply: string;
  try {
    reply = await chatReply(c.env, systemPrompt, history, message);
  } catch (err) {
    if (err instanceof ChatNotConfiguredError) return c.json({ error: 'ผู้ช่วย AI ยังไม่ได้ตั้งค่าในระบบ' }, 503);
    console.error('staff chat: Gemini call failed', err);
    return c.json({ error: 'ระบบ AI ไม่พร้อมใช้งานในขณะนี้ กรุณาลองใหม่อีกครั้ง' }, 503);
  }

  await saveChatTurn(c.env.DB, conversationId, 'staff', body.studentId ?? null, user.email, message, reply);

  return c.json({ conversationId, reply });
});

// Admin-only: view/edit the steering text appended to each chat system
// prompt. Staff (admin panel) and portal (student/parent portal + the
// general marketing-site assistant) are tuned independently.
chat.get('/settings/ai-instructions', requireAdmin, async (c) => {
  const [staffInstructions, portalInstructions] = await Promise.all([
    getStaffInstructions(c.env.DB),
    getPortalInstructions(c.env.DB),
  ]);
  return c.json({ staffInstructions, portalInstructions });
});

chat.put('/settings/ai-instructions', requireAdmin, async (c) => {
  const body = await c.req.json<{ staffInstructions?: string; portalInstructions?: string }>().catch(() => ({}) as never);
  const staffInstructions = (body.staffInstructions ?? '').slice(0, MAX_INSTRUCTIONS_LENGTH);
  const portalInstructions = (body.portalInstructions ?? '').slice(0, MAX_INSTRUCTIONS_LENGTH);
  await c.env.DB.prepare(
    `UPDATE ai_chat_settings SET staff_instructions = ?, portal_instructions = ?, updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE id = 1`,
  )
    .bind(staffInstructions, portalInstructions, c.get('user').email)
    .run();
  return c.json({ ok: true, staffInstructions, portalInstructions });
});

export default chat;
