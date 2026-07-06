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

const THAI_MONTHS_SHORT = [
  'ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.',
  'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.',
];

// Renders a session list as "3 ก.ค. 18:00, 10 ก.ค. 18:00, ..." for Stripe
// payment link descriptions, capped so the string stays a sane length.
export function formatSessionsThai(sessions: Array<{ date: string; time: string }>, maxItems = 6): string {
  const sorted = [...sessions].sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  const items = sorted.slice(0, maxItems).map((s) => {
    const [, m, d] = s.date.split('-');
    return `${Number(d)} ${THAI_MONTHS_SHORT[Number(m) - 1]} ${s.time}`;
  });
  let text = items.join(', ');
  if (sorted.length > maxItems) text += ` และอีก ${sorted.length - maxItems} ครั้ง`;
  return text;
}
