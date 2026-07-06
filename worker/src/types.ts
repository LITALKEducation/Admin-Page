export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  AUTH0_DOMAIN: string;
  AUTH0_AUDIENCE: string;
  AUTH0_EMAIL_CLAIM: string;
  AUTH0_NAME_CLAIM: string;
  ALLOWED_ORIGIN: string;
  // Public-facing domain for shareable file links (same Worker, different
  // hostname). Falls back to the request's own origin if unset.
  PUBLIC_FILES_ORIGIN?: string;
  STUDENT_EMAIL_DOMAIN: string;
  AUTH0_DB_CONNECTION: string;
  // Web Push (VAPID). Public key + subject are not secret (the public key is
  // shipped to browsers as the applicationServerKey); the private key is.
  VAPID_PUBLIC_KEY?: string;
  VAPID_SUBJECT?: string;
  // Secrets (set via `wrangler secret put`, absent in plain `wrangler dev`)
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  AUTH0_MGMT_CLIENT_ID?: string;
  AUTH0_MGMT_CLIENT_SECRET?: string;
  VAPID_PRIVATE_KEY?: string;
}

export interface AuthUser {
  sub: string;
  email: string;
  // Human display name from the token when available, else the email/sub.
  name: string;
  permissions: string[];
}

export type AppBindings = {
  Bindings: Env;
  Variables: { user: AuthUser };
};
