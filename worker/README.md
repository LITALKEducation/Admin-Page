# litalk-files-api

Cloudflare Worker backing the "Student Files" feature (upload / list /
download / delete) for the admin panel. Metadata lives in D1 (`litalk`),
blobs live in R2 (`files-litalk`). Everything else in the admin panel (student
records, bookings, payments, study logs) keeps using Google Apps Script —
this Worker is additive, not a replacement.

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
4. **User Management → Roles** → create two roles and assign the permissions
   above from this API:
   - `Admin` → `files:read`, `files:write`, `files:delete`
   - `Teacher` → `files:read`, `files:write`
   Then assign the appropriate role to each staff user (**User Management →
   Users → [user] → Roles**).
5. (Optional but recommended) Add an Auth0 Action (Login Flow) that copies
   the user's email into a namespaced access-token claim, since access
   tokens don't include `email` by default:
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
npm run db:migrate:remote   # applies migrations/0001_init.sql to the real D1 database
# npm run db:migrate:local  # for local `wrangler dev` testing instead
```

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

`file_type` must be one of: `Homework`, `Worksheet`, `Exam`, `Attendance`,
`Certificate`, `Portfolio`, `Other`.

## Scope note

This Worker currently serves **staff** (Teacher/Admin) access only, matching
how the existing admin panel is used today. A "student downloads their own
files" mode is not implemented — it would need a mapping between a student's
Auth0 account and their `student_id`, which is a separate piece of work.
