-- working_on: a person or team is working on a task ("Will is working on X"), the opposite direction of
-- involves. An open task someone other than You is working on is theirs: never ready for you or your agents.
-- Steward intents (a teammate's declared plan) land as such tasks.
ALTER TABLE edges DROP CONSTRAINT edges_kind_check;
ALTER TABLE edges ADD CONSTRAINT edges_kind_check CHECK (kind IN ('needs', 'uses', 'involves', 'reports_to', 'member_of', 'waits_on', 'working_on'));
