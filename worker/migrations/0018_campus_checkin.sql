-- On-site QR/barcode/NFC check-in for staff at the front desk (scan.html):
-- staff scans a student's or teacher's digital ID card to toggle campus
-- presence — first scan of the day checks in, the next scan of the same
-- card checks out. Independent of (but opportunistically linked to) the
-- per-booking QR attendance from 0015/0016, which stays as-is.

-- Rotating short-lived tokens for the digital ID card's QR. The card mints
-- a fresh one every ~2 minutes while it's open (see /portal/:id/id-card-token
-- and /staff/id-card-token), so a photo of someone's screen is only good
-- for a couple of minutes, not a permanent stand-in for the card.
CREATE TABLE id_card_tokens (
  token TEXT PRIMARY KEY,
  person_type TEXT NOT NULL CHECK(person_type IN ('student', 'staff')),
  person_id TEXT NOT NULL,           -- students.id or staff.identity
  expires_at TEXT NOT NULL,          -- ISO timestamp, compared in JS
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_id_card_tokens_person ON id_card_tokens(person_type, person_id);

-- Physical NFC cards issued to students/teachers, registered by an admin
-- (see /nfc-cards). The tag's UID resolves straight to a person — no
-- expiry, since possession of the physical card is the proof (same model
-- as the QR, just not rotating); revoke by deleting the row.
CREATE TABLE nfc_cards (
  uid TEXT PRIMARY KEY,
  person_type TEXT NOT NULL CHECK(person_type IN ('student', 'staff')),
  person_id TEXT NOT NULL,
  registered_by TEXT,
  registered_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_nfc_cards_person ON nfc_cards(person_type, person_id);

-- The presence log itself. Toggle semantics: no open row (checked_out_at
-- IS NULL) for this person today -> this scan checks them in; an open row
-- exists -> this scan checks them out. booking_id opportunistically links
-- a same-day booking when one exists, so this also enriches the existing
-- class-attendance picture without requiring a booking to work at all
-- (e.g. a student just visiting campus outside class hours).
CREATE TABLE campus_checkins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_type TEXT NOT NULL CHECK(person_type IN ('student', 'staff')),
  person_id TEXT NOT NULL,
  booking_id INTEGER,
  scan_method TEXT NOT NULL DEFAULT 'qr',   -- 'qr' | 'barcode' | 'nfc'
  checked_in_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  checked_in_by TEXT,
  checked_out_at DATETIME,
  checked_out_by TEXT
);

CREATE INDEX idx_campus_checkins_open ON campus_checkins(person_type, person_id, checked_out_at);
