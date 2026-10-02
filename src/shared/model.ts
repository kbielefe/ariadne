// The shared vocabulary of Ariadne v2: what the web UI, the MCP server, and the runners agree on.
//
// The data is a graph (nodes + edges) plus a log of events (assign / report).
// See docs/DESIGN.md for the reasoning.
import { z } from 'zod';

// Well-known actors, created by the first migration. They can be renamed but not deleted.
export const USER_ID = '00000000-0000-4000-8000-000000000001';
export const ANALYST_ID = '00000000-0000-4000-8000-000000000002';

export const Id = z.uuid();

// ---------------------------------------------------------------- nodes

export const NodeKind = z.enum(['task', 'person', 'agent', 'team', 'resource']);
export type NodeKind = z.infer<typeof NodeKind>;
export const ACTOR_KINDS = ['person', 'agent', 'team'] as const satisfies readonly NodeKind[];
export const isActorKind = (k: NodeKind) => (ACTOR_KINDS as readonly string[]).includes(k);

export const TaskStatus = z.enum(['open', 'done', 'dropped']);
export type TaskStatus = z.infer<typeof TaskStatus>;

/** What an actor does in each of the four hand-off situations. Free text, read by models. */
export const Briefs = z
  .object({
    onAssignment: z.string().describe('What to do when receiving an assignment from a supervisor'),
    onReport: z.string().describe('What to do when returning results to a supervisor'),
    onDelegate: z.string().describe('What to do when making an assignment for a subordinate'),
    onReview: z.string().describe('What to do when receiving results from a subordinate'),
  })
  .partial();
export type Briefs = z.infer<typeof Briefs>;

export const Effort = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
export type Effort = z.infer<typeof Effort>;

export const TaskAttrs = z
  .object({
    guidance: z.string().describe('Instructions that apply to this task and everything it needs (inherited)'),
  })
  .partial();

const actorCommon = {
  areas: z.array(z.string()).describe('What this actor owns or can help with'),
  briefs: Briefs,
};
export const PersonAttrs = z.object(actorCommon).partial();
export const TeamAttrs = z.object(actorCommon).partial();
export const AgentAttrs = z
  .object({
    ...actorCommon,
    models: z.array(z.string()).describe('Models this agent may run on; the first is the default'),
    effort: Effort.describe('Default effort level'),
    decider: z.boolean().describe('A System One decider: answers choice/score/noul questions, writes no text'),
    paused: z.boolean().describe('Paused agents get no deliveries; they wait'),
    interactive: z.boolean().describe('Works in an interactive Claude Code session: claims its events over MCP (claim_assignment) instead of RabbitMQ'),
  })
  .partial();

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
  agent: AgentAttrs,
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

export const EdgeKind = z.enum(['needs', 'uses', 'involves', 'reports_to', 'member_of']);
export type EdgeKind = z.infer<typeof EdgeKind>;

