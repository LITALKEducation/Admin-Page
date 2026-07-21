export function formatBaht(n: number | undefined | null): string {
  return '฿' + Number(n || 0).toLocaleString('en-US');
}

// Class dates/times are stored as Bangkok (GMT+7) wall-clock strings — plain
// "YYYY-MM-DD"/"HH:MM" with no timezone info. Anchoring them explicitly to
// +07:00 here means the resulting Date is the correct absolute instant, so
// every toLocaleString/toLocaleTimeString call renders in whatever timezone
// this device is actually set to.
export function bangkokDateTime(dateYMD?: string, timeHM?: string): Date | null {
  if (!dateYMD || !timeHM) return null;
  const d = new Date(`${dateYMD}T${timeHM}:00+07:00`);
  return isNaN(d.getTime()) ? null : d;
}

// Formats a Bangkok-anchored class time for display in the viewer's own
// device timezone, appending the date when it shifts onto a different
// calendar day than the Bangkok date it's stored under.
export function formatClassTimeLocal(dateYMD?: string, timeHM?: string): string {
  const d = bangkokDateTime(dateYMD, timeHM);
  if (!d) return timeHM || '-';
  const timeStr = d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', hour12: false });
  const localYmd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  if (localYmd !== dateYMD) {
    return `${timeStr} (${d.toLocaleDateString('th-TH', { day: 'numeric', month: 'short' })})`;
  }
  return timeStr;
}

export function formatShortThaiDate(dateYMD?: string): string {
  if (!dateYMD) return '-';
  const d = new Date(dateYMD + 'T00:00:00');
  if (isNaN(d.getTime())) return dateYMD;
  return d.toLocaleDateString('th-TH', { day: 'numeric', month: 'short' });
}
