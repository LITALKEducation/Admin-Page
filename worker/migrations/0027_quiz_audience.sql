-- Separate tests by who they're for: students in 1-on-1 online tutoring vs.
-- self-paced "on demand" learners. Both use the same student portal, so this
-- is a tag that groups a quiz into one track or the other (the portal shows
-- them in separate labelled sections; the admin console filters by it).
--
--   on_demand — self-paced; shown in the on-demand learning section (default)
--   tutored   — used with 1-on-1 online teaching; shown under "from your teacher"
ALTER TABLE quizzes ADD COLUMN audience TEXT NOT NULL DEFAULT 'on_demand';
-- Values: 'on_demand' | 'tutored' (validated in the Worker; no CHECK so the
-- ALTER stays reversible).
