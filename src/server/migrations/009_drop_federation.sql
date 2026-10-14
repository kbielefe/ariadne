-- Federation is gone (sharing with the pod moves to steward, a separate project; see docs/DESIGN.md).
-- Drops everything 007_federation.sql added. Replicas that other instances shared here stay, as
-- ordinary local nodes. Person attrs.peer stays too: it now names a steward peer.
DROP TABLE IF EXISTS spool;
DROP TABLE IF EXISTS proposals;
DROP TABLE IF EXISTS object_sigs;
DROP TABLE IF EXISTS share_edges;
DROP TABLE IF EXISTS share_nodes;
DROP TABLE IF EXISTS share_log;
DROP TABLE IF EXISTS share_members;
DROP TABLE IF EXISTS shares;
DROP TABLE IF EXISTS relay_tickets;
DROP TABLE IF EXISTS invites;
DROP TABLE IF EXISTS relay_allow;
DROP TABLE IF EXISTS peers;

ALTER TABLE nodes DROP COLUMN IF EXISTS home;
