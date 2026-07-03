export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  AUTH0_DOMAIN: string;
  AUTH0_AUDIENCE: string;
  AUTH0_EMAIL_CLAIM: string;
  ALLOWED_ORIGIN: string;
}

export interface AuthUser {
  sub: string;
  email: string;
  permissions: string[];
}

export type AppBindings = {
  Bindings: Env;
  Variables: { user: AuthUser };
};
