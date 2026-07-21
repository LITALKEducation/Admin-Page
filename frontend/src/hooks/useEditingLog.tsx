import { createContext, useContext, useState, type ReactNode } from 'react';

export interface EditingLog {
  id: number;
  date: string;
  video?: string;
  feedback?: string;
}

// Bridges "แก้ไข" on the student profile's recent-logs list to the Logs
// screen's editor (mirrors the legacy editingLogId + prefilled form fields).
const EditingLogContext = createContext<[EditingLog | null, (log: EditingLog | null) => void] | null>(null);

export function EditingLogProvider({ children }: { children: ReactNode }) {
  const state = useState<EditingLog | null>(null);
  return <EditingLogContext.Provider value={state}>{children}</EditingLogContext.Provider>;
}

export function useEditingLog() {
  const ctx = useContext(EditingLogContext);
  if (!ctx) throw new Error('useEditingLog must be used within an EditingLogProvider');
  return ctx;
}
