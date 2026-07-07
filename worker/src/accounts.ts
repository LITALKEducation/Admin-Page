// Account management: student profile/avatar/credential edits, and
// in-app creation/editing of teacher & staff login accounts. All routes
// here are admin-only (account-level changes, not day-to-day data entry).

import { Hono } from 'hono';
import type { AppBindings } from './types';
import { requireAdmin } from './auth';
import { logAudit } from './db';
import { visibleStudentIds, canSeeStudent } from './manage';
import {
  findAuth0UserByEmail,
  updateAuth0User,
  createStaffAuth0User,
  assignAuth0Role,
  createPasswordChangeTicket,
  createGuardianEnrollmentTicket,
  generateTempPassword,
} from './auth0mgmt';

const accounts = new Hono<AppBindings>();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function extOf(filename: string): string {
  const idx = filename.lastIndexOf('.');
  return idx === -1 ? '' : filename.slice(idx).toLowerCase();
}

// ===== Students: profile, avatar, credentials =====

// Resolves (and caches) a student's Auth0 user id from the login email
// convention (`<id>@STUDENT_EMAIL_DOMAIN`) used at creation time.
async function resolveStudentAuth0Id(c: import('hono').Context<AppBindings>, studentId: string, cached: string | null): Promise<string | null> {
  if (cached) return cached;
  if (!c.env.AUTH0_MGMT_CLIENT_ID || !c.env.AUTH0_MGMT_CLIENT_SECRET) return null;
  const email = `${studentId.toLowerCase()}@${c.env.STUDENT_EMAIL_DOMAIN}`;
  const user = await findAuth0UserByEmail(c.env, email).catch(() => null);
  if (!user) return null;
  await c.env.DB.prepare(`UPDATE students SET auth0_user_id = ? WHERE id = ?`).bind(user.userId, studentId).run();
  return user.userId;
}

