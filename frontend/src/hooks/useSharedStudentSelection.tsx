import { createContext, useContext, useState, type ReactNode } from 'react';

// Logs / Payments / Files / Check / Schedule / Credits all share one
// selection (mirrors the legacy `selectedStudentId` global) so switching
// between those screens keeps the same student picked. Booking keeps its
// own separate selection (legacy `selectedBookingStudentId`), handled
// locally inside BookingScreen instead.
const SharedStudentContext = createContext<[string, (id: string) => void] | null>(null);

export function SharedStudentProvider({ children }: { children: ReactNode }) {
  const state = useState('');
  return <SharedStudentContext.Provider value={state}>{children}</SharedStudentContext.Provider>;
}

export function useSharedStudentSelection() {
  const ctx = useContext(SharedStudentContext);
  if (!ctx) throw new Error('useSharedStudentSelection must be used within a SharedStudentProvider');
  return ctx;
}
