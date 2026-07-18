-- Opaque per-student check-in code (8 uppercase hex chars). Used as the
-- self-identify credential for on-site/group event check-in (checkin.html)
-- and shown on the digital student ID card, replacing the real student id
-- in both places: the id follows a guessable pattern ("litalk" + 5 random
-- digits) and doubles as the Auth0 login, so typing/prefilling it there
-- let anyone who saw or guessed one check another student in. This code
-- carries no information about the student — only a students.checkin_code
-- lookup resolves it, and it can be rotated independently of the account.
ALTER TABLE students ADD COLUMN checkin_code TEXT;

UPDATE students SET checkin_code = upper(hex(randomblob(4))) WHERE checkin_code IS NULL;

CREATE UNIQUE INDEX idx_students_checkin_code ON students(checkin_code);
