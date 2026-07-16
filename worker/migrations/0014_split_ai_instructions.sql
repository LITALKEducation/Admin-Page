-- Splits the single shared `instructions` field into per-surface settings.
-- The staff-facing admin assistant and the public-facing portal assistant
-- (student/parent portal, and the general marketing-site assistant) need
-- independently tunable guidance — e.g. Thai honorifics that suit a parent
-- chat read oddly in an internal staff tool. The old `instructions` column
-- is left in place (unused going forward) rather than dropped.
ALTER TABLE ai_chat_settings ADD COLUMN staff_instructions TEXT NOT NULL DEFAULT '';
ALTER TABLE ai_chat_settings ADD COLUMN portal_instructions TEXT NOT NULL DEFAULT '';
UPDATE ai_chat_settings SET staff_instructions = instructions, portal_instructions = instructions WHERE id = 1;
