# LITALK Education — admin panel

Conventions for anyone (person or agent) changing this repo. Written from what
the code actually does. Where a rule exists here, it is usually because
something already broke without it.

## Layout of the repo

```
frontend/          React 19 + TypeScript + Vite 8 — the current panel
  src/components/  one file per screen, plus shared UI
  src/hooks/       useMe, useStudents, useTheme, shared selection
  src/ui/          Toast / Confirm providers
  src/api/client.ts   every call to the Worker, typed, in one file
  src/legacy.css   the panel's stylesheet, unlayered on purpose
app/               the built output — COMMITTED, see below
index.html         the legacy panel: one file, ~11k lines, still in use
worker/            Cloudflare Worker (Hono) + D1
  src/             routes and helpers
  migrations/      applied automatically by deploy-worker.yml
```

Two panels exist at once. `index.html` is the original; `frontend/` is the
replacement served at `/app/`. Both talk to the same Worker and both are live.
Changes to shared behaviour usually need doing in both.

## The build output is committed

`npm run build` in `frontend/` writes to `../app`, and that directory is in
git. **A frontend change is not deployed until you rebuild and commit `app/`.**
Forgetting produces a confusing result: the source looks right and the site
does not change.

## CI

There is **no PR-triggered CI**. Both workflows run on push to `main`.
`deploy-worker.yml` gates on `npm run typecheck` in `worker/` and applies
pending migrations before deploying. Run the checks yourself:

```bash
cd worker    && npm run typecheck
cd frontend  && npx tsc --noEmit && npx oxlint src && npm run build
```

## Routing

`HashRouter`, not `BrowserRouter`. GitHub Pages serves static files with no
server-side rewrite, so a real path like `/app/students` 404s on refresh.
Do not "fix" this by switching router.

## Screens

Every screen is a `.tab-content.active` root containing top-level blocks.

**The screen owns the spacing between its blocks** — `.tab-content.active` is a
flex column with `gap: var(--space-3)`, and top-level children have their
vertical margins zeroed. Do not add `marginTop` / `marginBottom` to a top-level
block; it stacks on the gap instead of replacing it, and inline styles beat the
stylesheet so it will not be caught by the rule.

Before this existed the gap between two cards was whatever margin a component
happened to set: measured across the 20 screens that existed at the time it
was 0, 2, 16, 18, 20, 22 or 24px, and **0px on seven of them**.

Screens are lazily loaded (`lazy()` + `Suspense`) — with 20-odd of them there
is no reason to ship the blog editor or the course builder to someone who
opens the dashboard.

## Segmented controls

Use `components/TabMenu.tsx` rather than hand-rolling a `.tab-menu`. It renders
the sliding pill and owns the measurement; `.tab-menu-pill` had been in
`legacy.css` for a while with no screen rendering the element, so the tabs only
changed colour.

One trap it exists to contain: a `ResizeObserver` on the bar also fires on the
layout pass that follows a tab change. Re-snapping the pill there — the
deliberately un-transitioned path used for first paint — runs straight over the
tween that just started and the pill teleports. It re-snaps only when the bar's
width has actually changed.

## Styling

`src/legacy.css` is kept **unlayered** so it wins the cascade over Tailwind's
layered utilities. Tailwind v4 is present via `@tailwindcss/vite` and shadcn/ui
components exist, but the panel's own look comes from `legacy.css`.

Spacing scale: `--space-1: 8px` … `--space-4: 32px`. Use them.

## Dark mode

Driven by `data-theme` on `<html>`, set by `useTheme`. **Never key a theme
rule on `prefers-color-scheme`** in this app — the OS preference disagrees with
the in-app toggle, and doing so once produced a white logo on a light sidebar
for anyone whose OS was dark while the app was light.

One logo asset, recoloured with `filter: brightness(0) invert(1)` under
`[data-theme="dark"]`. Do not add a second file for the dark variant.

## Dates and timezones

