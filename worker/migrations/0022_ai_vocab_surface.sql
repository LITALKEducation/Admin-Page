-- Fourth AI surface: the vocabulary tutor at litalkeducation.com/ask.
--
-- A student asking "what does 'commute' mean" is a different job from the
-- three existing surfaces: it isn't grounded in anyone's account (unlike
-- portal), it isn't selling the school (unlike general), and it isn't an
-- internal tool (unlike staff). It teaches one English word at a time, so
-- it gets its own instructions and its own limits rather than borrowing
-- the website assistant's.
--
-- Follows the column layout established in 0020 so loadAiChatSettings can
-- treat all four surfaces identically.
ALTER TABLE ai_chat_settings ADD COLUMN vocab_instructions TEXT NOT NULL DEFAULT '';
ALTER TABLE ai_chat_settings ADD COLUMN vocab_options TEXT NOT NULL DEFAULT '{}';
ALTER TABLE ai_chat_settings ADD COLUMN vocab_enabled INTEGER NOT NULL DEFAULT 1;

-- Higher than the website assistant's 20: looking up words is the whole
-- point of this page, and a student working through a reading passage will
-- reasonably ask about a dozen in one sitting.
ALTER TABLE ai_chat_settings ADD COLUMN vocab_daily_limit INTEGER NOT NULL DEFAULT 60;
