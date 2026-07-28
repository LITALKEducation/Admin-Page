// Scheduled service notices — the popup that announces planned downtime and
// then enforces it. See migrations/0023_service_notices.sql for the shape.
//
// Two rules shape everything here:
//
//   Fail open. If this code throws, callers treat it as "no notices". A
//   maintenance system that takes the site down when it errors is worse than
//   not having one.
//
//   Admins are never locked out. The 'admin' surface closes the admin panel
//   to teachers and other staff, but the Admin role passes through it — the
//   exemption is in the code, not in a setting someone can switch off, so
//   whoever turns a notice on can always turn it off again. On the API an
//   admin token passes every block; on public pages that have no login, a
//   bypass token stands in.

export type ServiceSurface =
  | 'website'
  | 'ask'
  | 'chat_site'
  | 'portal'
  | 'chat_portal'
  | 'checkin'
  | 'booking'
  | 'admin';

// The legal pages are deliberately absent: someone must be able to read the
// terms and the privacy notice at any time, including while the service they
// describe is down.
export const SERVICE_SURFACES: ServiceSurface[] = [
  'website',
  'ask',
  'chat_site',
  'portal',
  'chat_portal',
  'checkin',
  'booking',
  'admin',
];

export type ServicePreset =
  | 'opening_soon'
  | 'trial_opening_soon'
  | 'closing_soon'
  | 'trial_closing_soon'
  | 'custom';

export const SERVICE_PRESETS: ServicePreset[] = [
  'opening_soon',
  'trial_opening_soon',
  'closing_soon',
  'trial_closing_soon',
  'custom',
];

export type NoticePhase = 'announcement' | 'blocking';

export interface ServiceNotice {
  id: number;
  enabled: boolean;
  preset: ServicePreset;
  surfaces: ServiceSurface[];
  titleTh: string;
  titleEn: string;
  bodyTh: string;
  bodyEn: string;
  announceFrom: string | null;
  startsAt: string | null;
  endsAt: string | null;
  dismissible: boolean;
  updatedAt?: string;
  updatedBy?: string | null;
}

export interface ActiveNotice extends ServiceNotice {
  phase: NoticePhase;
}

interface NoticeRow {
  id: number;
  enabled: number;
  preset: string;
  surfaces: string;
  title_th: string;
  title_en: string;
  body_th: string;
  body_en: string;
  announce_from: string | null;
  starts_at: string | null;
  ends_at: string | null;
  dismissible: number;
  updated_at: string | null;
  updated_by: string | null;
}

function parseSurfaces(raw: string): ServiceSurface[] {
  try {
    const value = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter((s): s is ServiceSurface => SERVICE_SURFACES.includes(s as ServiceSurface));
  } catch {
    return [];
  }
}

function toNotice(row: NoticeRow): ServiceNotice {
  return {
    id: row.id,
    enabled: row.enabled !== 0,
    preset: (SERVICE_PRESETS.includes(row.preset as ServicePreset) ? row.preset : 'custom') as ServicePreset,
    surfaces: parseSurfaces(row.surfaces),
    titleTh: row.title_th,
    titleEn: row.title_en,
    bodyTh: row.body_th,
    bodyEn: row.body_en,
    announceFrom: row.announce_from,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    dismissible: row.dismissible !== 0,
    updatedAt: row.updated_at ?? undefined,
    updatedBy: row.updated_by,
  };
}

// Times are stored as ISO strings in UTC. Comparing them here rather than in
// SQL keeps the phase rule in one readable place, and there are never enough
// notices for the difference to matter.
function phaseFor(notice: ServiceNotice, now: number): NoticePhase | null {
  const at = (value: string | null) => (value ? Date.parse(value) : NaN);

  const ends = at(notice.endsAt);
  if (!Number.isNaN(ends) && now >= ends) return null; // expired

  const starts = at(notice.startsAt);
  if (!Number.isNaN(starts) && now >= starts) return 'blocking';

  const announce = at(notice.announceFrom);
  // No announce_from means the notice is live as soon as it is enabled —
  // which is what an admin flipping it on by hand expects.
  if (Number.isNaN(announce) || now >= announce) return 'announcement';

  return null; // scheduled, not yet visible
}

export async function listNotices(db: D1Database): Promise<ServiceNotice[]> {
  const { results } = await db
    .prepare(`SELECT * FROM service_notices ORDER BY COALESCE(starts_at, announce_from, created_at) DESC, id DESC`)
    .all<NoticeRow>();
  return (results ?? []).map(toNotice);
}

// What the public status endpoint serves: only what is visible right now.
export async function activeNotices(db: D1Database, now = Date.now()): Promise<ActiveNotice[]> {
  const { results } = await db
    .prepare(`SELECT * FROM service_notices WHERE enabled = 1`)
    .all<NoticeRow>();

  const active: ActiveNotice[] = [];
  for (const row of results ?? []) {
    const notice = toNotice(row);
    const phase = phaseFor(notice, now);
    if (phase) active.push({ ...notice, phase });
  }
  return active;
}

