import { FILES_API_AUDIENCE, FILES_API_URL } from '../config';

export type GetTokenFn = () => Promise<string>;

// Mirrors the legacy apiFetch() in index.html: authenticated fetch against
// the Cloudflare Worker (D1-backed) API, JSON in/out.
export async function apiFetch(getAccessTokenSilently: GetTokenFn, path: string, options: RequestInit = {}) {
  const token = await getAccessTokenSilently();
  const headers = new Headers(options.headers);
  headers.set('Authorization', `Bearer ${token}`);
  if (options.body && !(options.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  return fetch(FILES_API_URL + path, { ...options, headers });
}

export function makeTokenGetter(getAccessTokenSilently: (opts: object) => Promise<string>): GetTokenFn {
  return () => getAccessTokenSilently({ authorizationParams: { audience: FILES_API_AUDIENCE } });
}

export interface MeResponse {
  email?: string;
  name?: string;
  permissions: string[];
}

export interface DashboardStats {
  classes: number;
  booked: number;
  revenue: number;
  revenueLabel: string;
  unpaid: number;
}

export interface DashboardClassRow {
  time: string;
  name: string;
  course?: string;
  studentId: string;
  meetLink?: string;
  done: boolean;
}

export interface DashboardAlert {
  type: string;
  studentId: string;
  text: string;
  actionLabel: string;
  screen?: string;
}

export interface DashboardPaymentRow {
  name: string;
  method?: string;
  dateYMD: string;
  total: number;
  studentId: string | null;
}

export interface DashboardWeekRow {
  date: string;
  time: string;
  name: string;
  course?: string;
  studentId: string;
}

export interface DashboardResponse {
  stats: DashboardStats;
  todayClasses: DashboardClassRow[];
  today: string;
  weekClasses: DashboardWeekRow[];
  weekStart: string;
  weekEnd: string;
  alerts: DashboardAlert[];
  revenueSub?: string;
  recentPayments: DashboardPaymentRow[];
}

export type DashboardRange = 'today' | 'week' | 'month' | 'year';

export async function fetchMe(getToken: GetTokenFn): Promise<MeResponse> {
  const token = await getToken();
  const response = await fetch(`${FILES_API_URL}/me`, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

export async function fetchDashboard(getToken: GetTokenFn, range: DashboardRange): Promise<DashboardResponse> {
  const response = await apiFetch(getToken, `/dashboard?range=${encodeURIComponent(range)}`);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}
