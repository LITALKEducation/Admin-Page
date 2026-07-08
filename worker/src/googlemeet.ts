// Auto-creates a Google Meet link for each booked class by creating a
// Calendar event (with conferenceData) on a real Google account's calendar.
// No googleapis SDK — a minimal REST client matching the style of stripe.ts.
//
// Auth: a plain OAuth "refresh token" flow (not a service account — that
// needs Google Workspace domain-wide delegation, which a personal/plain
// Gmail account doesn't have). One human logs into the Google account that
// should own the class calendar, one time, via
// `npm run google-oauth-setup` (see worker/README.md); that mints a
// refresh token which is stored as a Worker secret and reused forever to
// mint short-lived access tokens for the Calendar API.
import type { Env } from './types';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DEFAULT_DURATION_MINUTES = 60;

export class GoogleCalendarError extends Error {}

// One access token per isolate, reused until ~1 min before it expires — an
// access token is good for an hour, and each isolate can handle many
// bookings, so this saves a token exchange round trip per booking.
let cachedToken: { token: string; expiresAt: number } | null = null;
let inFlight: Promise<string> | null = null;

async function getAccessToken(env: Env): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.token;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: env.GOOGLE_OAUTH_REFRESH_TOKEN!,
        client_id: env.GOOGLE_OAUTH_CLIENT_ID!,
        client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET!,
      }),
    });
    const json = (await res.json()) as { access_token?: string; expires_in?: number; error_description?: string };
    if (!res.ok || !json.access_token) {
      throw new GoogleCalendarError(json.error_description ?? `Google token refresh failed (HTTP ${res.status})`);
    }
    cachedToken = { token: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 - 60_000 };
    return json.access_token;
  })();

  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

// True once the settings needed to call the Calendar API are present;
// callers use this to skip silently (booking still succeeds without a link)
// when Google Meet integration hasn't been configured.
export function googleMeetConfigured(env: Env): boolean {
  return Boolean(env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET && env.GOOGLE_OAUTH_REFRESH_TOKEN);
}

export interface MeetEvent {
  eventId: string;
  meetLink: string | null;
}

function calendarId(env: Env): string {
  return env.GOOGLE_CALENDAR_ID?.trim() || 'primary';
}

// Creates a Calendar event with an attached Google Meet conference for one
// booked class session. Returns null (never throws) if Google Meet isn't
// configured or the API call fails — bookings must succeed either way.
export async function createMeetEvent(
  env: Env,
  opts: { studentName: string; course?: string | null; date: string; time: string; durationMinutes?: number },
): Promise<MeetEvent | null> {
  if (!googleMeetConfigured(env)) return null;
  try {
    const token = await getAccessToken(env);
    const start = `${opts.date}T${opts.time}:00`;
    const startDate = new Date(`${start}+07:00`);
    const end = new Date(startDate.getTime() + (opts.durationMinutes ?? DEFAULT_DURATION_MINUTES) * 60_000);

    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId(env))}/events?conferenceDataVersion=1&sendUpdates=none`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          summary: `คลาสเรียน LITALK - ${opts.studentName}${opts.course ? ` (${opts.course})` : ''}`,
          description: 'สร้างอัตโนมัติจากระบบจองเวลาเรียน LITALK Admin',
          start: { dateTime: start, timeZone: 'Asia/Bangkok' },
          end: { dateTime: end.toISOString().slice(0, 19), timeZone: 'Asia/Bangkok' },
          conferenceData: {
            createRequest: {
              requestId: crypto.randomUUID(),
              conferenceSolutionKey: { type: 'hangoutsMeet' },
            },
          },
        }),
      },
    );
    const json = (await res.json()) as {
      id?: string;
      hangoutLink?: string;
      error?: { message?: string };
    };
    if (!res.ok || !json.id) {
      console.error('Google Calendar event creation failed:', json.error?.message ?? res.status);
      return null;
    }
    return { eventId: json.id, meetLink: json.hangoutLink ?? null };
  } catch (err) {
    console.error('Google Calendar event creation failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

// Best-effort delete — cancelling a booking must succeed even if this fails
// (e.g. the event was already removed by hand in Calendar).
export async function deleteMeetEvent(env: Env, eventId: string | null | undefined): Promise<void> {
  if (!eventId || !googleMeetConfigured(env)) return;
  try {
    const token = await getAccessToken(env);
    await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId(env))}/events/${encodeURIComponent(eventId)}?sendUpdates=none`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
    );
  } catch (err) {
    console.error('Google Calendar event deletion failed:', err instanceof Error ? err.message : err);
  }
}
