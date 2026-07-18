import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Context, Next } from 'hono';
import type { AppBindings, AuthUser } from './types';
import { logAudit, recordStaff, resolveStudentAuth0Id } from './db';

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let jwksDomain: string | null = null;

function getJwks(domain: string) {
  if (!jwks || jwksDomain !== domain) {
    jwks = createRemoteJWKSet(new URL(`https://${domain}/.well-known/jwks.json`));
    jwksDomain = domain;
  }
  return jwks;
}

export async function verifyAuth(c: Context<AppBindings>, next: Next) {
  const authHeader = c.req.header('Authorization') || '';
  const [scheme, token] = authHeader.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  try {
    const { payload } = await jwtVerify(token, getJwks(c.env.AUTH0_DOMAIN), {
      issuer: `https://${c.env.AUTH0_DOMAIN}/`,
      audience: c.env.AUTH0_AUDIENCE,
    });

    // Identity resolution order: the namespaced claim added by the Auth0
    // Action (README step 5) → a standard `email` claim if present → the
    // Auth0 sub. Teacher-visibility rows are matched against this value, so
    // when no email claim exists the admin must assign by the sub instead
    // (the access screen lists the identities actually seen).
    const email =
      (payload[c.env.AUTH0_EMAIL_CLAIM] as string | undefined) ??
      (payload.email as string | undefined) ??
      (payload.sub as string);
    const user: AuthUser = {
      sub: payload.sub as string,
      email,
      // Display name from the namespaced claim (README step 5) or a standard
      // name/nickname claim; falls back to the email/sub so the UI never
      // shows an empty label.
      name:
        (payload[c.env.AUTH0_NAME_CLAIM] as string | undefined) ??
        (payload.name as string | undefined) ??
        (payload.nickname as string | undefined) ??
        email,
      permissions: (payload.permissions as string[] | undefined) ?? [],
    };
    c.set('user', user);
    // Best-effort staff directory upsert so the admin UI can show names
    // instead of raw auth0|... subs. Never blocks the request.
    await recordStaff(c.env.DB, user).catch(() => {});
    await next();
  } catch {
    return c.json({ error: 'Unauthorized' }, 401);
  }
}

// Verifies a portal Bearer token and returns its identity (email claim if
// present, always the sub), or null for a missing/invalid token. Never
// throws — portal routes degrade to the unauthenticated view.
export async function verifyPortalToken(c: Context<AppBindings>): Promise<{ email: string; sub: string } | null> {
  const authHeader = c.req.header('Authorization') || '';
  const [scheme, token] = authHeader.split(' ');
  if (scheme !== 'Bearer' || !token) return null;
  try {
    const { payload } = await jwtVerify(token, getJwks(c.env.AUTH0_DOMAIN), {
      issuer: `https://${c.env.AUTH0_DOMAIN}/`,
      audience: c.env.AUTH0_AUDIENCE,
    });
    const email =
      (payload[c.env.AUTH0_EMAIL_CLAIM] as string | undefined) ??
      (payload.email as string | undefined) ??
      '';
    return { email, sub: payload.sub as string };
  } catch {
    return null;
  }
}

// Resolves which student an already-verified token identity belongs to:
// the email-claim local part as a student id first, then the Auth0 sub
// against students.auth0_user_id. Shared by GET /portal/whoami and
// portalTokenMatchesStudent (below) so the two can never drift out of sync
// with each other — see portalTokenMatchesStudent's history for what
// happens when they do (a resolution path that worked for whoami silently
// wasn't tried by the ownership check, and vice versa).
export async function resolveStudentIdFromIdent(
  c: Context<AppBindings>,
  ident: { email: string; sub: string },
): Promise<string | null> {
  const localPart = ident.email.split('@')[0];
  if (localPart) {
    const byEmail = await c.env.DB.prepare(
      `SELECT id FROM students WHERE id = ? COLLATE NOCASE AND deleted_at IS NULL`,
    )
      .bind(localPart)
      .first<{ id: string }>();
    if (byEmail) return byEmail.id;
  }

  const bySub = await c.env.DB.prepare(
    `SELECT id FROM students WHERE auth0_user_id = ? AND deleted_at IS NULL`,
  )
    .bind(ident.sub)
    .first<{ id: string }>();
  return bySub?.id ?? null;
}

// Ownership check for the student portal — returns whether the caller
// presented a valid Auth0 token that proves they are this exact student.
// GET /portal/:studentId (and every other portal route: self-edit, files,
// avatar upload) rejects the request outright when this is false.
export async function portalTokenMatchesStudent(c: Context<AppBindings>, studentId: string): Promise<boolean> {
  const ident = await verifyPortalToken(c);
  if (!ident) return false;

  const resolved = await resolveStudentIdFromIdent(c, ident);
  if (resolved && resolved.toLowerCase() === studentId.toLowerCase()) return true;

  // Last resort for a student whose auth0_user_id isn't cached yet (e.g.
  // first login ever, or an account created before that caching existed):
  // look this exact studentId's Auth0 account up by the conventional login
  // email via the Management API and compare its user id to the token's
  // sub. Needs AUTH0_MGMT_CLIENT_ID/SECRET — a no-op (false) without them.
  try {
    const row = await c.env.DB.prepare(
      `SELECT auth0_user_id AS auth0UserId FROM students WHERE id = ? COLLATE NOCASE AND deleted_at IS NULL`,
    )
      .bind(studentId)
      .first<{ auth0UserId: string | null }>();
    const auth0UserId = await resolveStudentAuth0Id(c, studentId, row?.auth0UserId ?? null);
    return !!auth0UserId && auth0UserId === ident.sub;
  } catch {
    return false;
  }
}

export function requirePermission(permission: string) {
  return async (c: Context<AppBindings>, next: Next) => {
    const user = c.get('user');
    if (!user.permissions.includes(permission)) {
      await logAudit(c.env.DB, user, `FORBIDDEN:${permission}`, c.req.param('id') ?? null, c.req.param('fileId') ?? null, false);
      return c.json({ error: 'Forbidden' }, 403);
    }
    await next();
  };
}

// In the Auth0 setup (worker/README.md step 1) only the Admin role holds
// `files:delete`, so it doubles as the admin marker for admin-only routes
// without needing a new Auth0 permission rollout.
export const ADMIN_PERMISSION = 'files:delete';

export function isAdmin(user: AuthUser): boolean {
  return user.permissions.includes(ADMIN_PERMISSION);
}

export const requireAdmin = requirePermission(ADMIN_PERMISSION);
