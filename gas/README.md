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
- **`getDashboard` (new)**: `GET ?action=getDashboard&range=today|week|month`.
  Powers the admin console's Dashboard screen with real data aggregated
  from Info / Payment Info / Study Log / Booking. See the "Dashboard data
  rules" section below for exactly what each number means and the
  judgment calls baked in — tune the constants in `buildDashboardData` if
  they don't match how the school actually wants this counted.

## Dashboard data rules (`getDashboard`)

There's no separate "classes taught" record in the Sheet, so a **booking
row is treated as a class**. With that:

- **คลาสเรียน (classes)** — count of bookings whose class date falls in
  the selected range (today/this week/this month).
- **การจองล่วงหน้า (booked)** — of those, the ones still in the future
  (haven't started yet).
- **รายรับ (revenue)** — sum of `total` from Payment Info whose payment
  date falls in the selected range.
- **ค้างชำระ (unpaid)** — count of *active* students (had a booking within
  ±45 days of today) whose last payment is missing or older than 30 days.
  This one **ignores the range selector** — same as the original design
  mock, it's always "current outstanding," not period-scoped.
- **คลาสวันนี้ (today's classes)** and **การแจ้งเตือน (alerts)** are
  always "today" / "recent," regardless of which range tab is active.
  Missing-log alerts look back 3 days for a booking with no matching
  study log (matched by student id + class date).

These are reasonable defaults, not confirmed business rules — the 30-day
"unpaid" cutoff and 45-day "active student" window in particular are
guesses. Adjust `unpaidCutoff`/`activePast`/`activeFuture` in
`buildDashboardData` (`gas/Code.gs`) if the school's actual billing cycle
differs.

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