accounts.patch('/students/:id', requireAdmin, async (c) => {
  const studentId = c.req.param('id');
  if (!studentId) return c.json({ error: 'Missing student id' }, 400);
  const user = c.get('user');
  const body = await c.req.json<{
    name?: string;
    nickname?: string;
    email?: string;
    phone?: string;
    course?: string;
    username?: string;
    password?: string;
  }>();

  const student = await c.env.DB.prepare(`SELECT id, name, auth0_user_id AS auth0UserId FROM students WHERE id = ? AND deleted_at IS NULL`)
    .bind(studentId)
    .first<{ id: string; name: string; auth0UserId: string | null }>();
  if (!student) return c.json({ error: 'ไม่พบนักเรียนรหัสนี้ในระบบ' }, 404);

  if (body.email !== undefined && body.email !== '' && !EMAIL_RE.test(body.email)) {
    return c.json({ error: 'รูปแบบอีเมลไม่ถูกต้อง' }, 400);
  }
  if (body.name !== undefined && !body.name.trim()) return c.json({ error: 'กรุณากรอกชื่อ' }, 400);

  const sets: string[] = [];
  const binds: unknown[] = [];
  if (body.name !== undefined) { sets.push('name = ?'); binds.push(body.name.trim()); }
  if (body.nickname !== undefined) { sets.push('nickname = ?'); binds.push(body.nickname || null); }
  if (body.email !== undefined) { sets.push('email = ?'); binds.push(body.email || null); }
  if (body.phone !== undefined) { sets.push('phone = ?'); binds.push(body.phone || null); }
  if (body.course !== undefined) { sets.push('course = ?'); binds.push(body.course || null); }
  if (sets.length) {
    binds.push(studentId);
    await c.env.DB.prepare(`UPDATE students SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
  }

  // Credential fields (username / password) touch the student's Auth0
  // login account, not just the D1 row. Skipped entirely if the Management
  // API isn't configured (matches the graceful-degradation pattern used at
  // student creation) or the account can't be resolved.
  let credentials: { password?: string } | null = null;
  const wantsAuth0Update = body.username !== undefined || body.password !== undefined || body.name !== undefined;
  if (wantsAuth0Update && c.env.AUTH0_MGMT_CLIENT_ID && c.env.AUTH0_MGMT_CLIENT_SECRET) {
    const auth0Id = await resolveStudentAuth0Id(c, studentId, student.auth0UserId);
    if (auth0Id) {
      try {
        await updateAuth0User(c.env, auth0Id, {
          name: body.name !== undefined ? body.name.trim() : undefined,
          username: body.username !== undefined ? body.username.trim() || undefined : undefined,
          password: body.password !== undefined && body.password ? body.password : undefined,
        });
        if (body.password) credentials = { password: body.password };
      } catch (err) {
        await logAudit(c.env.DB, user, 'EDIT_STUDENT_AUTH0_FAILED', studentId, null, false);
        return c.json({ error: `แก้ไขข้อมูลนักเรียนสำเร็จ แต่แก้ไขบัญชีเข้าสู่ระบบไม่สำเร็จ: ${err instanceof Error ? err.message : 'Auth0 error'}` }, 502);
      }
    } else if (body.username !== undefined || body.password !== undefined) {
      return c.json({ error: 'ไม่พบบัญชีเข้าสู่ระบบของนักเรียนใน Auth0 (ตั้งค่า Auth0 Management API หรือสร้างบัญชีก่อน)' }, 409);
    }
  }

  await logAudit(c.env.DB, user, 'EDIT_STUDENT', studentId, null, true);
  return c.json({ ok: true, message: 'บันทึกข้อมูลนักเรียนสำเร็จ', credentials });
});

// Generates (or sets, if the admin supplies one) a new password for the
// student's login account, returned once for the admin to hand over.
accounts.post('/students/:id/reset-password', requireAdmin, async (c) => {
  const studentId = c.req.param('id');
  if (!studentId) return c.json({ error: 'Missing student id' }, 400);
  const user = c.get('user');
  const body = await c.req.json<{ password?: string }>().catch(() => ({ password: undefined }));

  if (!c.env.AUTH0_MGMT_CLIENT_ID || !c.env.AUTH0_MGMT_CLIENT_SECRET) {
    return c.json({ error: 'ยังไม่ได้ตั้งค่า Auth0 Management API (AUTH0_MGMT_CLIENT_ID/SECRET)' }, 503);
  }
  const student = await c.env.DB.prepare(`SELECT id, auth0_user_id AS auth0UserId FROM students WHERE id = ? AND deleted_at IS NULL`)
    .bind(studentId)
    .first<{ id: string; auth0UserId: string | null }>();
  if (!student) return c.json({ error: 'ไม่พบนักเรียนรหัสนี้ในระบบ' }, 404);

  const auth0Id = await resolveStudentAuth0Id(c, studentId, student.auth0UserId);
  if (!auth0Id) return c.json({ error: 'ไม่พบบัญชีเข้าสู่ระบบของนักเรียนใน Auth0' }, 409);

  const password = body.password?.trim() || generateTempPassword();
  try {
    await updateAuth0User(c.env, auth0Id, { password });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'ตั้งรหัสผ่านใหม่ไม่สำเร็จ' }, 502);
  }
  await logAudit(c.env.DB, user, 'RESET_STUDENT_PASSWORD', studentId, null, true);
  return c.json({ ok: true, password, message: 'ตั้งรหัสผ่านใหม่สำเร็จ' });
});

async function handleAvatarUpload(
  c: import('hono').Context<AppBindings>,
  keyPrefix: string,
  table: 'students' | 'staff',
  idColumn: string,
  idValue: string,
  existingKey: string | null,
): Promise<Response> {
  const form = await c.req.formData();
  const file = form.get('file') as unknown as File | string | null;
  if (typeof file === 'string' || file === null) return c.json({ error: 'Missing file' }, 400);
  if (!file.type.startsWith('image/')) return c.json({ error: 'ไฟล์ต้องเป็นรูปภาพ' }, 400);
  if (file.size > 5 * 1024 * 1024) return c.json({ error: 'ไฟล์รูปภาพต้องมีขนาดไม่เกิน 5MB' }, 400);

  const key = `${keyPrefix}/${Date.now()}${extOf(file.name) || '.jpg'}`;
  const bytes = new Uint8Array(await file.arrayBuffer());
  await c.env.BUCKET.put(key, bytes, { httpMetadata: { contentType: file.type } });
  await c.env.DB.prepare(`UPDATE ${table} SET avatar_key = ? WHERE ${idColumn} = ?`).bind(key, idValue).run();
  if (existingKey) await c.env.BUCKET.delete(existingKey).catch(() => {});

  return c.json({ ok: true, message: 'อัปโหลดรูปภาพสำเร็จ' });
}

async function streamAvatar(c: import('hono').Context<AppBindings>, avatarKey: string | null): Promise<Response> {
  if (!avatarKey) return c.json({ error: 'ยังไม่มีรูปภาพ' }, 404);
  const object = await c.env.BUCKET.get(avatarKey);
  if (!object) return c.json({ error: 'ไม่พบไฟล์รูปภาพ' }, 404);
  return new Response(object.body, {
    headers: {
      'Content-Type': object.httpMetadata?.contentType || 'image/jpeg',
      'Cache-Control': 'private, max-age=300',
    },
  });
}

accounts.post('/students/:id/avatar', requireAdmin, async (c) => {
  const studentId = c.req.param('id');
  if (!studentId) return c.json({ error: 'Missing student id' }, 400);
  const student = await c.env.DB.prepare(`SELECT id, avatar_key AS avatarKey FROM students WHERE id = ? AND deleted_at IS NULL`)
    .bind(studentId)
    .first<{ id: string; avatarKey: string | null }>();
  if (!student) return c.json({ error: 'ไม่พบนักเรียนรหัสนี้ในระบบ' }, 404);
  const res = await handleAvatarUpload(c, `avatars/students/${studentId}`, 'students', 'id', studentId, student.avatarKey);
  if (res.status === 200) await logAudit(c.env.DB, c.get('user'), 'UPDATE_STUDENT_AVATAR', studentId, null, true);
  return res;
});

accounts.get('/students/:id/avatar', async (c) => {
  const studentId = c.req.param('id');
  if (!studentId) return c.json({ error: 'Missing student id' }, 400);
  const visible = await visibleStudentIds(c.env.DB, c.get('user'));
  if (!canSeeStudent(visible, studentId)) return c.json({ error: 'Forbidden' }, 403);
  const student = await c.env.DB.prepare(`SELECT avatar_key AS avatarKey FROM students WHERE id = ? AND deleted_at IS NULL`)
    .bind(studentId)
    .first<{ avatarKey: string | null }>();
  return streamAvatar(c, student?.avatarKey ?? null);
});

// ===== Teacher / staff accounts =====

function staffSlug(identity: string): string {
  return identity.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'staff';
}

const STAFF_ROLES = ['admin', 'teacher', 'staff'] as const;
type StaffRole = (typeof STAFF_ROLES)[number];

function roleEnvKey(role: StaffRole): 'AUTH0_ADMIN_ROLE_ID' | 'AUTH0_TEACHER_ROLE_ID' | 'AUTH0_STAFF_ROLE_ID' {
  if (role === 'admin') return 'AUTH0_ADMIN_ROLE_ID';
  if (role === 'teacher') return 'AUTH0_TEACHER_ROLE_ID';
  return 'AUTH0_STAFF_ROLE_ID';
}

accounts.get('/staff', requireAdmin, async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT identity, name, is_admin AS isAdmin, role, phone, title, avatar_key AS avatarKey,
            auth0_user_id AS auth0UserId, created_by AS createdBy, created_at AS createdAt, last_seen AS lastSeen
     FROM staff ORDER BY (created_at IS NULL), created_at DESC, name`,
  ).all();
  return c.json(results ?? []);
});

accounts.post('/staff', requireAdmin, async (c) => {
  const user = c.get('user');
  const body = await c.req.json<{ email?: string; name?: string; role?: string; phone?: string; title?: string }>();

  if (!body.email || !EMAIL_RE.test(body.email)) return c.json({ error: 'กรุณากรอกอีเมลให้ถูกต้อง' }, 400);
  if (!body.name?.trim()) return c.json({ error: 'กรุณากรอกชื่อ' }, 400);
  const role = (body.role || 'teacher') as StaffRole;
  if (!STAFF_ROLES.includes(role)) return c.json({ error: 'บทบาทไม่ถูกต้อง' }, 400);

  if (!c.env.AUTH0_MGMT_CLIENT_ID || !c.env.AUTH0_MGMT_CLIENT_SECRET) {
    return c.json({ error: 'ยังไม่ได้ตั้งค่า Auth0 Management API (AUTH0_MGMT_CLIENT_ID/SECRET)' }, 503);
  }

  const email = body.email.trim().toLowerCase();
  const name = body.name.trim();
  let created;
  try {
    created = await createStaffAuth0User(c.env, email, name);
  } catch (err) {
    return c.json({ error: `สร้างบัญชีเข้าสู่ระบบไม่สำเร็จ: ${err instanceof Error ? err.message : 'Auth0 error'}` }, 502);
  }

  let roleWarning: string | null = null;
  const roleId = c.env[roleEnvKey(role)];
  if (roleId) {
    try {
      await assignAuth0Role(c.env, created.userId, roleId);
    } catch (err) {
      roleWarning = `สร้างบัญชีสำเร็จ แต่กำหนดบทบาทไม่สำเร็จ (${err instanceof Error ? err.message : 'Auth0 error'}) กรุณากำหนดเองใน Auth0`;
    }
  } else {
    roleWarning = `สร้างบัญชีสำเร็จ แต่ยังไม่ได้ตั้งค่า ${roleEnvKey(role)} — กรุณากำหนดบทบาทเองใน Auth0`;
  }

  await c.env.DB.prepare(
    `INSERT INTO staff (identity, name, is_admin, role, phone, title, auth0_user_id, created_by, created_at, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT(identity) DO UPDATE SET name = excluded.name, role = excluded.role, phone = excluded.phone,
       title = excluded.title, auth0_user_id = excluded.auth0_user_id, created_by = excluded.created_by,
       created_at = COALESCE(staff.created_at, excluded.created_at)`,
  )
    .bind(email, name, role === 'admin' ? 1 : 0, role, body.phone?.trim() || null, body.title?.trim() || null, created.userId, user.email)
    .run();

  await logAudit(c.env.DB, user, 'CREATE_STAFF', null, email, true);

  let message = `สร้างบัญชีสำเร็จ (${role}) — บัญชีเข้าสู่ระบบ: ${created.email} รหัสผ่านชั่วคราว: ${created.password}`;
  if (roleWarning) message += ` — ${roleWarning}`;
  return c.json({ ok: true, identity: email, password: created.password, message });
});

accounts.patch('/staff/:identity', requireAdmin, async (c) => {
  const identityParam = c.req.param('identity');
  if (!identityParam) return c.json({ error: 'Missing identity' }, 400);
  const identity = decodeURIComponent(identityParam);
  const user = c.get('user');
  const body = await c.req.json<{ name?: string; phone?: string; title?: string }>();

  const staff = await c.env.DB.prepare(`SELECT identity, auth0_user_id AS auth0UserId FROM staff WHERE identity = ? COLLATE NOCASE`)
    .bind(identity)
    .first<{ identity: string; auth0UserId: string | null }>();
  if (!staff) return c.json({ error: 'ไม่พบบัญชีนี้' }, 404);

  const sets: string[] = [];
  const binds: unknown[] = [];
  if (body.name !== undefined) {
    if (!body.name.trim()) return c.json({ error: 'กรุณากรอกชื่อ' }, 400);
    sets.push('name = ?'); binds.push(body.name.trim());
  }
  if (body.phone !== undefined) { sets.push('phone = ?'); binds.push(body.phone || null); }
  if (body.title !== undefined) { sets.push('title = ?'); binds.push(body.title || null); }
  if (sets.length) {
    binds.push(staff.identity);
    await c.env.DB.prepare(`UPDATE staff SET ${sets.join(', ')} WHERE identity = ?`).bind(...binds).run();
  }

  let auth0Id = staff.auth0UserId;
  if (!auth0Id && identity.includes('@') && c.env.AUTH0_MGMT_CLIENT_ID && c.env.AUTH0_MGMT_CLIENT_SECRET) {
    const found = await findAuth0UserByEmail(c.env, identity).catch(() => null);
    if (found) {
      auth0Id = found.userId;
      await c.env.DB.prepare(`UPDATE staff SET auth0_user_id = ? WHERE identity = ?`).bind(auth0Id, staff.identity).run();
    }
  }
  if (auth0Id && body.name !== undefined && c.env.AUTH0_MGMT_CLIENT_ID && c.env.AUTH0_MGMT_CLIENT_SECRET) {
    await updateAuth0User(c.env, auth0Id, { name: body.name.trim() }).catch(() => {});
  }

  await logAudit(c.env.DB, user, 'EDIT_STAFF', null, identity, true);
  return c.json({ ok: true, message: 'บันทึกข้อมูลสำเร็จ' });
});

accounts.post('/staff/:identity/avatar', requireAdmin, async (c) => {
  const identityParam = c.req.param('identity');
  if (!identityParam) return c.json({ error: 'Missing identity' }, 400);
  const identity = decodeURIComponent(identityParam);
  const staff = await c.env.DB.prepare(`SELECT identity, avatar_key AS avatarKey FROM staff WHERE identity = ? COLLATE NOCASE`)
    .bind(identity)
    .first<{ identity: string; avatarKey: string | null }>();
  if (!staff) return c.json({ error: 'ไม่พบบัญชีนี้' }, 404);
  const res = await handleAvatarUpload(c, `avatars/staff/${staffSlug(staff.identity)}`, 'staff', 'identity', staff.identity, staff.avatarKey);
  if (res.status === 200) await logAudit(c.env.DB, c.get('user'), 'UPDATE_STAFF_AVATAR', null, identity, true);
  return res;
});

accounts.get('/staff/:identity/avatar', async (c) => {
  const identityParam = c.req.param('identity');
  if (!identityParam) return c.json({ error: 'Missing identity' }, 400);
  const identity = decodeURIComponent(identityParam);
  const staff = await c.env.DB.prepare(`SELECT avatar_key AS avatarKey FROM staff WHERE identity = ? COLLATE NOCASE`)
    .bind(identity)
    .first<{ avatarKey: string | null }>();
  return streamAvatar(c, staff?.avatarKey ?? null);
});

async function resolveStaffAuth0Id(c: import('hono').Context<AppBindings>, identity: string, cached: string | null): Promise<string | null> {
  if (cached) return cached;
  if (!identity.includes('@') || !c.env.AUTH0_MGMT_CLIENT_ID || !c.env.AUTH0_MGMT_CLIENT_SECRET) return null;
  const found = await findAuth0UserByEmail(c.env, identity).catch(() => null);
  if (!found) return null;
  await c.env.DB.prepare(`UPDATE staff SET auth0_user_id = ? WHERE identity = ? COLLATE NOCASE`).bind(found.userId, identity).run();
  return found.userId;
}

// Returns a one-time password-change link for the admin to send the
// teacher/staff member — the Worker never sees or sets the new password.
accounts.post('/staff/:identity/password-ticket', requireAdmin, async (c) => {
  const identityParam = c.req.param('identity');
  if (!identityParam) return c.json({ error: 'Missing identity' }, 400);
  const identity = decodeURIComponent(identityParam);
  if (!c.env.AUTH0_MGMT_CLIENT_ID || !c.env.AUTH0_MGMT_CLIENT_SECRET) {
    return c.json({ error: 'ยังไม่ได้ตั้งค่า Auth0 Management API (AUTH0_MGMT_CLIENT_ID/SECRET)' }, 503);
  }
  const staff = await c.env.DB.prepare(`SELECT identity, auth0_user_id AS auth0UserId FROM staff WHERE identity = ? COLLATE NOCASE`)
    .bind(identity)
    .first<{ identity: string; auth0UserId: string | null }>();
  if (!staff) return c.json({ error: 'ไม่พบบัญชีนี้' }, 404);

  const auth0Id = await resolveStaffAuth0Id(c, staff.identity, staff.auth0UserId);
  if (!auth0Id) return c.json({ error: 'ไม่พบบัญชีนี้ใน Auth0 (ใช้ได้เฉพาะบัญชีที่มีอีเมลตรงกับ Auth0)' }, 409);

  try {
    const url = await createPasswordChangeTicket(c.env, auth0Id);
    await logAudit(c.env.DB, c.get('user'), 'STAFF_PASSWORD_TICKET', null, identity, true);
    return c.json({ ok: true, url, message: 'สร้างลิงก์เปลี่ยนรหัสผ่านแล้ว ส่งลิงก์นี้ให้ผู้ใช้เพื่อตั้งรหัสผ่านใหม่ด้วยตนเอง' });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'สร้างลิงก์เปลี่ยนรหัสผ่านไม่สำเร็จ' }, 502);
  }
});