`new Date().toISOString().slice(0, 10)` reads the **UTC** date. Between
midnight and 07:00 Bangkok time it returns yesterday. This bug exists in four
places in the legacy panel and is one of the differences the legacy panel now
warns about. In new code, format from the local date parts.

## Auth

Auth0 SPA, `useRefreshTokens` + `cacheLocation: 'localstorage'`, with
`useRefreshTokensFallback` on (the SDK defaults it to false, which turns "no
refresh token" into an immediate bounce to the login screen).

The session depends on the API having **Allow Offline Access** enabled in the
Auth0 dashboard — see `worker/README.md`. Without it there is no refresh token,
and Safari blocks the iframe fallback, so nobody on an iPhone stays signed in.

`redirect_uri` and the logout `returnTo` are **pinned to the origin**. Deriving
them from `window.location.href` carries any `#fragment` into the value, which
then does not match Auth0's allow-list.

## Authorisation — read before touching a route

`files:delete` doubles as the admin marker (`isAdmin`). Only the Admin role
holds it.

**Every route that takes a `:studentId` must verify the caller owns it.** A
portal chat route once accepted any valid student token for any student id,
exposing another student's schedule, credits and payments. Use
`portalTokenMatchesStudent`.

Admin-only routes go behind `requireAdmin`. The maintenance middleware sits
directly after `verifyAuth` so a route added later is covered without anyone
remembering it exists.

## The maintenance system

`worker/src/serviceNotices.ts`. Two rules shape all of it:

- **Fail open.** `surfaceBlocked()` catches its own errors and reports "not
  blocked". A maintenance system that takes the site down when *it* errors is
  worse than not having one.
- **Admins are never locked out.** The Admin role passes through the `admin`
  surface. That exemption is a line of code, not a setting, so the person who
  closed the panel can always reopen it.

Notices expire on their own, so a forgotten row cannot keep the site down.

When adding a surface, add it to `SERVICE_SURFACES` **and** to `SURFACES` in
`ServiceScreen.tsx` — the whole-system switch derives its list from the latter
so a new surface is included by default.

## Migrations

Numbered SQL in `worker/migrations/`, applied automatically on deploy. They run
forward only; there is no rollback. D1 is SQLite **without**
`SQLITE_ENABLE_UPDATE_DELETE_LIMIT`, so `DELETE … LIMIT` does not work — use
`DELETE FROM t WHERE id IN (SELECT id FROM t WHERE … LIMIT ?)`.

## API client

Everything the panel calls lives in `src/api/client.ts`, typed. Add new calls
there rather than fetching inline, so the response shapes stay in one place.

## The legacy panel

`index.html` shows a per-screen notice on the five screens that genuinely
behave differently from the React panel. **When a screen reaches parity, remove
its entry from `NEW_PANEL_DIFFS`** rather than leaving a claim that is no
longer true. A banner on every screen becomes noise people learn to skip.

## Testing

There is no test runner. Verification here means driving the real thing in a
browser and reading numbers out of it. The pattern used throughout:

- a temporary `src/qa-mock-auth0.tsx` plus a `vite.qa.config.ts` that aliases
  `@auth0/auth0-react` to it and builds to a scratch directory — the Auth0 CDN
  is unreachable in the sandbox;
- Playwright with `executablePath: '/opt/pw-browsers/chromium'`;
- **both files deleted before committing.**

Two traps worth knowing:

- Navigating between `#routes` is a same-document change, so one screen that
  throws leaves the app unmounted for every screen after it. Force a real load.
- Assert on measurements, not on screenshots. "Looks fine" has been wrong
  several times in this codebase.

## Before you change anything

1. Read the surrounding code and match it.
2. Reuse what is there; check `api/client.ts`, `hooks/` and `ui/` first.
3. Change only what the task needs. Old but working is not a reason to rewrite.
4. If you changed `frontend/`, rebuild and commit `app/`.
5. Run typecheck, lint and build — nothing else will.
