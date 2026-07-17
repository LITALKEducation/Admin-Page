-- QR check-in (docs/UX-REDESIGN.md phase 4). The teacher opens a QR for a
-- specific booking (screen-shared in the Meet class or shown on-site); the
-- student scans it and the class is marked attended. A booking is one
-- student's one-hour slot, so attendance is one row per booking.

CREATE TABLE attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL,
  student_id TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT 'qr',
  checked_in_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(booking_id)                 -- rescans are idempotent, not duplicates
);

-- Short-lived opaque tokens embedded in the QR URL. Possession of a fresh
-- token is the proof of presence (the QR is only visible inside the live
-- class), so the check-in endpoint needs no login. Stored server-side (not
-- signed JWTs) so minting a new QR can revoke the old one and no extra
-- signing secret is needed.
CREATE TABLE checkin_tokens (
  token TEXT PRIMARY KEY,
  booking_id INTEGER NOT NULL,
  created_by TEXT,
  expires_at TEXT NOT NULL,          -- ISO timestamp, compared in JS
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_checkin_tokens_booking ON checkin_tokens(booking_id);
