// All dates are stored/compared as YYYY-MM-DD strings in Thailand time
// (UTC+7, no DST), matching how the school actually operates.
export function bangkokToday(): string {
  return new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
}

export function bangkokMonth(): string {
  return bangkokToday().slice(0, 7); // YYYY-MM
}

export function daysAgo(n: number): string {
  return new Date(Date.now() + 7 * 3600_000 - n * 86400_000).toISOString().slice(0, 10);
}

export function isYmd(s: unknown): s is string {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

export function isYm(s: unknown): s is string {
  return typeof s === 'string' && /^\d{4}-\d{2}$/.test(s);
}

export function isHm(s: unknown): s is string {
  return typeof s === 'string' && /^\d{2}:\d{2}$/.test(s);
}
