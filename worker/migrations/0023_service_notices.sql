-- Scheduled service notices: the popup that announces, and then enforces,
-- planned downtime across the public surfaces.
--
-- One row covers a whole event rather than two. A closure normally needs a
-- heads-up first and a block afterwards, so a notice carries both times:
--
--   announce_from .. starts_at   heads-up. The surface still works and the
--                                popup is dismissible.
--   starts_at ..... ends_at      blocked. The surface refuses, and the popup
--                                cannot be dismissed away.
--   after ends_at                nothing. Notices expire on their own so a
--                                forgotten row can't keep the site down.
--
-- Leaving starts_at NULL gives an announcement that never blocks — which is
-- what "opening soon" is. Leaving ends_at NULL is an open-ended block, and
-- the admin screen warns about it.
CREATE TABLE service_notices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  enabled INTEGER NOT NULL DEFAULT 1,

  -- Chooses the default bilingual copy and the icon. 'custom' means the
  -- admin wrote their own. Stored rather than derived so changing the
  -- preset wording later doesn't silently reword live notices.
  preset TEXT NOT NULL DEFAULT 'custom',

  -- Which surfaces this applies to, as a JSON array of keys — see
  -- SERVICE_SURFACES in worker/src/serviceNotices.ts. The admin panel is
  -- deliberately not among them: an admin has to stay able to turn a notice
  -- back off.
  surfaces TEXT NOT NULL DEFAULT '[]',

  title_th TEXT NOT NULL DEFAULT '',
  title_en TEXT NOT NULL DEFAULT '',
  body_th TEXT NOT NULL DEFAULT '',
  body_en TEXT NOT NULL DEFAULT '',

  announce_from DATETIME,
  starts_at DATETIME,
  ends_at DATETIME,

  -- Whether the heads-up popup can be closed. The blocking phase ignores
  -- this — there is nothing behind it to get to.
  dismissible INTEGER NOT NULL DEFAULT 1,

  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_by TEXT
);

-- The public status endpoint filters on enabled + the time window on every
-- request, so those are the columns worth indexing.
CREATE INDEX idx_service_notices_active ON service_notices(enabled, ends_at);

-- Single-row settings for the feature itself. The bypass token lets an admin
-- open a blocked public page to check it: the marketing site has no login, so
-- there is no identity to exempt there the way there is on the API.
CREATE TABLE service_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  bypass_token TEXT NOT NULL DEFAULT '',
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO service_settings (id, bypass_token) VALUES (1, lower(hex(randomblob(16))));
