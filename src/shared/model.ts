// The shared vocabulary of Ariadne: what the web UI and the MCP server agree on.
//
// The data is a graph (nodes + edges). See docs/DESIGN.md for the reasoning.
import { z } from 'zod';

// You: created by the first migration. Can be renamed but not deleted.
export const USER_ID = '00000000-0000-4000-8000-000000000001';

export const Id = z.uuid();

// ---------------------------------------------------------------- nodes

export const NodeKind = z.enum(['task', 'person', 'team', 'resource']);
export type NodeKind = z.infer<typeof NodeKind>;
export const ACTOR_KINDS = ['person', 'team'] as const satisfies readonly NodeKind[];
export const isActorKind = (k: NodeKind) => (ACTOR_KINDS as readonly string[]).includes(k);

export const TaskStatus = z.enum(['open', 'done', 'dropped']);
export type TaskStatus = z.infer<typeof TaskStatus>;

// Tasks also take any keys of their own (e.g. an agent's structured run state); only the known ones are checked.
export const TaskAttrs = z
  .object({
    guidance: z.string().describe('Instructions that apply to this task and everything it needs (inherited)'),
  })
  .partial();
export const OPEN_ATTRS: readonly NodeKind[] = ['task'];

const ActorAttrs = z
  .object({
    areas: z.array(z.string()).describe('What this person or team owns or can help with'),
  })
  .partial();
export const PersonAttrs = ActorAttrs;
export const TeamAttrs = ActorAttrs;

/** A branch is a shared scope: the tasks that use it (and what they need) ship together in one PR. */
export const ResourceType = z.enum(['repo', 'branch', 'build', 'doc', 'link', 'other']);
export const ResourceAttrs = z
  .object({
    type: ResourceType,
    url: z.string(),
    repo: z.string().describe('For a branch: the repo it is in (name or URL)'),
    branch: z.string().describe('For a branch: the git branch name'),
  })
  .partial();

export const ATTRS_BY_KIND = {
  task: TaskAttrs,
  person: PersonAttrs,
  team: TeamAttrs,
  resource: ResourceAttrs,
} as const satisfies Record<NodeKind, z.ZodType>;

export const Node = z.object({
  id: Id,
  kind: NodeKind,
  title: z.string(),
  body: z.string(),
  status: TaskStatus.nullable(),
  attrs: z.record(z.string(), z.unknown()),
  version: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Node = z.infer<typeof Node>;

// ---------------------------------------------------------------- edges

export const EdgeKind = z.enum(['needs', 'uses', 'involves', 'reports_to', 'member_of', 'waits_on']);
export type EdgeKind = z.infer<typeof EdgeKind>;

/** Allowed endpoint kinds per edge kind, and whether the edge must stay acyclic. */
export const EDGE_RULES: Record<EdgeKind, { src: readonly NodeKind[]; dst: readonly NodeKind[]; acyclic: boolean; label: string }> = {
  needs: { src: ['task'], dst: ['task'], acyclic: true, label: 'needs' },
  uses: { src: ['task'], dst: ['resource'], acyclic: false, label: 'uses' },
  involves: { src: ['task'], dst: ACTOR_KINDS, acyclic: false, label: 'coordinate with' },
  reports_to: { src: ACTOR_KINDS, dst: ACTOR_KINDS, acyclic: true, label: 'reports to' },
  member_of: { src: ACTOR_KINDS, dst: ['team'], acyclic: true, label: 'member of' },
  waits_on: { src: ['task'], dst: [...ACTOR_KINDS, 'resource'], acyclic: false, label: 'waiting on' },
};

export const Edge = z.object({
  id: Id,
  src: Id,
  kind: EdgeKind,
  dst: Id,
  note: z.string(),
  createdAt: z.string(),
});
export type Edge = z.infer<typeof Edge>;

// ---------------------------------------------------------------- operations
//
// One vocabulary for every change, whoever makes it: the web UI and Claude Code over MCP.
// `ref` names a node created earlier in the same batch; later ops may use "$ref" in place of an id.
// Ops are strict: an unknown key (a typo, or a field an older server doesn't know) fails instead of being dropped.

const IdOrRef = z.string().min(1).describe('A node id, or "$name" for a node created earlier in this batch');

export const Op = z.discriminatedUnion('op', [
  z.strictObject({
    op: z.literal('create_node'),
    ref: z.string().optional(),
    kind: NodeKind,
    title: z.string().min(1),
    body: z.string().optional(),
    status: TaskStatus.optional(),
    attrs: z.record(z.string(), z.unknown()).optional(),
  }),
  z.strictObject({
    op: z.literal('update_node'),
    id: IdOrRef,
    title: z.string().min(1).optional(),
    body: z.string().optional().describe('The whole body, or with section only that section'),
    append: z.string().optional().describe('Text to add at the end of the body, or with section at the end of that section'),
    section: z.string().optional().describe('A heading such as "## Log": body or append then applies to just that section (created at the end if missing)'),
    status: TaskStatus.optional(),
    attrs: z.record(z.string(), z.unknown()).optional().describe('Merged into existing attrs; null removes a key'),
    version: z.number().int().optional().describe('Fail if the node changed since this version'),
  }),
  z.strictObject({ op: z.literal('delete_node'), id: IdOrRef }),
  z.strictObject({ op: z.literal('create_edge'), src: IdOrRef, kind: EdgeKind, dst: IdOrRef, note: z.string().optional() }),
  z.strictObject({ op: z.literal('update_edge'), id: Id, note: z.string() }),
  z.strictObject({ op: z.literal('delete_edge'), id: Id.optional(), src: IdOrRef.optional(), kind: EdgeKind.optional(), dst: IdOrRef.optional() }),
]);
export type Op = z.infer<typeof Op>;
export const Ops = z.array(Op).min(1);

/** Where a change came from. Recorded in the audit log. */
export type Via = 'ui' | 'mcp';
