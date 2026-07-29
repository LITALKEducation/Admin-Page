-- Two kinds of student now share the portal:
--   tutored   — 1-on-1 online students, accounts created by staff with a
--               <id>@litalkeducation.com login (the existing roster).
--   on_demand — self-registered learners who signed up with any email to buy
--               and take on-demand courses. Auto-provisioned on first login
--               (see whoami in index.ts), matched by their Auth0 sub.
-- Every existing row is a tutored student, so that's the default.
ALTER TABLE students ADD COLUMN account_type TEXT NOT NULL DEFAULT 'tutored';

-- On-demand accounts are resolved by Auth0 sub (their email is arbitrary, so
-- the email-local-part → id shortcut is deliberately NOT used for them). This
-- index keeps that lookup fast; it's not UNIQUE because legacy rows may share
-- NULL and we don't want the migration to fail on any pre-existing data.
CREATE INDEX IF NOT EXISTS idx_students_auth0 ON students(auth0_user_id);
