// Screens not yet migrated to React link back to the legacy admin panel at
// its deep-link URL (?screen=...&student=...), so every action keeps
// working during the incremental migration.
const LEGACY_BASE = 'https://admin.litalkeducation.com/';

export function legacyLink(screen: string, studentId?: string | null): string {
  const params = new URLSearchParams({ screen });
  if (studentId) params.set('student', studentId);
  return `${LEGACY_BASE}?${params.toString()}`;
}

// Shareable link into a screen already migrated to this app — read by
// DeepLinkHandler (App.tsx) on load, mirroring legacyLink() for the rest.
export function appLink(screen: string, studentId?: string | null): string {
  const params = new URLSearchParams({ screen });
  if (studentId) params.set('student', studentId);
  return `${window.location.origin}/app/?${params.toString()}`;
}
