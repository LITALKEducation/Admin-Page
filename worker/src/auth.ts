import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Context, Next } from 'hono';
import type { AppBindings, AuthUser } from './types';
import { logAudit, recordStaff } from './db';

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

// Best-effort ownership check for the public student portal. Unlike
// verifyAuth this never rejects the request — it returns whether the caller
// presented a valid Auth0 token whose login identity is this very student
// (`<studentId>@STUDENT_EMAIL_DOMAIN`). The portal stays public for basic
// data but unlocks sensitive fields (files, Meet links) only for the
// authenticated student themselves.
export async function portalTokenMatchesStudent(c: Context<AppBindings>, studentId: string): Promise<boolean> {
  const authHeader = c.req.header('Authorization') || '';
  const [scheme, token] = authHeader.split(' ');
  if (scheme !== 'Bearer' || !token) return false;
  try {
    const { payload } = await jwtVerify(token, getJwks(c.env.AUTH0_DOMAIN), {
      issuer: `https://${c.env.AUTH0_DOMAIN}/`,
      audience: c.env.AUTH0_AUDIENCE,
    });
    const email =
      (payload[c.env.AUTH0_EMAIL_CLAIM] as string | undefined) ??
      (payload.email as string | undefined) ??
      '';
    const localPart = email.split('@')[0];
    return !!localPart && localPart.toLowerCase() === studentId.toLowerCase();
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
