# litalk-files-api

Cloudflare Worker backing the **entire** admin panel and the student portal:

- Student files (upload / list / download / delete) — D1 metadata + R2 blobs
- Students, study logs, payments, bookings, dashboard — D1 (`litalk`)
- Stripe payment links + webhook (auto-records paid links as payments)
- Monthly earnings summary (`/earnings`)
- Public student-portal read endpoint for litalkeducation.com (`/portal/:id`)

The old Google Apps Script / Google Sheets backend is fully replaced. A
one-time import endpoint (`POST /import`) moves the existing Sheet data into
D1 — see "Migrating data from the Google Sheet" below.

## 1. One-time Auth0 setup (manual, in the Auth0 dashboard)

The SPA currently only requests an ID token, which isn't suitable for a
server to verify. Create a dedicated API so the frontend can request a scoped
access token instead:

1. Auth0 Dashboard → **Applications → APIs → Create API**.
   - Name: `Litalk Admin Files API` (or anything).
   - Identifier: a URI-style string that does **not** need to resolve, e.g.
     `https://admin.litalkeducation.com/files-api`. This value is the
     `audience` — copy it into `wrangler.toml`'s `AUTH0_AUDIENCE` var below.
   - Signing Algorithm: RS256 (default).
2. On that API's **Settings** tab, enable:
   - **RBAC**
   - **Add Permissions in the Access Token**
3. On the API's **Permissions** tab, add:
   - `files:read`
   - `files:write`
   - `files:delete`
   - `data:read`   (students list, dashboard, earnings, payment-link list)
   - `data:write`  (create student, study log, payment, booking, payment link)
4. **User Management → Roles** → create two roles and assign the permissions
   above from this API:
   - `Admin` → `files:read`, `files:write`, `files:delete`, `data:read`, `data:write`
   - `Teacher` → `files:read`, `files:write`, `data:read`, `data:write`
   Then assign the appropriate role to each staff user (**User Management →
   Users → [user] → Roles**).
5. (Strongly recommended — required for teacher-visibility rules keyed by
   email) Add an Auth0 Action (Login Flow) that copies the user's email
   into a namespaced access-token claim, since access tokens don't include
   `email` by default:
   ```js
   exports.onExecutePostLogin = async (event, api) => {
     api.accessToken.setCustomClaim('https://admin.litalkeducation.com/email', event.user.email);
   };
   ```
   This must match `AUTH0_EMAIL_CLAIM` in `wrangler.toml`. If skipped, the
   Worker falls back to using the Auth0 `sub` as the "uploaded by" / audit
   identity.

Once the API exists, the frontend (`index.html`) needs `audience` added to
its `Auth0Client` config and to request an access token via
`getTokenSilently()` for calls to this Worker — see the root `index.html`
changes in this repo for that wiring.

### Auto-creating student logins (Auth0 Management API)

`POST /students` can also create the student's Auth0 login account (email
`<studentId>@STUDENT_EMAIL_DOMAIN` + temporary password, shown once in the
admin UI), matching the old GAS behaviour:

1. Auth0 Dashboard → **Applications → Create Application → Machine to
   Machine**, authorize it for the **Auth0 Management API** with the
   `create:users` scope.
2. Store its credentials as Worker secrets:
   ```sh
   npx wrangler secret put AUTH0_MGMT_CLIENT_ID
   npx wrangler secret put AUTH0_MGMT_CLIENT_SECRET
   ```
