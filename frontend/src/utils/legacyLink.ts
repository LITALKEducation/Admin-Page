// Screens not yet migrated to React link back to the legacy admin panel at
// its deep-link URL (?screen=...&student=...), so every action keeps
// working during the incremental migration.
const LEGACY_BASE = 'https://admin.litalkeducation.com/';

export function legacyLink(screen: string, studentId?: string | null): string {
  const params = new URLSearchParams({ screen });
  if (studentId) params.set('student', studentId);
  return `${LEGACY_BASE}?${params.toString()}`;
}
