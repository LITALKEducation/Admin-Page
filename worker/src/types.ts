export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  AUTH0_DOMAIN: string;
  AUTH0_AUDIENCE: string;
  AUTH0_EMAIL_CLAIM: string;
  ALLOWED_ORIGIN: string;
  STUDENT_EMAIL_DOMAIN: string;
  AUTH0_DB_CONNECTION: string;
  // Secrets (set via `wrangler secret put`, absent in plain `wrangler dev`)
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  AUTH0_MGMT_CLIENT_ID?: string;
  AUTH0_MGMT_CLIENT_SECRET?: string;
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