3. Make sure `STUDENT_EMAIL_DOMAIN` and `AUTH0_DB_CONNECTION` in
   `wrangler.toml` match the conventions the old GAS backend used (the
   student site derives the student id from the login email's local part).

If the secrets are not set, student creation still works — it just skips the
Auth0 account and says so in the success message.

## Stripe setup (payment links)

1. Get the secret key from the Stripe Dashboard (**Developers → API keys**)
   and store it:
   ```sh
   npx wrangler secret put STRIPE_SECRET_KEY
   ```
2. Create a webhook endpoint (**Developers → Webhooks → Add endpoint**):
   - URL: `https://litalk-files-api.n62c5gwghk.workers.dev/stripe/webhook`
   - Event: `checkout.session.completed`
   Then store its signing secret:
   ```sh
   npx wrangler secret put STRIPE_WEBHOOK_SECRET
   ```

Payment links are single-use (one completed payment each) and carry the
student id + creator email as metadata; when Stripe reports the session as
paid, the webhook records a `payments` row automatically (source `stripe`)
and marks the link `paid`. Amounts are THB.

## 2. One-time Cloudflare resource setup

If `litalk` (D1) and `files-litalk` (R2) don't already exist:

```sh
npx wrangler d1 create litalk
npx wrangler r2 bucket create files-litalk
```

`wrangler d1 create` prints a `database_id` — paste it into
`wrangler.toml`'s `database_id` field (currently `REPLACE_WITH_D1_DATABASE_ID`).

Also replace `AUTH0_AUDIENCE` in `wrangler.toml` with the API Identifier from
step 1.

## 3. Apply the D1 schema

```sh
npm install
npm run db:migrate:remote   # applies migrations/*.sql to the real D1 database
# npm run db:migrate:local  # for local `wrangler dev` testing instead
```

These scripts now use `wrangler d1 migrations apply`, which tracks applied
migrations in a `d1_migrations` table. The existing production database got
`0001_init.sql` via plain `d1 execute` (untracked), so **one time only**,
mark it as applied first or `migrations apply` will fail on the existing
tables:

```sh
npx wrangler d1 execute litalk --remote --command \
  "CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT current_timestamp); INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0001_init.sql');"
npm run db:migrate:remote
```

## Migrating data from the Google Sheet (one-time)

`POST /import` (permission `data:write`) bulk-loads Sheet data into D1.
Students upsert by id; logs/payments/bookings are plain inserts — **run it
once** or you'll get duplicates.

1. In the old Apps Script project, dump each sheet to JSON shaped like:
   ```json
   {
     "students":  [{ "id": "LT-123456", "name": "...", "nickname": "", "email": "", "phone": "", "course": "..." }],
     "studyLogs": [{ "studentId": "LT-123456", "date": "2026-06-30", "feedback": "...", "video": "https://..." }],
     "payments":  [{ "studentId": "LT-123456", "total": 3500, "method": "โอนผ่านบัญชีธนาคาร", "date": "2026-06-30", "proof": "https://..." }],
     "bookings":  [{ "studentId": "LT-123456", "date": "2026-07-10", "time": "14:00", "notes": "" }]
   }
   ```
   All dates must be `YYYY-MM-DD` (convert Buddhist-era years to CE).
2. Send it with a staff access token (grab one from the admin page's
   DevTools → Network → any Worker request → `Authorization` header):
   ```sh
   curl -X POST https://litalk-files-api.n62c5gwghk.workers.dev/import \
     -H "Authorization: Bearer <ACCESS_TOKEN>" \
     -H "Content-Type: application/json" \
     --data @export.json
   ```
   Max ~5000 rows per request; split larger exports.
3. Spot-check `/students` and the dashboard, then retire the GAS web app.

## 4. Local development

```sh
npm install
npm run db:migrate:local
npm run dev   # wrangler dev --local, serves on http://localhost:8787
```

Without a real Auth0 access token, all routes correctly return `401` — this
is expected; full end-to-end testing requires a token issued by the Auth0 API
from step 1.

## 5. Deploy

Manual:

```sh
npm run deploy
```

Or via CI: pushing changes under `worker/**` triggers
`.github/workflows/deploy-worker.yml`, which needs a `CLOUDFLARE_API_TOKEN`
repository secret with `Workers Scripts:Edit`, `D1:Edit`, and `R2:Edit`
permissions scoped to this account.

## API surface

| Method | Path                     | Permission     | Notes                              |
|--------|--------------------------|----------------|-------------------------------------|
| GET    | `/me`                    | (any valid token) | Returns `{ sub, email, permissions }` for UI gating |
| GET    | `/students/:id/files`    | `files:read`   | List a student's non-deleted files |
| POST   | `/upload`                | `files:write`  | multipart form: `student_id`, `file_type`, `file` |
| GET    | `/files/:fileId`         | `files:read`   | Streams the file from R2           |
| PATCH  | `/files/:fileId`         | `files:write`  | Body: `{ "file_type": "..." }`     |
| DELETE | `/files/:fileId`         | `files:delete` | Soft-deletes (D1) + deletes from R2 |
| GET    | `/students`              | `data:read`    | Non-deleted students, filtered by teacher visibility |
| POST   | `/students`              | `data:write`   | Creates student (+ Auth0 login if configured) |
| DELETE | `/students/:id`          | admin          | Soft-deletes the student in-app; Auth0 login untouched |
| GET    | `/student-check/:id`     | `data:read`    | Check screen data: payment status, study days, logs, schedules |
| POST   | `/schedules`             | `data:write`   | Teacher submits a monthly schedule (sessions + rate) |
| GET    | `/schedules?status=`     | `data:read`    | Teachers see own submissions; admins see all |
| POST   | `/schedules/:id/approve` | admin          | Approves + creates the parent's Stripe payment link |
| POST   | `/schedules/:id/reject`  | admin          | Rejects with an optional reason                |
| POST   | `/schedules/:id/cancel`  | `data:write`   | Teacher cancels own pending; admin any pending/approved |
| GET    | `/teacher-assignments`   | admin          | Per-teacher visible-student lists              |
| PUT    | `/teacher-assignments/:identity` | admin  | Replaces a teacher's visible-student set (empty = unrestricted) |
| GET    | `/staff-identities`      | admin          | Identities recently seen in the audit log (for assigning visibility) |
| POST   | `/study-logs`            | `data:write`   | `{ studentId, date, feedback, video }` |
| POST   | `/payments`              | `data:write`   | Manual payment record              |
| POST   | `/bookings`              | `data:write`   | 409 if the date+time slot is taken |
| GET    | `/dashboard?range=`      | `data:read`    | `today` \| `week` \| `month` aggregation |
| GET    | `/earnings?month=`       | `data:read`    | Monthly totals, per-teacher breakdown, pending links |
| POST   | `/payment-links`         | `data:write`   | Creates a Stripe payment link      |
| GET    | `/payment-links`         | `data:read`    | Last 30 links with status          |
| POST   | `/payment-links/:id/deactivate` | `data:write` | Disables an active link     |
| POST   | `/import`                | `data:write`   | One-time Sheet migration (see above) |
| POST   | `/stripe/webhook`        | (Stripe signature) | Records paid checkout sessions |
| GET    | `/portal/:studentId`     | (public)       | Student portal data for litalkeducation.com |

`file_type` must be one of: `Homework`, `Worksheet`, `Exam`, `Attendance`,
`Certificate`, `Portfolio`, `Other`.

## Monthly schedule lifecycle

1. A teacher submits a month's sessions for a student (`POST /schedules`,
   status `pending`). Total = rate per session × session count.
