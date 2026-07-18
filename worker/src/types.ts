export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  // URL shortener redirect cache (worker/src/shortlinks.ts) — fast path for
  // go.litalkeducation.com / payment.litalkeducation.com lookups; D1 is the
  // source of truth on a miss.
  SHORTLINKS: KVNamespace;
  SHORT_DOMAIN_GO: string;
  SHORT_DOMAIN_PAYMENT: string;
  AUTH0_DOMAIN: string;
  // The student site's Auth0Client uses this custom domain (not
  // AUTH0_DOMAIN) so student portal tokens carry it as their `iss` claim —
  // see verifyPortalToken in auth.ts. Falls back to AUTH0_DOMAIN if unset.
  AUTH0_PORTAL_DOMAIN?: string;
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
  // Set to the literal string "true" only if AUTH0_DB_CONNECTION /
  // AUTH0_STAFF_CONNECTION has "Requires Username" enabled in the Auth0
  // dashboard — otherwise user creation fails (see worker/README.md).
  AUTH0_STUDENT_REQUIRES_USERNAME?: string;
  AUTH0_STAFF_REQUIRES_USERNAME?: string;
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
  // AI chat assistant (worker/src/gemini.ts) — Gemini Developer API
  // (Google AI Studio key). Chat endpoints degrade to a 503 "not configured"
  // response when unset instead of failing to deploy.
  GEMINI_API_KEY?: string;
  // Google Meet auto-creation (see worker/README.md). Booking still works
  // without these — it just skips the Meet link. OAuth "refresh token" flow
  // (not a service account — that needs Google Workspace domain-wide
  // delegation): one-time login by the Google account that should own the
  // class calendar mints GOOGLE_OAUTH_REFRESH_TOKEN via
  // `npm run google-oauth-setup`.
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GOOGLE_OAUTH_CLIENT_SECRET?: string; // secret
  GOOGLE_OAUTH_REFRESH_TOKEN?: string; // secret
  GOOGLE_CALENDAR_ID?: string; // defaults to that account's "primary" calendar
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
