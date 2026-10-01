-- Ariadne v2: a graph (nodes + edges), a log of events, and an audit trail.

CREATE TABLE nodes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text NOT NULL CHECK (kind IN ('task', 'person', 'agent', 'team', 'resource')),
  title       text NOT NULL CHECK (title <> ''),
  body        text NOT NULL DEFAULT '',
  -- tasks only: open | done | dropped. Ready / waiting / assigned are computed.
  status      text CHECK ((kind = 'task') = (status IS NOT NULL) AND status IN ('open', 'done', 'dropped')),
  attrs       jsonb NOT NULL DEFAULT '{}',
  version     integer NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX nodes_kind ON nodes (kind);

CREATE TABLE edges (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  src         uuid NOT NULL REFERENCES nodes (id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('needs', 'uses', 'involves', 'reports_to', 'member_of')),
  dst         uuid NOT NULL REFERENCES nodes (id) ON DELETE CASCADE,
  note        text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (src <> dst),
  UNIQUE (src, kind, dst)
);
CREATE INDEX edges_dst ON edges (dst);

CREATE TABLE events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          text NOT NULL CHECK (kind IN ('assign', 'report')),
  sender        uuid REFERENCES nodes (id) ON DELETE SET NULL,   -- null = Ariadne itself
  recipient     uuid REFERENCES nodes (id) ON DELETE SET NULL,
  reply_to      uuid REFERENCES events (id) ON DELETE SET NULL,
  closes        boolean NOT NULL DEFAULT false,
  body          text NOT NULL DEFAULT '',
  instructions  text NOT NULL DEFAULT '',
  card          jsonb,           -- assign to the user: what to show and which buttons
  response      jsonb,           -- report from a card: which button, which values
  proposals     jsonb,           -- report from an agent: suggested ops for the analyst
  questions     jsonb,           -- assign to a decider
  answers       jsonb,           -- report from a decider
  decisions     jsonb NOT NULL DEFAULT '{}',  -- model, effort, triage... each with by + confidence
  state         text CHECK ((kind = 'assign') = (state IS NOT NULL) AND state IN ('open', 'closed', 'withdrawn')),
  due_at        timestamptz,
  -- none: nobody to deliver to over the bus; held: waiting on a decision; pending: to publish
  delivery      text NOT NULL DEFAULT 'none' CHECK (delivery IN ('none', 'held', 'pending', 'delivered')),
  delivered_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  closed_at     timestamptz
);
CREATE INDEX events_recipient ON events (recipient, created_at);
CREATE INDEX events_sender ON events (sender, created_at);
CREATE INDEX events_reply_to ON events (reply_to);
CREATE INDEX events_delivery ON events (delivery) WHERE delivery IN ('held', 'pending');

CREATE TABLE event_tasks (
  event_id  uuid NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  task_id   uuid NOT NULL REFERENCES nodes (id) ON DELETE CASCADE,
  PRIMARY KEY (event_id, task_id)
);
CREATE INDEX event_tasks_task ON event_tasks (task_id);

-- Every change, grouped into change sets (one per UI action, MCP call, or bus message), so a
-- change set can be explained and undone.
CREATE TABLE audit (
  id          bigserial PRIMARY KEY,
  changeset   uuid NOT NULL,
  at          timestamptz NOT NULL DEFAULT now(),
  actor       uuid,            -- who: the user, the analyst, an agent; null = Ariadne
  via         text NOT NULL,   -- ui | mcp | core | bus
  because     uuid,            -- the event being handled, when there is one
  entity      text NOT NULL,   -- node | edge | event | event_task
  entity_id   text NOT NULL,
  action      text NOT NULL,   -- create | update | delete
  before      jsonb,
  after       jsonb,
  undone      boolean NOT NULL DEFAULT false
);
CREATE INDEX audit_changeset ON audit (changeset);
CREATE INDEX audit_at ON audit (at);

INSERT INTO nodes (id, kind, title, body, attrs) VALUES
  ('00000000-0000-4000-8000-000000000001', 'person', 'You', 'The person using this Ariadne.', '{}'),
  ('00000000-0000-4000-8000-000000000002', 'agent', 'Analyst',
   'Takes assignments from you, keeps the graph up to date, delegates to subordinates, and brings you only what needs you.',
   '{"models": ["opus"], "effort": "medium"}');
INSERT INTO edges (src, kind, dst) VALUES
  ('00000000-0000-4000-8000-000000000002', 'reports_to', '00000000-0000-4000-8000-000000000001');