// Returns a one-time MFA/passkey enrollment link. The WebAuthn ceremony
// must run on the teacher/staff member's own device, so this is a link to
// send them, not something the admin completes on their behalf.
accounts.post('/staff/:identity/passkey-ticket', requireAdmin, async (c) => {
  const identityParam = c.req.param('identity');
  if (!identityParam) return c.json({ error: 'Missing identity' }, 400);
  const identity = decodeURIComponent(identityParam);
  if (!c.env.AUTH0_MGMT_CLIENT_ID || !c.env.AUTH0_MGMT_CLIENT_SECRET) {
    return c.json({ error: 'ยังไม่ได้ตั้งค่า Auth0 Management API (AUTH0_MGMT_CLIENT_ID/SECRET)' }, 503);
  }
  const staff = await c.env.DB.prepare(`SELECT identity, auth0_user_id AS auth0UserId FROM staff WHERE identity = ? COLLATE NOCASE`)
    .bind(identity)
    .first<{ identity: string; auth0UserId: string | null }>();
  if (!staff) return c.json({ error: 'ไม่พบบัญชีนี้' }, 404);

  const auth0Id = await resolveStaffAuth0Id(c, staff.identity, staff.auth0UserId);
  if (!auth0Id) return c.json({ error: 'ไม่พบบัญชีนี้ใน Auth0 (ใช้ได้เฉพาะบัญชีที่มีอีเมลตรงกับ Auth0)' }, 409);

  try {
    const url = await createGuardianEnrollmentTicket(c.env, auth0Id);
    await logAudit(c.env.DB, c.get('user'), 'STAFF_PASSKEY_TICKET', null, identity, true);
    return c.json({ ok: true, url, message: 'สร้างลิงก์ลงทะเบียน Passkey แล้ว ส่งลิงก์นี้ให้ผู้ใช้เพื่อลงทะเบียนบนอุปกรณ์ของตนเอง' });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'สร้างลิงก์ลงทะเบียน Passkey ไม่สำเร็จ' }, 502);
  }
});

export default accounts;
