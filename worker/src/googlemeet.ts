// Auto-creates a Google Meet link for each booked class by creating a
// Calendar event (with conferenceData) on behalf of a Workspace user via a
// service account + domain-wide delegation. No googleapis SDK — a minimal
// REST client using WebCrypto to sign the auth JWT, matching the style of
// stripe.ts.
//
// Setup (see worker/README.md for the full walkthrough):
//   - Google Cloud service account with a JSON key, domain-wide delegation
//     enabled, authorized for scope https://www.googleapis.com/auth/calendar
//   - GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY (secrets)
//   - GOOGLE_CALENDAR_ORGANIZER_EMAIL: the real Workspace user the service
//     account impersonates — Meet links can only be minted on a real user's
//     calendar, not the service account's own.
//   - GOOGLE_CALENDAR_ID (optional, defaults to that user's "primary" calendar)
import type { Env } from './types';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar';
const DEFAULT_DURATION_MINUTES = 60;

export class GoogleCalendarError extends Error {}

function base64url(bytes: ArrayBuffer | string): string {
  const bin = typeof bytes === 'string' ? bytes : String.fromCharCode(...new Uint8Array(bytes));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Google's JSON key export escapes newlines as literal "\n"; PEM parsing
// needs them as real line breaks.
function importPrivateKey(pem: string): Promise<CryptoKey> {
  const cleaned = pem
    .replace(/\\n/g, '\n')
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s/g, '');
  const der = atob(cleaned);
  const bytes = new Uint8Array(der.length);
  for (let i = 0; i < der.length; i++) bytes[i] = der.charCodeAt(i);
  return crypto.subtle.importKey('pkcs8', bytes, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}

// One access token per isolate, reused until ~1 min before it expires — a
// service-account token is good for an hour, and each isolate can handle
// many bookings, so this saves a JWT-sign + token round trip per booking.
let cachedToken: { token: string; expiresAt: number } | null = null;
let inFlight: Promise<string> | null = null;

async function getAccessToken(env: Env): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.token;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const now = Math.floor(Date.now() / 1000);
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = base64url(
      JSON.stringify({
        iss: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        sub: env.GOOGLE_CALENDAR_ORGANIZER_EMAIL, // impersonate this Workspace user
        scope: CALENDAR_SCOPE,
        aud: TOKEN_URL,
        iat: now,
        exp: now + 3600,
      }),
    );
    const key = await importPrivateKey(env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY!);
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${header}.${claims}`));
    const jwt = `${header}.${claims}.${base64url(signature)}`;

    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt,
      }),
    });
    const json = (await res.json()) as { access_token?: string; expires_in?: number; error_description?: string };
    if (!res.ok || !json.access_token) {
      throw new GoogleCalendarError(json.error_description ?? `Google token request failed (HTTP ${res.status})`);
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

// True once the three settings needed to call the Calendar API are present;
// callers use this to skip silently (booking still succeeds without a link)
// when Google Meet integration hasn't been configured.
export function googleMeetConfigured(env: Env): boolean {
  return Boolean(env.GOOGLE_SERVICE_ACCOUNT_EMAIL && env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY && env.GOOGLE_CALENDAR_ORGANIZER_EMAIL);
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
