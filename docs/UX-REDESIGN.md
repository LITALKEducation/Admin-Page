# LITALK — UX/UI Redesign Strategy & Design System

Audit date: 2026-07-16. Scope: Admin Dashboard (`Admin-Page/index.html` + Cloudflare Worker),
Student Portal + marketing site (`Website/`). Benchmark: Stripe, Notion, Google Classroom, Linear.

This document is grounded in an audit of the **actual codebase**, not a greenfield fantasy.
Each item is tagged: **[exists]** already implemented · **[phase 1]** shipped alongside this
document · **[roadmap]** designed here, built later.

---

## 1. UX Audit — current state

### What the platform already does well

| Area | Evidence |
|---|---|
| Dark/light mode | Full token remap in both apps; portal follows OS + manual toggle, marketing site follows OS (`prefers-color-scheme`) |
| Design tokens | Both apps are token-driven (`--clr-*` on the site, `--bg-*`/`--text-*`/`--brand-*` in admin/portal); dark mode is a token remap, not per-component overrides |
| Loading feedback | Skeleton loaders on dashboard, portal, payments; ~140 uses of toast/skeleton/empty-state/hint patterns in the admin panel alone |
| Progressive disclosure | Sidebar uses collapsible groups; schedule creation is a wizard; blog creation is a step-by-step wizard; advanced actions live in dropdowns |
| Empty states | Every list has a Thai-language empty state with guidance, not a blank void |
| Mobile portal | Bottom navigation, FAB (upgrades to the next class's Meet link), safe-area insets, full-screen chat on phones |
| PWA | Manifest + service worker on the admin panel |
| AI assistant | Three surfaces (staff, portal, general site), admin-tunable per surface, rate-limited |
| Motion system | Named motion tokens (`--duration-*`, `--ease-*`), 150–400 ms range, `prefers-reduced-motion` respected in 20+ places |
| i18n | Marketing site has a full EN/TH toggle (`data-en`/`data-th`); AI replies auto-match user language |
| Localized times | Class times render in the viewer's device timezone (stored canonically as GMT+7) |

### Genuine gaps found

| Gap | Severity | Status |
|---|---|---|
| **No `:focus-visible` styles** in admin panel or marketing site — keyboard users get browser-default or no focus ring | WCAG 2.4.7 failure | **[phase 1]** |
| **Touch targets below 44px**: `.icon-btn` (~30px), `.ai-chat-panel__icon-btn` (28px admin / 30px portal), modal close buttons (32px) | Fitts's Law / WCAG 2.5.8 | **[phase 1]** |
| **No skip-to-content link** — keyboard/screen-reader users must tab through the entire nav on every page | WCAG 2.4.1 | **[phase 1]** |
| Admin panel has **no mobile bottom nav** — 14 screens behind a hamburger drawer only | Mobile efficiency | **[phase 2 — done]** |
| No command palette — power users (admins doing data entry all day) have no keyboard-first navigation | Flexibility & efficiency (Nielsen #7) | **[phase 2 — done]** |
| No bulk actions / CSV import-export on the student list | Admin efficiency | **[phase 2 — done]** |
| Admin bell only mirrored dashboard unpaid alerts — no schedule/amendment queue awareness | Visibility of status | **[phase 2 — done]** (role-aware `GET /notifications`) |
| Analytics limited to dashboard stat cards + finance screen — no trend charts | Insight | **[roadmap]** |
| Portal has no notifications center; pending payments are the only "alert" surface | Visibility of status | **[roadmap]** |
| No learning-progress/streak/achievement layer in the portal | Engagement | **[roadmap]** |

---

## 2. Redesign strategy

**Principle: evolve the existing token system, don't rebuild.** Both apps already share an
Apple-inspired monochrome language. The strategy is three moves:

1. **Unify** — one documented token set (§7) that both apps map to. Today the site uses
   `--clr-*` and the admin/portal use `--bg-*`/`--text-*`; same values, two vocabularies.
   New components should consume the shared semantic names; existing CSS migrates opportunistically.
2. **Harden** — accessibility floor: focus rings, ≥44px touch targets on coarse pointers,
   skip links, ARIA on dynamic regions. (Phase 1 ships the first three.)
3. **Extend** — new capability (command palette, analytics, notifications, progress layer)
   built *inside* the hardened system, never as one-off styling.

---

## 3. Sitemap

### Admin panel (14 screens, grouped — groups already exist in the sidebar)

```
Dashboard
├─ ภาพรวม (Dashboard)                    ── stats, today's classes, weekly grid, alerts
นักเรียน (Students)
├─ รายชื่อนักเรียน (list)  ├─ โปรไฟล์นักเรียน (check/profile)
├─ ไฟล์นักเรียน (files)    └─ สร้างบัญชีนักเรียน (create)
การเรียนการสอน (Teaching)
├─ บันทึกการเรียน (logs)   ├─ จองเวลาเรียน (booking)
├─ ตารางเรียนรายเดือน (schedule) └─ ปรับชั่วโมงเรียน (hours)
การเงิน (Finance)
├─ บันทึกชำระเงิน (payments) ├─ การเงินรวม (finance) └─ เครดิตชั่วโมง (credits)
ระบบ (System)
├─ สิทธิ์การมองเห็น (access) ├─ Blog └─ บัญชีครู/เจ้าหน้าที่ (staff)
```

### Student portal (3 tabs + modal layers)

```
ภาพรวม (Overview) ── hero/profile, stats, teacher card, pending payments,
│                    next class spotlight, schedule, files, previews
├─ บันทึกการเรียน (Study log — full timeline, month-grouped)
├─ การชำระเงิน (Payments — pending + history)
└─ Modals: profile edit (nickname/photo), AI chat
```

### Marketing site

`Home → Programs → About → Blog → Student Portal` + general AI chat on every page.

---

## 4. Key user flows

1. **Parent checks "is my child out of hours?"** (the #1 recurring question)
   `Portal link/login → Overview → membership badge + credit stat + upcoming schedule`
   *Fixed in this cycle:* badge now reflects credit **or** upcoming paid classes, and the AI
   assistant answers from real account data — two self-service layers before a human is asked.
2. **Teacher submits a month's schedule**
   `Schedule screen → wizard (student → month → sessions, time inherited row-to-row) → submit
   → admin approves → payment link auto-created → parent pays → sessions auto-book + Meet links`
3. **Admin onboards a student**
   `Create screen → name/course → Auth0 login auto-created → one-time credentials shown → portal live`
4. **Visitor → lead**: `Home → general AI chat / programs → LINE OA or portal login`

Each flow keeps the Nielsen "visibility of status" invariant: every async step has a
skeleton → success toast / error modal with recovery wording.

---

## 5. Wireframe descriptions (target state)

- **Admin dashboard**: stat cards (4-up desktop / 2-up mobile) → weekly teaching grid
  (7-column desktop / horizontally scrollable mobile) → two-column "today's classes" +
  quick actions/alerts. Timeframe tabs (today/week/month/year) stay top-right as a
  segmented control. **[exists]** — add trend sparklines to stat cards **[roadmap]**.
- **Student list**: search + filter chips above a virtualized table; checkbox column for
  bulk actions (message, export, tag); row → profile screen **[roadmap]**.
- **Portal overview**: hero (avatar, name, ID chips, membership badge, 2 primary actions +
  overflow menu) → 4 stat cards → teacher card → alerts → next-class spotlight → schedule
  table → files → previews **[exists]**.
- **Notifications center**: bell icon in both headers; panel lists payment reminders,
  schedule changes, announcements; each row deep-links to its screen **[roadmap]**.
- **Command palette**: `Ctrl/⌘+K` overlay; fuzzy search across screens, students (by name/ID),
  and actions ("create payment link for…"); recent items first **[roadmap]**.

---

## 6. Component hierarchy

```
Tokens (color/type/space/radius/shadow/motion)
└─ Primitives: Button · IconButton (≥44px coarse) · Input · Select · Textarea · Badge ·
   Avatar · Tooltip · Spinner/Skeleton
   └─ Patterns: Card · StatCard · Table/RowList · Tabs (pill slider) · Modal ·
      Drawer · Dropdown · Toast · EmptyState · Wizard/Stepper · Timeline
      └─ Shells: AdminShell (sidebar + topbar + main) · PortalShell (navbar +
         tabs + bottom-nav + FAB) · SiteShell (frosted nav + footer)
         └─ Screens (14 admin + 3 portal + marketing pages)
```

Rule: screens compose patterns; patterns compose primitives; **only tokens define raw values**.

---

## 7. Design system

### Typography
| Role | Size/weight | Notes |
|---|---|---|
| Display | 32–40px / 700 | Marketing heroes only |
| Heading | 24px / 700 | Screen titles (`h1`) |
| Subheading | 17–18px / 600 | Card titles |
| Body | 14–15px / 400–500 | Default |
| Caption | 12–13px / 500 | Meta, hints, badges |

Fonts: **Montserrat** (Latin) + **Noto Sans Thai** (Thai), self-hosted variable fonts —
already the stack in both apps. *Recommendation: keep it.* Switching Thai to IBM Plex Sans
Thai is possible but a pure taste call; Noto Sans Thai has equivalent legibility, better
weight coverage, and zero migration cost. Revisit only with a brand refresh.

### Color (semantic layer both apps map to)
| Token | Light | Dark | Today's equivalent |
|---|---|---|---|
| `surface-page` | #F5F5F7 / #FFF | #000 | `--bg-primary` / `--clr-bg` |
| `surface-card` | #FFFFFF | #121212–#1D1D1F | `--bg-secondary` / `--clr-light-bg` |
| `border` | #E2E2E7 | #2C2C2E | `--border-color` / `--clr-border` |
| `ink` / `ink-soft` / `ink-muted` | #1D1D1F / #515154 / #6E6E73 | #FFF / #D1D1D6 / #8E8E93 | text tokens |
| `accent-success` | #10B981 + 12% bg | same hue, alpha bg | exists |
| `accent-warning` | #F59E0B + 10% bg | 〃 | exists |
| `accent-danger` | #EF4444 + 8–10% bg | 〃 | exists |
| `accent-info` | #3B82F6 + 10% bg | 〃 | **add** |
| `focus-ring` | brand/ink @ 2px offset 2px | #FFF-based | **[phase 1]** |

Rules: semantic colors never carry meaning alone (always icon + label — color-blind safe);
body text contrast ≥ 4.5:1, large text ≥ 3:1 in both modes.

### Spacing — 8pt grid
`4 / 8 / 12 / 16 / 24 / 32 / 48 / 64`. Card padding 16–24px; section gaps 24–32px;
inline gaps 8–12px. (Current CSS is already ~90% on-grid; new code must be 100%.)

### Radius & shadows
Radius: `sm 10px · md 14px · lg 20px · pill 980px` (matches existing tokens).
Shadows: `sm` 0 1px 4px @ 6% · `md` 0 8px 28px @ 9% · dark mode raises alpha, never lightens surfaces.

### Motion
150–300 ms interactions, 350–400 ms panel reveals; `cubic-bezier(0.22,1,0.36,1)` standard;
everything gated by `prefers-reduced-motion` **[exists]**. Never animate layout on scroll.

---

## 8. Mobile layouts

- Portal: bottom nav (3 tabs, safe-area padded) + FAB **[exists]**; stat grid 2-up;
  payment table swaps to card list **[exists]**; chat is full-screen **[exists]**.
- Admin **[roadmap]**: add a 5-item bottom nav for the highest-frequency screens
  (Dashboard · Students · Logs · Payments · More), keeping the drawer for the long tail —
  Miller's Law at the surface, full depth one tap away.
- All icon-only controls ≥44×44px on coarse pointers **[phase 1]** — done via
  `@media (pointer: coarse)` so desktop keeps its density and touch gets its target size.
- One-handed reach: primary actions bottom-anchored on mobile (FAB, bottom nav, sticky wizard footers).

## 9. Desktop layouts

- Admin: fixed sidebar (collapsible to icon rail **[exists]**) + 1200–1400px max content;
  two-column dashboard grid; tables stay tables.
- Portal: single centered column (max ~1080px), two-column preview grid at the bottom.
- Marketing: 1200px container, `--section-py: 100px` rhythm.

---

## 10. Feature roadmap

**Phase 1 — shipped with this doc**: focus-visible rings everywhere · ≥44px coarse-pointer
touch targets · skip-to-content links · this design system doc.

**Phase 2 — admin efficiency (done)**: command palette (Ctrl/⌘+K) · student-list
search-as-filter + bulk export CSV · admin mobile bottom nav (4 top screens + "more" →
drawer, ≤900px where the sidebar hides) · `accent-info`/`accent-warning` tokens + role-aware
notifications center (`GET /notifications`: admins see the approval queue + unpaid; teachers
see their revise/rejected schedules + unpaid among assigned students; stateless — items
clear when resolved).

**Phase 3 — insight (charts done)**: `GET /analytics` + a "สถิติย้อนหลัง 6 เดือน" block on
the finance screen — inline-SVG monthly bar charts (revenue, classes taught, active
students, new registrations; monochrome ink marks, selective value labels, hover
tooltips, `<details>` table view per chart), horizontal course-mix bars, and stat
tiles incl. month-over-month retention. Still open: smart reports (monthly summary
email).

**Phase 4 — student engagement (progress layer done)**: portal overview now has a
"ความก้าวหน้าการเรียน" section — progress ring (% of the paid plan studied:
done ÷ (done + upcoming + credit)), weekly learning streak (Mon-based; the current
week not yet studied doesn't break it), and six milestone achievements with
earned/locked states — all computed client-side from the payload the page already
fetches. Also on mobile the AI assistant moved **into** the bottom nav (both apps)
instead of a floating button overlapping the bar. **Calendar sync done**:
`GET /portal/:id/calendar.ics` (Bangkok wall-clock → UTC instants; Meet links
deliberately excluded from the public feed) + a subscribe row on the portal's
schedule section (Google / webcal / copy-link). **QR attendance done**: the teacher
opens a per-booking QR from the booking screen (screen-shared in the Meet class or
shown on-site); scanning hits the public `POST /checkin` with a short-lived,
revocable token — possession of a fresh token is the proof of presence, so the
student needs no login. Attendance shows as a green badge on the booking table.
On-site/group events are covered too: staff mint one shared QR per event
(`/checkin-events`, TTL-bound) from the booking screen; scanners self-identify with
their student id (prefilled from the portal cookie, validated against the roster)
and the attendee list is viewable per event in the admin panel.
Still open: certificates, push notifications.

**Phase 5 — scale**: parent accounts as first-class Auth0 identities (today the portal
link is shared) · teacher self-service dashboard · virtualized tables once lists exceed
~500 rows · real-time updates (Durable Objects / SSE) · dark-mode scheduling.

---

## 11. UX-theory justification

- **Nielsen #1 visibility of status**: skeletons on every fetch, toasts on every mutation,
  status badges on schedules/payments **[exists]**; notifications center extends this **[roadmap]**.
- **Nielsen #3 user control**: destructive actions confirm (`confirmDialog`), wizards have
  back buttons, modals close on overlay/Esc **[exists]**.
- **Nielsen #4 consistency**: one token system (§7); the same chat widget pattern on all
  three surfaces; identical badge/status vocabulary in admin and portal.
- **Nielsen #5/#9 error prevention/recovery**: date pickers constrain to the schedule month;
  slot conflicts return 409 with a human message; every error string says *what to do next*
  (refresh, contact LINE OA) **[exists]**.
- **Nielsen #6 recognition over recall**: student pickers use datalists with names, not
  raw IDs; identities resolve to display names (fixed this cycle in schedules/credits/blog).
- **Nielsen #7 flexibility/efficiency**: deep-linkable screens (`?screen=`) **[exists]**;
  command palette is the accelerator for experts **[roadmap]**.
- **Nielsen #8 minimalism**: monochrome palette reserves color for semantics; overflow
  menus hold the long tail (portal hero "…" menu).
- **Hick's Law**: portal hero shows exactly 2 primary actions + overflow; admin row actions
  cap at ~3 icons; timeframe options are 4 segmented tabs, not a dropdown of 12.
- **Fitts's Law**: FAB and bottom nav sit at the thumb's resting zone; **[phase 1]** raises
  every icon control to ≥44px on touch; full-width primary buttons on mobile forms.
- **Miller's Law**: sidebar groups 14 screens into 5 sections **[exists]**; portal is 3 tabs;
  schedule creation chunks into student → month → sessions steps.
- **Gestalt**: *proximity* (8pt-grid card sections), *similarity* (one StatCard/RowList
  pattern reused everywhere), *common region* (cards + `border-radius` group related data),
  *figure-ground* (modal scrim, frosted nav), *continuity* (timeline rail in study logs).
- **Progressive disclosure**: collapsible sidebar groups, wizard steps, "read more" clamps
  on long feedback, admin-only controls hidden via `data-admin-only` **[exists]**.
- **WCAG**: focus rings + skip links + 44px targets **[phase 1]**; color-independent status
  (icon + text everywhere); `aria-expanded`/`role=tablist` on interactive chrome **[exists,
  extend]**; contrast verified per §7.

## 12. Scalability notes

- Token-first CSS means a rebrand or density change is a token diff, not a rewrite.
- The Worker already separates surface concerns (staff/portal/general) — new roles
  (parent, teacher-self-service) slot in as new Auth0 roles + visibility rules, not forks.
- `index.html` at ~11k lines is the biggest long-term risk: when Phase 2 lands, split
  screens into ES modules loaded per-screen (code splitting without a framework migration).
- Keep public/portal endpoints versionless but additive — the portal ships to devices
  that cache HTML aggressively (service worker), so response shapes must stay
  backward-compatible.
