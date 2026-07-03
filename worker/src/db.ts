import type { AuthUser } from './types';

export const DOCUMENT_TYPES = [
  'Homework',
  'Worksheet',
  'Exam',
  'Attendance',
  'Certificate',
  'Portfolio',
  'Other',
] as const;

export interface UploadMeta {
  originalFilename: string;
  fileType: string;
  uploadedBy: string;
  size: number;
  mimeType: string;
}

export interface InsertResult {
  id: number;
  filename: string;
  r2Key: string;
}

export function extname(filename: string): string {
  const idx = filename.lastIndexOf('.');
  return idx === -1 ? '' : filename.slice(idx);
}

// Date-code used as the base filename, e.g. "030726" for 2026-07-03 (DDMMYY).
// Only the increment logic below is load-bearing; adjust the format here if needed.
export function todayCode(date: Date = new Date()): string {
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const yy = String(date.getUTCFullYear()).slice(-2);
  return `${dd}${mm}${yy}`;
}

// Generates 070326.pdf, 070326_01.pdf, 070326_02.pdf, ... by attempting the
// insert and retrying on a UNIQUE(student_id, filename) violation, instead of
// trusting a prior SELECT (which would race under concurrent uploads).
export async function insertFileWithUniqueName(
  db: D1Database,
  studentId: string,
  baseName: string,
  ext: string,
  meta: UploadMeta,
): Promise<InsertResult> {
  const MAX_ATTEMPTS = 100;
  for (let suffix = 0; suffix < MAX_ATTEMPTS; suffix++) {
    const filename = suffix === 0 ? `${baseName}${ext}` : `${baseName}_${String(suffix).padStart(2, '0')}${ext}`;
    const r2Key = `${studentId}/${filename}`;
    try {
      const result = await db
        .prepare(
          `INSERT INTO student_files
           (student_id, filename, original_filename, file_type, r2_key, uploaded_by, size, mime_type)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(studentId, filename, meta.originalFilename, meta.fileType, r2Key, meta.uploadedBy, meta.size, meta.mimeType)
        .run();
      return { id: Number(result.meta.last_row_id), filename, r2Key };
    } catch (err) {
      if (String(err).includes('UNIQUE')) continue;
      throw err;
    }
  }
  throw new Error(`Could not generate a unique filename for student ${studentId} after ${MAX_ATTEMPTS} attempts`);
}

export async function logAudit(
  db: D1Database,
  user: AuthUser | null,
  action: string,
  studentId: string | null,
  filename: string | null,
  success: boolean,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO audit_logs (user_email, user_sub, action, student_id, filename, success)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(user?.email ?? null, user?.sub ?? null, action, studentId, filename, success ? 1 : 0)
    .run();
}
