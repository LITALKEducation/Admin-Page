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
   email) Add an Auth0 Action (Login Flow) that copies the user's email and
   name into namespaced access-token claims, since access tokens don't
   include them by default:
   ```js
   exports.onExecutePostLogin = async (event, api) => {
     api.accessToken.setCustomClaim('https://admin.litalkeducation.com/email', event.user.email);
     api.accessToken.setCustomClaim('https://admin.litalkeducation.com/name', event.user.name);
   };
   ```
   These must match `AUTH0_EMAIL_CLAIM` / `AUTH0_NAME_CLAIM` in
   `wrangler.toml`. If skipped, the Worker falls back to the Auth0 `sub` for
   identity and to `name`/`nickname`/email for display name.

Once the API exists, the frontend (`index.html`) needs `audience` added to
its `Auth0Client` config and to request an access token via
`getTokenSilently()` for calls to this Worker — see the root `index.html`
changes in this repo for that wiring.

### Auto-creating student logins (Auth0 Management API)

`POST /students` can also create the student's Auth0 login account (email
`<studentId>@STUDENT_EMAIL_DOMAIN` + temporary password, shown once in the
admin UI), matching the old GAS behaviour:

1. Auth0 Dashboard → **Applications → Create Application → Machine to
   Machine**, authorize it for the **Auth0 Management API** with these
   scopes: `create:users`, `read:users`, `update:users`,
   `create:role_members`, `create:user_tickets`,
   `create:guardian_enrollment_tickets`. (The last four are only needed for
   the account-management routes below — student auto-create only needs
   `create:users`.)
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

### Editing student accounts, and creating teacher/staff accounts

With the same Management API credentials, the admin panel can also:

- Edit a student's name, nickname, contact email, phone, course, Auth0
  `username`, and Auth0 password (`PATCH /students/:id`,
  `POST /students/:id/reset-password`) and upload a profile photo
  (`POST /students/:id/avatar`, stored in R2 under `avatars/students/...`).
  The student's *login* email (`<id>@STUDENT_EMAIL_DOMAIN`) is never changed
  by these routes — that convention is load-bearing for the student portal.
- Create teacher/staff login accounts in-app (`POST /staff`) and edit their
  name/phone/title/photo (`PATCH /staff/:identity`,
  `POST /staff/:identity/avatar`).
- Send a self-service password-change link
  (`POST /staff/:identity/password-ticket`) or passkey/MFA enrollment link
  (`POST /staff/:identity/passkey-ticket`) for the teacher/staff member to
  open on their own device — a WebAuthn passkey ceremony can only run on the
  enrolling user's own device, so these return a link for the admin to send
  rather than performing the enrollment directly.

To let `POST /staff` also assign the right Auth0 role, set the role ids in
`wrangler.toml` (`AUTH0_ADMIN_ROLE_ID` / `AUTH0_TEACHER_ROLE_ID` /
`AUTH0_STAFF_ROLE_ID`, from step 4 above — copy each from **User Management
→ Roles → [role]**, the id is in the URL, e.g. `rol_AbC123`). If a role id
isn't set, the account is still created — the response just says to assign
the role manually.

New teacher/staff accounts land in `AUTH0_STAFF_CONNECTION`. **Set this
explicitly** to your normal staff database connection (typically
`Username-Password-Authentication`) — it falls back to `AUTH0_DB_CONNECTION`
if unset, but that's the *student* connection (`LITALK-Student`), which you
almost certainly don't want teacher/staff logins mixed into.

The passkey ticket (`POST /staff/:identity/passkey-ticket`) enrolls the
`webauthn-platform` factor specifically (Face ID / Windows Hello / a device's
built-in authenticator — i.e. a passkey, not a roaming security key). This
factor must be turned on first: **Auth0 Dashboard → Security → Multi-factor
Auth → enable "WebAuthn with Device Biometrics"**. If it's off, enrollment
tickets for it will fail.

## Stripe setup (payment links)

1. Get the secret key from the Stripe Dashboard (**Developers → API keys**)
   and store it:
   ```sh
   npx wrangler secret put STRIPE_SECRET_KEY
   ```
2. Create a webhook endpoint (**Developers → Webhooks → Add endpoint**):
   - URL: `https://api.litalkeducation.com/stripe/webhook`
   - Event: `checkout.session.completed`
   Then store its signing secret:
   ```sh
   npx wrangler secret put STRIPE_WEBHOOK_SECRET
   ```

