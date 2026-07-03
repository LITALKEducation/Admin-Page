import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Context, Next } from 'hono';
import type { AppBindings, AuthUser } from './types';
import { logAudit } from './db';

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

    const user: AuthUser = {
      sub: payload.sub as string,
      email: (payload[c.env.AUTH0_EMAIL_CLAIM] as string | undefined) ?? (payload.sub as string),
      permissions: (payload.permissions as string[] | undefined) ?? [],
    };
    c.set('user', user);
    await next();
  } catch {
    return c.json({ error: 'Unauthorized' }, 401);
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