/** Allowed endpoint kinds per edge kind, and whether the edge must stay acyclic. */
export const EDGE_RULES: Record<EdgeKind, { src: readonly NodeKind[]; dst: readonly NodeKind[]; acyclic: boolean; label: string }> = {
  needs: { src: ['task'], dst: ['task'], acyclic: true, label: 'needs' },
  uses: { src: ['task'], dst: ['resource'], acyclic: false, label: 'uses' },
  involves: { src: ['task'], dst: ACTOR_KINDS, acyclic: false, label: 'coordinate with' },
  reports_to: { src: ACTOR_KINDS, dst: ACTOR_KINDS, acyclic: true, label: 'reports to' },
  member_of: { src: ['person', 'agent'], dst: ['team'], acyclic: false, label: 'member of' },
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

// ---------------------------------------------------------------- cards

export const CardField = z.object({
  name: z.string().min(1),
  label: z.string(),
  type: z.enum(['text', 'textarea', 'select', 'checkbox', 'tasks']),
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional().describe('For select; for tasks, defaults to the card tasks'),
  value: z.unknown().optional().describe('Initial value'),
});

export const CardAction = z.object({
  id: z.string().min(1),
  label: z.string(),
  style: z.enum(['primary', 'default', 'danger']).default('default'),
});

/** A card is an assignment to the user. Pressing an action is the user's report. */
export const Card = z.object({
  kind: z.enum(['approval', 'choice', 'tasks', 'question', 'info', 'proxy']).default('info'),
  title: z.string().min(1),
  fields: z.array(CardField).default([]),
  actions: z.array(CardAction).min(1),
});
export type Card = z.infer<typeof Card>;
export type CardInput = z.input<typeof Card>;

export const CardResponse = z.object({
  action: z.string(),
  values: z.record(z.string(), z.unknown()).default({}),
});
export type CardResponse = z.infer<typeof CardResponse>;

// ---------------------------------------------------------------- System One questions

export const Question = z.discriminatedUnion('type', [
  z.object({ type: z.literal('choice'), instructions: z.string(), criteria: z.record(z.string(), z.string()) }),
  z.object({ type: z.literal('score'), instructions: z.string(), scale: z.array(z.string()).min(2) }),
  z.object({ type: z.literal('noul'), instructions: z.string() }),
]);
export type Question = z.infer<typeof Question>;

export const Answer = z
  .object({
    type: z.enum(['choice', 'score', 'noul']),
    choice: z.string().optional(),
    index: z.number().optional(),
    value: z.number().optional(),
    probabilities: z.record(z.string(), z.number()).optional(),
    confidence: z.number().optional(),
  })
  .loose();
export type Answer = z.infer<typeof Answer>;

/** Something decided about an event: model, effort, triage... with who decided and how sure. */
export const Decision = z.object({
  value: z.unknown(),
  by: z.string().describe('jev, analyst, user, default, ...'),
  confidence: z.number().optional(),
});
export type Decision = z.infer<typeof Decision>;

// ---------------------------------------------------------------- events

export const EventKind = z.enum(['assign', 'report']);
export type EventKind = z.infer<typeof EventKind>;
export const EventState = z.enum(['open', 'closed', 'withdrawn']);
export type EventState = z.infer<typeof EventState>;

export const Event = z.object({
  id: Id,
  kind: EventKind,
  /** null = Ariadne itself */
  sender: Id.nullable(),
  recipient: Id.nullable(),
  replyTo: Id.nullable(),
  /** report only: this report finishes the assignment it replies to */
  closes: z.boolean(),
  body: z.string(),
  instructions: z.string(),
  card: Card.nullable(),
  response: CardResponse.nullable(),
  proposals: z.array(z.unknown()).nullable(),
  questions: z.record(z.string(), Question).nullable(),
  answers: z.record(z.string(), Answer).nullable(),
  decisions: z.record(z.string(), Decision),
  /** assign only */
  state: EventState.nullable(),
  /** assign only: Ariadne tells the sender if no report arrives by then */
  dueAt: z.string().nullable(),
  delivery: z.enum(['none', 'held', 'pending', 'claimed', 'delivered']),
  tasks: z.array(Id),
  createdAt: z.string(),
  closedAt: z.string().nullable(),
});
export type Event = z.infer<typeof Event>;

// ---------------------------------------------------------------- operations
//
// One vocabulary for every change, whoever makes it: the web UI, the analyst over MCP, and agents
// (as proposals inside their reports, which the analyst applies or escalates).
// `ref` names a node created earlier in the same batch; later ops may use "$ref" in place of an id.

const IdOrRef = z.string().min(1).describe('A node id, or "$name" for a node created earlier in this batch');

export const Op = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('create_node'),
    ref: z.string().optional(),
    kind: NodeKind,
    title: z.string().min(1),
    body: z.string().optional(),
    status: TaskStatus.optional(),
    attrs: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    op: z.literal('update_node'),
    id: IdOrRef,
    title: z.string().min(1).optional(),
    body: z.string().optional(),
    status: TaskStatus.optional(),
    attrs: z.record(z.string(), z.unknown()).optional().describe('Merged into existing attrs; null removes a key'),
    version: z.number().int().optional().describe('Fail if the node changed since this version'),
  }),
  z.object({ op: z.literal('delete_node'), id: IdOrRef }),
  z.object({ op: z.literal('create_edge'), src: IdOrRef, kind: EdgeKind, dst: IdOrRef, note: z.string().optional() }),
  z.object({ op: z.literal('update_edge'), id: Id, note: z.string() }),
  z.object({ op: z.literal('delete_edge'), id: Id.optional(), src: IdOrRef.optional(), kind: EdgeKind.optional(), dst: IdOrRef.optional() }),
  z.object({
    op: z.literal('update_event'),
    id: Id,
    body: z.string().optional(),
    instructions: z.string().optional(),
    state: EventState.optional(),
    tasks: z.array(IdOrRef).optional(),
  }),
  z.object({ op: z.literal('delete_event'), id: Id }),
]);
export type Op = z.infer<typeof Op>;
export const Ops = z.array(Op).min(1);

/** Where a change came from. Recorded in the audit log. */
export type Via = 'ui' | 'mcp' | 'core' | 'bus';

// ---------------------------------------------------------------- bus messages (RabbitMQ)

/** What a runner publishes to ariadne.inbox. RabbitMQ's validated user_id says who sent it. */
export const InboxMessage = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('report'),
    sender: Id,
    replyTo: Id,
    body: z.string(),
    closes: z.boolean().default(true),
    proposals: z.array(z.unknown()).optional(),
    answers: z.record(z.string(), Answer).optional(),
  }),
  z.object({
    type: z.literal('assign'),
    sender: Id,
    recipient: Id.describe('A direct subordinate of the sender'),
    body: z.string(),
    instructions: z.string().optional(),
    tasks: z.array(Id).optional(),
  }),
  z.object({ type: z.literal('status'), sender: Id, text: z.string().max(200), eventId: Id.optional() }),
]);
export type InboxMessage = z.infer<typeof InboxMessage>;