// Whether a surface is currently blocked. Used by the API routes; the popup
// is only the visible half of a notice, and a client that ignores it must
// still be refused.
export async function surfaceBlocked(db: D1Database, surface: ServiceSurface): Promise<ActiveNotice | null> {
  try {
    const notices = await activeNotices(db);
    return notices.find((n) => n.phase === 'blocking' && n.surfaces.includes(surface)) ?? null;
  } catch (err) {
    // Fail open: a database hiccup must not take the surface down.
    console.error(`serviceNotices: block check failed for ${surface}`, err);
    return null;
  }
}

export function blockedMessage(notice: ActiveNotice, lang: string): string {
  const th = lang === 'th';
  const body = th ? notice.bodyTh : notice.bodyEn;
  const title = th ? notice.titleTh : notice.titleEn;
  return (
    body ||
    title ||
    (th ? 'ระบบปิดปรับปรุงชั่วคราว กรุณาลองใหม่อีกครั้งภายหลัง' : 'This service is temporarily unavailable. Please try again later.')
  );
}

const MAX_TEXT = 2000;

export function sanitizeNotice(raw: unknown): Omit<ServiceNotice, 'id'> {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const text = (value: unknown) => (typeof value === 'string' ? value.slice(0, MAX_TEXT) : '');
  // Accepts anything Date can parse and normalises to ISO, so the client can
  // send a datetime-local value without also having to format it.
  const time = (value: unknown) => {
    if (typeof value !== 'string' || !value.trim()) return null;
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : new Date(ms).toISOString();
  };
  const surfaces = Array.isArray(source.surfaces)
    ? source.surfaces.filter((s): s is ServiceSurface => SERVICE_SURFACES.includes(s as ServiceSurface))
    : [];

  return {
    enabled: source.enabled !== false,
    preset: (SERVICE_PRESETS.includes(source.preset as ServicePreset) ? source.preset : 'custom') as ServicePreset,
    surfaces,
    titleTh: text(source.titleTh),
    titleEn: text(source.titleEn),
    bodyTh: text(source.bodyTh),
    bodyEn: text(source.bodyEn),
    announceFrom: time(source.announceFrom),
    startsAt: time(source.startsAt),
    endsAt: time(source.endsAt),
    dismissible: source.dismissible !== false,
  };
}

export async function insertNotice(db: D1Database, n: Omit<ServiceNotice, 'id'>, by: string): Promise<number> {
  const result = await db
    .prepare(
      `INSERT INTO service_notices
         (enabled, preset, surfaces, title_th, title_en, body_th, body_en,
          announce_from, starts_at, ends_at, dismissible, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      n.enabled ? 1 : 0, n.preset, JSON.stringify(n.surfaces),
      n.titleTh, n.titleEn, n.bodyTh, n.bodyEn,
      n.announceFrom, n.startsAt, n.endsAt, n.dismissible ? 1 : 0, by,
    )
    .run();
  return Number(result.meta?.last_row_id ?? 0);
}

export async function updateNotice(db: D1Database, id: number, n: Omit<ServiceNotice, 'id'>, by: string): Promise<void> {
  await db
    .prepare(
      `UPDATE service_notices SET
         enabled = ?, preset = ?, surfaces = ?,
         title_th = ?, title_en = ?, body_th = ?, body_en = ?,
         announce_from = ?, starts_at = ?, ends_at = ?, dismissible = ?,
         updated_at = CURRENT_TIMESTAMP, updated_by = ?
       WHERE id = ?`,
    )
    .bind(
      n.enabled ? 1 : 0, n.preset, JSON.stringify(n.surfaces),
      n.titleTh, n.titleEn, n.bodyTh, n.bodyEn,
      n.announceFrom, n.startsAt, n.endsAt, n.dismissible ? 1 : 0, by, id,
    )
    .run();
}

// Turns off every notice that is blocking something right now — what the
// panel's "reopen everything" button calls. It disables rather than deletes
// so the record of the closure survives, and it only touches notices that are
// actually blocking, leaving scheduled and announcement-only ones alone.
export async function disableBlockingNotices(db: D1Database, by: string): Promise<number> {
  const blocking = (await activeNotices(db)).filter((n) => n.phase === 'blocking');
  if (!blocking.length) return 0;
  await db.batch(
    blocking.map((n) =>
      db
        .prepare(`UPDATE service_notices SET enabled = 0, updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE id = ?`)
        .bind(by, n.id),
    ),
  );
  return blocking.length;
}

export async function bypassTokenMatches(db: D1Database, token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const row = await db.prepare(`SELECT bypass_token AS t FROM service_settings WHERE id = 1`).first<{ t: string }>();
  return Boolean(row?.t) && row!.t === token;
}

export async function getBypassToken(db: D1Database): Promise<string> {
  const row = await db.prepare(`SELECT bypass_token AS t FROM service_settings WHERE id = 1`).first<{ t: string }>();
  return row?.t ?? '';
}

export async function rotateBypassToken(db: D1Database): Promise<string> {
  const token = crypto.randomUUID().replace(/-/g, '');
  await db
    .prepare(`UPDATE service_settings SET bypass_token = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1`)
    .bind(token)
    .run();
  return token;
}
