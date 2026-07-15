// Auth0 Management API client. Used to auto-create a student's login
// account when a new student is registered (parity with the old GAS
// backend), and to let the admin panel manage student/teacher/staff
// accounts directly: profile edits, avatars, password resets, and
// passkey (WebAuthn) enrollment tickets.

import type { Env } from './types';

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getMgmtToken(env: Env): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.token;

  const res = await fetch(`https://${env.AUTH0_DOMAIN}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: env.AUTH0_MGMT_CLIENT_ID,
      client_secret: env.AUTH0_MGMT_CLIENT_SECRET,
      audience: `https://${env.AUTH0_DOMAIN}/api/v2/`,
    }),
  });
  if (!res.ok) throw new Error(`Auth0 token request failed (HTTP ${res.status})`);
  const json = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { token: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
  return json.access_token;
}

async function mgmtFetch(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  const token = await getMgmtToken(env);
  return fetch(`https://${env.AUTH0_DOMAIN}/api/v2${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
}

async function mgmtError(res: Response, fallback: string): Promise<never> {
  const body = (await res.json().catch(() => ({}))) as { message?: string };
  throw new Error(body.message ?? `${fallback} (HTTP ${res.status})`);
}

// Random password satisfying Auth0's default policy (upper/lower/digit/symbol).
export function generateTempPassword(): string {
  const sets = [
    'ABCDEFGHJKLMNPQRSTUVWXYZ',
    'abcdefghjkmnpqrstuvwxyz',
    '23456789',
    '!@#$%',
  ];
  const all = sets.join('');
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const chars = sets.map((s, i) => s[bytes[i] % s.length]);
  for (let i = sets.length; i < bytes.length; i++) chars.push(all[bytes[i] % all.length]);
  return chars.join('');
}

export interface StudentCredentials {
  email: string;
  password: string;
}

// Auth0 rejects user creation with "Missing required property: username" on
// connections that have "Requires Username" enabled, and with "Cannot set
// username for connection without requires_username" when it's disabled and
// a username is sent anyway — so this can only be included when the admin
// has confirmed the connection's setting via AUTH0_*_REQUIRES_USERNAME (see
// README). Derives a username from the email's local part since Auth0
// usernames only allow letters/digits/underscores and (by default) 1-15
// characters.
function deriveUsername(email: string): string {
  const local = email.split('@')[0].toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 15);
  return local || `user${Math.floor(1000 + Math.random() * 9000)}`;
}

// Creates the Auth0 login account for a student. The login email is
// `<studentId>@<STUDENT_EMAIL_DOMAIN>` — the student site derives the student
// id from the email's local part, so this convention is load-bearing.
export async function createStudentAuth0User(env: Env, studentId: string, name: string): Promise<StudentCredentials & { userId: string }> {
  const email = `${studentId.toLowerCase()}@${env.STUDENT_EMAIL_DOMAIN}`;
  const password = generateTempPassword();

  const res = await mgmtFetch(env, '/users', {
    method: 'POST',
    body: JSON.stringify({
      connection: env.AUTH0_DB_CONNECTION,
      email,
      password,
      name,
      email_verified: true,
      ...(env.AUTH0_STUDENT_REQUIRES_USERNAME === 'true' ? { username: deriveUsername(email) } : {}),
    }),
  });
  if (!res.ok) await mgmtError(res, 'Auth0 user creation failed');
  const user = (await res.json()) as { user_id: string };
  return { email, password, userId: user.user_id };
}

export interface Auth0User {
  userId: string;
  email: string;
  name: string;
  username?: string;
  picture?: string;
}

// Looks up a user's Auth0 user_id by login email — used to resolve accounts
// created before auth0_user_id started being cached in D1.
export async function findAuth0UserByEmail(env: Env, email: string): Promise<Auth0User | null> {
  const res = await mgmtFetch(env, `/users-by-email?email=${encodeURIComponent(email)}`);
  if (!res.ok) await mgmtError(res, 'Auth0 user lookup failed');
  const users = (await res.json()) as Array<{ user_id: string; email: string; name: string; username?: string; picture?: string }>;
  const user = users[0];
  if (!user) return null;
  return { userId: user.user_id, email: user.email, name: user.name, username: user.username, picture: user.picture };
}

export interface Auth0UserPatch {
  name?: string;
  email?: string;
  username?: string;
  password?: string;
  picture?: string;
}

// Applies a partial profile/credential update. Auth0 rejects `username` on
// connections that don't have `requires_username` enabled — that error is
// surfaced to the caller as-is rather than swallowed, since it tells the
// admin exactly what to fix.
export async function updateAuth0User(env: Env, userId: string, patch: Auth0UserPatch): Promise<void> {
  const body: Record<string, unknown> = {};
  if (patch.name !== undefined) body.name = patch.name;
  if (patch.email !== undefined) body.email = patch.email;
  if (patch.username !== undefined) body.username = patch.username;
  if (patch.password !== undefined) body.password = patch.password;
  if (patch.picture !== undefined) body.picture = patch.picture;
  if (Object.keys(body).length === 0) return;

  const res = await mgmtFetch(env, `/users/${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
  if (!res.ok) await mgmtError(res, 'Auth0 user update failed');
}

export interface NewStaffAccount {
  email: string;
  password: string;
  name: string;
  userId: string;
}

// Creates a teacher/staff login account (AUTH0_STAFF_CONNECTION, falling
// back to AUTH0_DB_CONNECTION) with a temporary password, shown once in the
// admin UI — same pattern as createStudentAuth0User.
export async function createStaffAuth0User(env: Env, email: string, name: string): Promise<NewStaffAccount> {
  const password = generateTempPassword();
  const res = await mgmtFetch(env, '/users', {
    method: 'POST',
    body: JSON.stringify({
      connection: env.AUTH0_STAFF_CONNECTION || env.AUTH0_DB_CONNECTION,
      email,
      password,
      name,
      email_verified: true,
      ...(env.AUTH0_STAFF_REQUIRES_USERNAME === 'true' ? { username: deriveUsername(email) } : {}),
    }),
  });
  if (!res.ok) await mgmtError(res, 'Auth0 user creation failed');
  const user = (await res.json()) as { user_id: string };
  return { email, password, name, userId: user.user_id };
}

// Assigns a single Auth0 role (replacing none — additive) to a user. Role
// ids come from wrangler.toml (AUTH0_ADMIN_ROLE_ID / AUTH0_TEACHER_ROLE_ID /
// AUTH0_STAFF_ROLE_ID); callers should skip this entirely when the relevant
// id isn't configured.
export async function assignAuth0Role(env: Env, userId: string, roleId: string): Promise<void> {
  const res = await mgmtFetch(env, `/users/${encodeURIComponent(userId)}/roles`, {
    method: 'POST',
    body: JSON.stringify({ roles: [roleId] }),
  });
  if (!res.ok) await mgmtError(res, 'Auth0 role assignment failed');
}

// Creates a one-time password-change link (Management API "tickets"). The
// admin copies/sends this link to the teacher/staff member, who sets their
// own new password on Auth0's hosted page — the Worker never learns it.
export async function createPasswordChangeTicket(env: Env, userId: string): Promise<string> {
  const res = await mgmtFetch(env, '/tickets/password-change', {
    method: 'POST',
    body: JSON.stringify({ user_id: userId, ttl_sec: 604800 }),
  });
  if (!res.ok) await mgmtError(res, 'Auth0 password-change ticket failed');
  const json = (await res.json()) as { ticket: string };
  return json.ticket;
}

// Creates a Guardian MFA enrollment ticket scoped to `webauthn-platform`
// (Auth0's factor id for a device's built-in authenticator — Face ID,
// Windows Hello, etc., i.e. a passkey) so the link the admin sends opens
// straight into passkey registration instead of a pick-any-factor screen.
// WebAuthn is a browser ceremony bound to the enrolling user's own device,
// so this cannot be done "on behalf of" someone from the admin's browser —
// the admin sends this link to the teacher/staff member, who opens it on
// their own device.
export async function createGuardianEnrollmentTicket(env: Env, userId: string): Promise<string> {
  const res = await mgmtFetch(env, '/guardian/enrollments/ticket', {
    method: 'POST',
    body: JSON.stringify({ user_id: userId, send_mail: false, factor: 'webauthn-platform' }),
  });
  if (!res.ok) await mgmtError(res, 'Auth0 MFA enrollment ticket failed');
  const json = (await res.json()) as { ticket_url: string };
  return json.ticket_url;
}
