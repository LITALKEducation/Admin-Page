-- Avatars for students/staff, and in-app teacher/staff account management
-- (create, edit, photo, password-change / passkey-enrollment tickets).

-- R2 key of the student's profile photo (NULL until one is uploaded).
ALTER TABLE students ADD COLUMN avatar_key TEXT;

-- Cached Auth0 login user id (auth0|...) for the student's account, so
-- profile/password/username edits don't need an extra users-by-email
-- lookup every time. Backfilled lazily on first edit if NULL.
ALTER TABLE students ADD COLUMN auth0_user_id TEXT;

-- The `staff` table (0004) previously only tracked identities seen at
-- login. It now also holds accounts created in-app: teachers and
-- non-teaching staff, with their own profile photo and Auth0 user id.
ALTER TABLE staff ADD COLUMN avatar_key TEXT;
ALTER TABLE staff ADD COLUMN phone TEXT;
ALTER TABLE staff ADD COLUMN title TEXT;
ALTER TABLE staff ADD COLUMN role TEXT;              -- 'admin' | 'teacher' | 'staff' (as assigned at creation)
ALTER TABLE staff ADD COLUMN auth0_user_id TEXT;      -- set for accounts created via POST /staff
ALTER TABLE staff ADD COLUMN created_by TEXT;
ALTER TABLE staff ADD COLUMN created_at DATETIME;
