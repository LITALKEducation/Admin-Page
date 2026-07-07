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
  // Database connection new teacher/staff accounts are created in. Falls
  // back to AUTH0_DB_CONNECTION if unset.
  AUTH0_STAFF_CONNECTION?: string;
  // Role ids (User Management → Roles → [role] → copy the id from the URL)
  // assigned to accounts created via POST /staff. Role assignment is
  // skipped (with a message) for any that are unset.
  AUTH0_ADMIN_ROLE_ID?: string;
  AUTH0_TEACHER_ROLE_ID?: string;
  AUTH0_STAFF_ROLE_ID?: string;
  // Secrets (set via `wrangler secret put`, absent in plain `wrangler dev`)
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  AUTH0_MGMT_CLIENT_ID?: string;
  AUTH0_MGMT_CLIENT_SECRET?: string;
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
