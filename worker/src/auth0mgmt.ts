// Auth0 Management API client, used to auto-create a student's login account
// when a new student is registered (parity with the old GAS backend).

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

// Random password satisfying Auth0's default policy (upper/lower/digit/symbol).
function generateTempPassword(): string {
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

// Creates the Auth0 login account for a student. The login email is
// `<studentId>@<STUDENT_EMAIL_DOMAIN>` — the student site derives the student
// id from the email's local part, so this convention is load-bearing.
export async function createStudentAuth0User(env: Env, studentId: string, name: string): Promise<StudentCredentials> {
  const token = await getMgmtToken(env);
  const email = `${studentId.toLowerCase()}@${env.STUDENT_EMAIL_DOMAIN}`;
  const password = generateTempPassword();

  const res = await fetch(`https://${env.AUTH0_DOMAIN}/api/v2/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      connection: env.AUTH0_DB_CONNECTION,
      email,
      password,
      name,
      email_verified: true,
    }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message ?? `Auth0 user creation failed (HTTP ${res.status})`);
  }
  return { email, password };
}
