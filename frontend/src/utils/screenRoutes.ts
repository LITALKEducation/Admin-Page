// Every legacy `?screen=` key mapped to its React route now that the
// whole admin panel has been migrated — the single source of truth for
// Sidebar links, cross-screen navigation, and shareable deep links.
export const SCREEN_ROUTES: Record<string, string> = {
  dashboard: '/',
  students: '/students',
  check: '/check',
  files: '/files',
  create: '/create',
  booking: '/booking',
  schedule: '/schedule',
  hours: '/hours',
  logs: '/logs',
  payments: '/payments',
  finance: '/finance',
  blog: '/blog',
  links: '/links',
  staff: '/staff',
  access: '/access',
  credits: '/credits',
  nfc: '/nfc',
  checkins: '/checkins',
};
