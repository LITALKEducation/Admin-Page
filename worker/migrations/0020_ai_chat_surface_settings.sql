-- Gives each AI assistant surface its own settings, and splits the public
-- website assistant away from the student portal.
--
-- Until now the "portal" instructions steered two different audiences at
-- once: a signed-in student/parent looking at their own account, and an
-- anonymous visitor on the marketing site. They read the same because both
-- face the public, but they are not the same conversation — the website
-- assistant fields "what do you offer / how do I start" while the portal
-- one answers "when is my next class". general_instructions seeds from the
-- portal text so today's behaviour carries over unchanged, then the two
-- can drift apart from the admin panel.
ALTER TABLE ai_chat_settings ADD COLUMN general_instructions TEXT NOT NULL DEFAULT '';
UPDATE ai_chat_settings SET general_instructions = portal_instructions WHERE id = 1;

-- Point-and-click steering (tone, reply length, emoji, reply language, what
-- to do when unsure, ...) stored as a JSON blob per surface. The blob is the
-- source of truth for the admin UI's controls; the worker turns it into
-- prompt sentences at request time (see composeGuidance in aiSettings.ts)
-- rather than storing generated text, so the wording can be improved later
-- without a data migration.
ALTER TABLE ai_chat_settings ADD COLUMN staff_options TEXT NOT NULL DEFAULT '{}';
ALTER TABLE ai_chat_settings ADD COLUMN portal_options TEXT NOT NULL DEFAULT '{}';
ALTER TABLE ai_chat_settings ADD COLUMN general_options TEXT NOT NULL DEFAULT '{}';

-- Kill switch + rate limit per surface. The defaults are exactly the
-- previously hardcoded constants in chat.ts, so existing behaviour is
-- preserved until an admin changes them.
ALTER TABLE ai_chat_settings ADD COLUMN staff_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE ai_chat_settings ADD COLUMN portal_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE ai_chat_settings ADD COLUMN general_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE ai_chat_settings ADD COLUMN staff_daily_limit INTEGER NOT NULL DEFAULT 100;
ALTER TABLE ai_chat_settings ADD COLUMN portal_daily_limit INTEGER NOT NULL DEFAULT 40;
ALTER TABLE ai_chat_settings ADD COLUMN general_daily_limit INTEGER NOT NULL DEFAULT 20;
