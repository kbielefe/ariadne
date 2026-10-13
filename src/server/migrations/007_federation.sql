-- Peer-to-peer shares. `home` is the peer that may commit a node. Null until this
-- instance starts federation and claims the rows it already has.

ALTER TABLE nodes ADD COLUMN home text;

CREATE TABLE peers (
  peer_id      text PRIMARY KEY,
  public_key   bytea NOT NULL,
  label        text NOT NULL DEFAULT '',
  -- How to open a WebSocket to this peer (LAN first, then the public wss address).
  addrs        text[] NOT NULL DEFAULT '{}',
  -- When this peer has no public listen, dial this relay and circuit through it.
  relay        text[] NOT NULL DEFAULT '{}',
  offers_relay boolean NOT NULL DEFAULT false,
  paired_at    timestamptz NOT NULL DEFAULT now()
);

-- Peers a relay will reserve for and spool for, beyond the ones it has paired with.
-- A ticket redemption or an introduce inserts a row. Null expiry means "until unpaired".
CREATE TABLE relay_allow (
  peer_id    text PRIMARY KEY,
  expires_at timestamptz
);

CREATE TABLE invites (
  token_hash text PRIMARY KEY,
  expires_at timestamptz NOT NULL,
  used       boolean NOT NULL DEFAULT false
);

-- Tickets a relay redeems so an unknown peer can circuit to the issuer.
CREATE TABLE relay_tickets (
  token_hash text PRIMARY KEY,
  issuer     text NOT NULL,
  expires_at timestamptz NOT NULL,
  used       boolean NOT NULL DEFAULT false
);

CREATE TABLE shares (
  id         uuid PRIMARY KEY,
  root_id    uuid NOT NULL,
  root_home  text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE share_members (
  share_id uuid NOT NULL REFERENCES shares (id) ON DELETE CASCADE,
  peer_id  text NOT NULL,
  PRIMARY KEY (share_id, peer_id)
);

CREATE TABLE share_log (
  share_id  uuid NOT NULL,
  seq       bigint NOT NULL,
  author    text NOT NULL,
  body      jsonb NOT NULL,
  signature text NOT NULL,
  PRIMARY KEY (share_id, seq)
);

-- Nodes and edges this share has replicated, so a later snapshot can retract them.
CREATE TABLE share_nodes (
  share_id uuid NOT NULL,
  node_id  uuid NOT NULL,
  PRIMARY KEY (share_id, node_id)
);
CREATE TABLE share_edges (
  share_id uuid NOT NULL,
  edge_id  uuid NOT NULL,
  PRIMARY KEY (share_id, edge_id)
);

-- Signed snapshots of objects homed elsewhere, so the share root can republish them.
CREATE TABLE object_sigs (
  kind       text NOT NULL,
  object_id  text NOT NULL,
  version    integer NOT NULL,
  signer     text NOT NULL,
  payload    jsonb NOT NULL,
  signature  text NOT NULL,
  PRIMARY KEY (kind, object_id, version)
);

CREATE TABLE proposals (
  id         uuid PRIMARY KEY,
  home       text NOT NULL,
  ops        jsonb NOT NULL,
  status     text NOT NULL CHECK (status IN ('pending', 'committed', 'rejected')),
  error      text,
  result     jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Sealed frames. The relay stores these and cannot open them.
CREATE TABLE spool (
  id         uuid PRIMARY KEY,
  recipient  text NOT NULL,
  sender     text NOT NULL,
  blob       bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX spool_recipient ON spool (recipient, created_at);
