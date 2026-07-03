# LITALK Admin Google Apps Script backend

Source for the Google Apps Script Web App that the admin console
(`index.html`, via `gasAppUrl`) and the Cloudflare Worker's sibling
Google Sheets (students, payments, study logs, bookings) run on. This
folder mirrors what's deployed in the Apps Script editor for the project
so it's version-controlled instead of living only in the Apps Script UI.

## What changed vs. the currently deployed script

The admin console redesign added a few optional form fields. This script
stays backward-compatible — every change is either a new optional payload
field (ignored if absent) or a column *appended* after the existing ones,
so nothing already in the Sheet or already deployed breaks:

- **`createStudent`**: now also accepts `nickname`, `phone`, `email`
  (a real contact email — separate from the auto-generated
  `<randomId>@litalkeducation.com` login email, which is unchanged).
  These are appended to the Info sheet as columns E/F/G and also stored
  on the Auth0 user's `user_metadata` (not used for login).
- **`addStudyLog`**: now also accepts `date` (the class date, distinct
  from the submission timestamp), appended as Study Log column E.
- **`addPayment`**: now also accepts `date` (the date the payment was
  for, distinct from the submission timestamp), appended as Payment Info
  column F.
- **`createBooking`**: unchanged.
- **`doGet` (per-student lookup)**: now also returns `nickname`, `phone`,
  `contactEmail` on `info`, and `classDate` / `paymentDate` on the log and
  payment rows, read from the new columns (blank for older rows that
  predate them).
- **`getAllStudents`**: unchanged — still just `{ name, id }` pairs.

The admin console's new **Dashboard** screen (today's classes, revenue,
alerts) currently ships with placeholder data — it has no corresponding
endpoint here yet. Wiring it up would mean new read actions (e.g. a
schedule/aggregation query) added to `doGet`; ask before adding those so
the Sheet layout they'd depend on is agreed first.

## Deploying

1. Open the existing Apps Script project (Extensions → Apps Script from
   the Google Sheet, or script.google.com).
2. Replace the contents of `Code.gs` with this file's contents (or diff
   and merge by hand if the deployed copy has drifted).
3. **Deploy → Manage deployments → Edit (pencil) → New version → Deploy.**
   Re-using the existing deployment keeps the same `/exec` URL, so
   `gasAppUrl` in `index.html` doesn't need to change.
4. Spot-check: submit a class log / payment / new student from the admin
   console and confirm the new columns land in the right place in the
   Sheet.

## Sheet columns after this change

| Sheet | Columns (0-indexed) |
|---|---|
| Info | A name, B id, C course, D lastPaid, **E nickname, F phone, G contactEmail** |
| Study Log | A timestamp, B studentId, C feedback, D video, **E classDate** |
| Payment Info | A timestamp, B studentId, C method, D proof, E total, **F paymentDate** |
| Booking | A timestamp, B studentId, C studentName, D "date time", E notes, F meetLink |

Bold columns are new/appended by this version.
