-- Consent record for the public website assistant.
--
-- The website chat now gates itself behind a terms-of-use acceptance, and
-- the acceptance has to be recorded somewhere durable — localStorage on the
-- visitor's own device is not a record the school holds. One row per
-- visitor_id (the same random, identity-free key that already rate-limits
-- /chat/general), carrying which version of the terms was accepted so a
-- future revision can re-prompt by bumping the version rather than wiping
-- the table.
--
-- Deliberately no PII: visitor_id is a client-generated UUID with no link
-- to a person, and lang is only stored to know which translation of the
-- terms was actually shown.
CREATE TABLE ai_chat_consents (
  visitor_id TEXT PRIMARY KEY,
  scope TEXT NOT NULL DEFAULT 'general',
  version TEXT NOT NULL,
  lang TEXT,
  accepted_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_ai_chat_consents_accepted ON ai_chat_consents(accepted_at);

-- Conversation listing for the admin panel's chat log viewer scans by
-- scope and recency; the existing indexes are keyed on conversation,
-- student and actor, none of which serve that query.
CREATE INDEX idx_ai_chat_scope_created ON ai_chat_messages(scope, created_at);
