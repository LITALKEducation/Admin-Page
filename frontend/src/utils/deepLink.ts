// Shareable link into a screen of this app (e.g. the "copy study log
// link" buttons) — read by DeepLinkHandler (App.tsx) on load and resolved
// via SCREEN_ROUTES.
export function appLink(screen: string, studentId?: string | null): string {
  const params = new URLSearchParams({ screen });
  if (studentId) params.set('student', studentId);
  return `${window.location.origin}/app/?${params.toString()}`;
}
