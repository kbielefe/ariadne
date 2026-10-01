-- The Analyst is an interactive Claude Code session: it pulls its events over MCP (next_assignment).
UPDATE nodes SET attrs = attrs || '{"interactive": true}' WHERE id = '00000000-0000-4000-8000-000000000002';

-- claimed: an interactive session took it with next_assignment and hasn't finished it yet.
ALTER TABLE events DROP CONSTRAINT events_delivery_check;
ALTER TABLE events ADD CONSTRAINT events_delivery_check CHECK (delivery IN ('none', 'held', 'pending', 'claimed', 'delivered'));
DROP INDEX events_delivery;
CREATE INDEX events_delivery ON events (delivery) WHERE delivery IN ('held', 'pending', 'claimed');

-- Something Ariadne does at a time: check a claim, send an event... A key names a timer so it can be
-- reset (upserted) or cancelled; at most one live timer per key.
CREATE TABLE timers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          text NOT NULL,
  key           text,
  at            timestamptz NOT NULL,
  payload       jsonb NOT NULL DEFAULT '{}',
  created_by    uuid REFERENCES nodes (id) ON DELETE SET NULL,   -- null = Ariadne itself
  created_at    timestamptz NOT NULL DEFAULT now(),
  fired_at      timestamptz,
  cancelled_at  timestamptz,
  error         text
);
CREATE INDEX timers_due ON timers (at) WHERE fired_at IS NULL AND cancelled_at IS NULL;
CREATE UNIQUE INDEX timers_live_key ON timers (key) WHERE fired_at IS NULL AND cancelled_at IS NULL;