2. An admin approves it. If Stripe is configured this also creates a payment
   link (metadata carries `schedule_id`) that the admin forwards to the
   parent; status becomes `approved`.
3. A successful payment — the Stripe webhook for that link, any Stripe link
   for the student, or a manual `POST /payments` record — activates the
   schedule immediately: every session is inserted into `bookings`
   (`INSERT OR IGNORE`, so already-taken slots are skipped) and the status
   becomes `active`.

## Teacher visibility

`teacher_students` maps a teacher's **request identity** to the students
they may see. A teacher with **no** rows sees everyone (default); once the
admin assigns students, `/students`, `/student-check/:id`, the dashboard's
per-student lists, the file routes, and the create endpoints
(`/study-logs`, `/payments`, `/bookings`, `/schedules`) are restricted to
that set. `/earnings` also gains an `assigned` block (this month's payments
from exactly those students) so a restricted teacher can verify their
income.

**Identity matching (important):** the Worker identifies each request by
the namespaced email claim from the Auth0 Action in step 1.5, falling back
to a standard `email` claim, then to the Auth0 `sub` (`auth0|...`). The
assignment key must equal that identity, or the teacher silently keeps
full visibility. If the Action is not configured, assign by the teacher's
sub instead — `GET /staff-identities` (surfaced on the admin's access
screen) lists the identities actually seen, and the access screen warns
when the current token carries no email. Setting up the Action from step
1.5 is strongly recommended so assignments can use plain emails.

## Scope / security notes

- Staff routes require an Auth0 access token with the listed permission.
- "admin" in the table above means the `files:delete` permission, which only
  the Admin role holds in the Auth0 setup from step 1 — it doubles as the
  admin marker so no new Auth0 permission rollout is needed.
- `DELETE /students/:id` soft-deletes (sets `deleted_at`) and cancels the
  student's future bookings; study logs, payments, and files are kept, and
  the student's Auth0 login account is deliberately **not** deleted.
- `GET /portal/:studentId` is **public by student id**, mirroring the GAS
  endpoint it replaces (the student site "logs in" client-side only). It
  exposes the same data the old Sheet endpoint did: name, course, study
  logs, and payment history for a known student id. Locking this down
  properly would mean issuing student-audience Auth0 tokens and verifying
  them here — a separate piece of work.
- `ALLOWED_ORIGIN` (comma-separated) must include both the admin panel and
  the public site origins.