Payment links are single-use (one completed payment each) and carry the
student id + creator email as metadata; when Stripe reports the session as
paid, the webhook records a `payments` row automatically (source `stripe`)
and marks the link `paid`. Amounts are THB.

Every payment link allows promotion codes, so the checkout page shows an
"Add promotion code" field. To create a discount, add a **Coupon** and a
**Promotion Code** for it in the Stripe Dashboard (**Product catalog →
Coupons**); Stripe applies the discount and reports the discounted
`amount_total` to the webhook, so the recorded payment already reflects it.

The "สร้างลิงก์ชำระเงิน" admin form also has an optional promo code field —
filling it pre-fills (via `?prefilled_promo_code=`) that code on the
checkout page so the customer doesn't have to type it themselves; they can
still edit or clear it. Payment Links have no API parameter to force-apply
a coupon, so this pre-fill is the closest equivalent. Once paid, the actual
discount amount (from `total_details.amount_discount`) is stored on the
link and shown in the "ลิงก์ล่าสุด" list.

## Google Meet auto-creation (booking)

Every time a class is booked — the manual "จองเวลาเรียน" wizard, a monthly
schedule activating on payment, or an add-hours amendment — the Worker
creates a Google Calendar event for that session with a Google Meet
conference attached, and stores the link on the booking row
(`bookings.meet_link`). Cancelling that booking (student deletion, schedule
resync, a "withdraw hours" amendment) deletes the Calendar event too. If
Google Meet isn't configured, or the API call fails, the booking is still
created — it's just missing a link.

**Auth approach:** this uses a plain OAuth "refresh token" — not a service
account, since service accounts can only impersonate other users (and thus
create Meet links) via Google Workspace domain-wide delegation, which a
personal/plain Gmail account doesn't have. Instead, one human logs into the
Google account that should own the class calendar (a teacher's Gmail, or a
dedicated one you create for this, e.g. `litalk.classes@gmail.com`) **once**,
which mints a refresh token the Worker reuses indefinitely.

1. In [Google Cloud Console](https://console.cloud.google.com/) (any Google
   account works — no Workspace needed), create a project, then
   **APIs & Services → Library** → enable the **Google Calendar API**.
2. **APIs & Services → OAuth consent screen**:
   - User type: **External**.
   - Fill in the required fields (app name, your email as support/developer
     contact) — anything reasonable is fine, this app is only ever used by
     you.
   - Scopes: add `https://www.googleapis.com/auth/calendar.events`.
   - Under **Audience**, click **Publish App** to move it from "Testing" to
     "In production". **This matters**: refresh tokens minted while the
     consent screen is still "Testing" expire after 7 days. Publishing
     doesn't require Google's verification review for this use case — you'll
     just see an "unverified app" warning during login in the next step
     (click **Advanced → Go to [app name] (unsafe)** to continue), which is
     expected and fine for a single-account internal tool.
3. **APIs & Services → Credentials → Create Credentials → OAuth client ID**.
   - Application type: **Desktop app**.
   - Copy the **Client ID** and **Client secret** it generates.
4. Run the helper script from `worker/`, which opens a login page, catches
   the redirect locally, and prints the refresh token:
   ```sh
   npm run google-oauth-setup
   ```
   Paste the Client ID / Client secret when prompted, then open the printed
   URL and log into the Google account that should own the class calendar
   (approve the "unverified app" warning as noted above). It prints three
   values — store them as Worker secrets exactly as it shows:
   ```sh
   npx wrangler secret put GOOGLE_OAUTH_CLIENT_ID
   npx wrangler secret put GOOGLE_OAUTH_CLIENT_SECRET
   npx wrangler secret put GOOGLE_OAUTH_REFRESH_TOKEN
   ```

`GOOGLE_CALENDAR_ID` is optional and defaults to that account's own
`primary` calendar; set it only if events should land on a different
calendar the account has write access to.

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

