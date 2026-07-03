CREATE TABLE student_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  file_type TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  uploaded_by TEXT,
  size INTEGER,
  mime_type TEXT,
  deleted_at DATETIME,
  UNIQUE(student_id, filename)
);

CREATE INDEX idx_student ON student_files(student_id);
CREATE INDEX idx_upload ON student_files(uploaded_at);

CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_email TEXT,
  user_sub TEXT,
  action TEXT NOT NULL,
  student_id TEXT,
  filename TEXT,
  success INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_audit_student ON audit_logs(student_id);
CREATE INDEX idx_audit_created ON audit_logs(created_at);
