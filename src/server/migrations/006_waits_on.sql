-- waits_on: a task blocked outside the user's control (a review, a CI build, a merge) points at
-- who or what it waits on. An open task with one is blocked, not ready.
ALTER TABLE edges DROP CONSTRAINT edges_kind_check;
ALTER TABLE edges ADD CONSTRAINT edges_kind_check CHECK (kind IN ('needs', 'uses', 'involves', 'reports_to', 'member_of', 'waits_on'));