`PUBLIC_FILES_ORIGIN` in `wrangler.toml` should be a custom domain you route
to this same Worker in the Cloudflare dashboard (**Workers & Pages → this
Worker → Settings → Domains & Routes**); it only affects how shareable file
links are displayed, not where they're served from. If unset, links fall
back to the request's own origin.

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
   curl -X POST https://api.litalkeducation.com/import \
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
| POST   | `/students`              | admin          | Creates student (+ Auth0 login if configured) |
| PATCH  | `/students/:id`          | admin          | Edit name/nickname/email/phone/course + Auth0 username/password (login email unchanged) |
| POST   | `/students/:id/reset-password` | admin    | Sets (or generates) a new Auth0 password, returned once |
| POST   | `/students/:id/avatar`   | admin          | multipart form: `file` (image, ≤5MB) — profile photo |
| GET    | `/students/:id/avatar`   | `data:read`+visibility | Streams the student's profile photo from R2 |
| DELETE | `/students/:id`          | admin          | Soft-deletes the student in-app; Auth0 login untouched |
| GET    | `/staff`                 | admin          | List staff/teacher directory (login identities + profile) |
| POST   | `/staff`                 | admin          | Creates a teacher/staff Auth0 login (+ role if configured) |
| PATCH  | `/staff/:identity`       | admin          | Edit name/phone/title |
| POST   | `/staff/:identity/avatar` | admin         | multipart form: `file` (image, ≤5MB) — profile photo |
| GET    | `/staff/:identity/avatar` | (any valid token) | Streams the staff member's profile photo from R2 |
| POST   | `/staff/:identity/password-ticket` | admin  | Returns a self-service password-change link |
| POST   | `/staff/:identity/passkey-ticket` | admin   | Returns a self-service passkey/MFA enrollment link |
| GET    | `/student-check/:id`     | `data:read`    | Check screen data: payment, study days, logs, schedules, credit balance |
| POST   | `/schedules`             | `data:write`   | Teacher submits a monthly schedule (credits applied first) |
| GET    | `/schedules?status=`     | `data:read`    | Teachers see own submissions; admins see all |
| PATCH  | `/schedules/:id`         | `data:write`   | Owner/admin edits pending/rejected/revise (re-prices, resubmits); admin edits paid schedule's hours (reductions → credit) |
| POST   | `/schedules/:id/approve` | admin          | Approves + creates the parent's Stripe payment link |
| POST   | `/schedules/:id/reject`  | admin          | Rejects with an optional reason                |
| POST   | `/schedules/:id/revise`  | admin          | Asks the teacher to revise (status `revise`) instead of rejecting |
| POST   | `/schedules/:id/cancel`  | `data:write`   | Teacher cancels own; admin any not-yet-paid       |
| POST   | `/schedules/:id/amend`   | `data:write`   | Request/perform an add or withdraw-hours change on an approved/active schedule |
| GET    | `/schedules/:id/amendments` | `data:read` | Amendment history for one schedule |
| GET    | `/schedule-amendments?status=` | `data:read` | Teachers see own requests; admins see all |
| POST   | `/schedule-amendments/:id/approve` | admin | Approves a teacher's pending request (runs the credit/charge decision) |
| POST   | `/schedule-amendments/:id/reject` | admin | Rejects with an optional reason |
| POST   | `/schedule-amendments/:id/cancel` | `data:write` | Teacher cancels own pending; admin cancels pending/awaiting-payment |
| GET    | `/teacher-assignments`   | admin          | Per-teacher visible-student lists (with names)  |
| PUT    | `/teacher-assignments/:identity` | admin  | Replaces a teacher's visible-student set (empty = sees nothing) |
| GET    | `/staff-identities`      | admin          | Known login identities + display names (for assigning visibility) |
| GET    | `/students/:id/credits`  | admin          | Credit balance + ledger history (manual adjustments + schedule/amendment entries) |
| POST   | `/students/:id/credits/adjust` | admin    | `{ hours, reason }` — manual credit adjustment (hours can be negative) |
| GET    | `/finance?month=`        | admin          | All transactions + per-teacher & per-recorder income |
| POST   | `/study-logs`            | `data:write`   | `{ studentId, date, feedback, video }` |
| GET    | `/students/:id/study-logs` | `data:read`  | A student's study logs (for editing) |
| PATCH  | `/study-logs/:id`        | `data:write`   | Edit an existing study log         |
| POST   | `/payments`              | `data:write`   | Manual payment record              |
| PATCH  | `/payments/:id`          | admin          | Correct a payment's amount/method/date |
| POST   | `/bookings`              | `data:write`   | 409 if the date+time slot is taken; response includes `meetLink` if Google Meet is configured |
| GET    | `/bookings?from=`        | `data:read`    | Upcoming bookings (visibility-filtered), each with `meetLink` |
| GET    | `/dashboard?range=`      | `data:read`    | `today` \| `week` \| `month` \| `year`; includes weekly classes |
| GET    | `/earnings?month=`       | `data:read`    | Admin: full totals. Teacher: assigned-students total only |
| POST   | `/payment-links`         | admin          | Creates a Stripe payment link      |
| GET    | `/payment-links`         | `data:read`    | Last 30 links with status          |
| POST   | `/payment-links/:id/deactivate` | `data:write` | Disables an active link     |
| POST   | `/files/:fileId/public-link` | `files:write` | Mint/return a shareable public download link |
| GET    | `/public/files/:token`   | (public)       | Streams a file by its public token |
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

