-- Ariadne is a graph (nodes + edges) plus an audit trail, kept with Claude Code over MCP.
-- The Analyst, events (assign / report, cards, claims), timers, and agents are gone (2026-10-02).

DROP TABLE timers, event_tasks, events;

-- Event history went with the events. Changes the Analyst made are now plain MCP changes (no actor).
DELETE FROM audit WHERE entity IN ('event', 'event_task');
UPDATE audit SET actor = NULL WHERE actor = '00000000-0000-4000-8000-000000000002';
ALTER TABLE audit DROP COLUMN because;

-- No agents (the Analyst was the only one). Its edges cascade.
DELETE FROM nodes WHERE kind = 'agent';
ALTER TABLE nodes DROP CONSTRAINT nodes_kind_check;
ALTER TABLE nodes ADD CONSTRAINT nodes_kind_check CHECK (kind IN ('task', 'person', 'team', 'resource'));

-- Attrs that only agents and hand-offs used. Edits are checked strictly, so they can't linger.
UPDATE nodes SET attrs = attrs - 'briefs' - 'models' - 'effort' - 'paused' - 'decider' - 'interactive'
WHERE attrs ?| array['briefs', 'models', 'effort', 'paused', 'decider', 'interactive'];
