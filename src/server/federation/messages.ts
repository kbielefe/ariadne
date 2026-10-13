import type { Edge, Node, Op } from '../../shared/model';

export interface SignedNode {
  node: Node;
  sig: string;
}
export interface SignedEdge {
  edge: Edge;
  sig: string;
}
export interface Snapshot {
  nodes: SignedNode[];
  edges: SignedEdge[];
}
export interface Snap {
  shareId: string;
  seq: number;
  /** So a member that has never seen this share can store it before applying. */
  rootId: string;
  rootHome: string;
  members: string[];
  snapshot: Snapshot;
  sig: string;
}
export interface ProposalMsg {
  id: string;
  ops: Op[];
  attachments: SignedNode[];
}
export interface SyncMsg {
  snaps: Snap[];
  attests: { nodes: SignedNode[]; edges: SignedEdge[] };
  proposals: ProposalMsg[];
}
export interface ProposalResult {
  id: string;
  ok: boolean;
  error?: string;
  results?: { op: string; id: string; ref?: string }[];
  node?: Node;
}
export interface SyncReply {
  snaps: Snap[];
  results: ProposalResult[];
}

export const PAIR = '/ariadne/pair/1.0.0';
export const CTL = '/ariadne/relay-ctl/1.0.0';
export const SPOOL = '/ariadne/spool/1.0.0';
export const SYNC = '/ariadne/sync/1.0.0';