Every Stripe payment link this system creates has its description built
automatically from the sessions being billed (dates + times) unless the
approver supplies a custom one, and always ends with the fixed no-refund
policy note (`STRIPE_POLICY_NOTE` in `stripe.ts`).

## Schedule amendments (add / withdraw hours)

Once a schedule is `approved` or `active`, a teacher can request extra or
fewer sessions via `POST /schedules/:id/amend` (`{ type: 'add'|'remove',
sessions, note }`). An admin performing the same call decides it
immediately instead of leaving it `pending`.

- **remove**: the listed sessions are dropped right away (and their
  bookings cancelled if the schedule is active) and converted 1:1 into
  `student_credits` — no payment is ever involved.
- **add**: the student's credit balance is spent first
  (`min(balance, sessionCount)`); only sessions left uncovered are billed —
  a Stripe link if configured (metadata carries `amendment_id`), else a
  manual payment activates it later. Fully credit-covered requests apply
  immediately with nothing to charge.

`POST /schedule-amendments/:id/approve` runs this same decision for a
teacher's pending request. `.../reject` and `.../cancel` release any
credit that was tentatively reserved and deactivate any Stripe link that
was created.

## Teacher visibility

`teacher_students` maps a teacher's **request identity** to the students
they may see. A non-admin teacher sees **only** their assigned students —
including **none**: a teacher with no rows sees nothing, and the admin UI
shows them a "contact staff" empty state with no menus. Once assigned,
`/students`, `/student-check/:id`, the dashboard's per-student lists, the
file routes, and the create/edit endpoints (`/study-logs`, `/payments`,
`/bookings`, `/schedules`) are restricted to that set. `/earnings` returns
a teacher only the combined income of their assigned students (never the
school-wide total). Admins are always unrestricted.

Teachers cannot create students or bill through Stripe — `POST /students`
and `POST /payment-links` are admin-only.

## Class-hour credits

When an admin trims a paid schedule's hours (`PATCH /schedules/:id`) or a
"withdraw hours" amendment is applied, the removed sessions become credit
in `student_credits` (1 credit = 1 hour). A student's balance is spent
automatically the next time hours are added for them — a new schedule or
an "add hours" amendment — covering sessions first, with only the
remainder charged. Reserved credit is released if a schedule/amendment is
edited, rejected, or cancelled before it is paid.

## Public file links

`POST /files/:fileId/public-link` mints an opaque, unauthenticated token
(`GET /public/files/:token` streams the file). The URL returned uses
`PUBLIC_FILES_ORIGIN` (a custom domain routed to this same Worker) instead
of the Worker's own `workers.dev` origin, so shared links look like the
student-facing site.

## Payment verification

Both `GET /student-check/:id` and `GET /finance` expose a payment's
`proof_url` and, for Stripe payments, `stripe_session_id` — but only to
admins (the fields are stripped for teachers). The admin UI surfaces these
as a "view proof" link and a Payment ID.

## Staff names

`staff` maps each login identity to a display name (captured from the
token on every authenticated request via `recordStaff`). The admin UI shows
names instead of raw `auth0|...` subs in the visibility, schedule, and
finance screens.

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
  exposes the same data the old Sheet endpoint did — name, course, study
  logs, and payment history — plus two additions for the student site:
  `schedule` (upcoming `booked` classes only; a withdrawn hour flips its
  booking to `cancelled` and simply disappears from this list) and
  `pendingPayments` (active Stripe payment links awaiting checkout, so the
  site can show a "pay now" prompt). Locking this endpoint down properly
  would mean issuing student-audience Auth0 tokens and verifying them here
  — a separate piece of work.
- `ALLOWED_ORIGIN` (comma-separated) must include both the admin panel and
  the public site origins.
