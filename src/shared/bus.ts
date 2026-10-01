// RabbitMQ topology, shared by Ariadne and the runners.
//
//   Ariadne ──publish──► exchange ariadne.deliver (direct, key = actor id) ──► queue ariadne.actor.<id>
//   runner  ──publish──► queue ariadne.inbox ──► Ariadne
//
// Deliveries are self-contained (see server/context.ts): agents never call back into Ariadne.
export const DELIVER_EXCHANGE = 'ariadne.deliver';
export const INBOX_QUEUE = 'ariadne.inbox';
export const actorQueue = (actorId: string) => `ariadne.actor.${actorId}`;

/** Declared identically by Ariadne and runners (RabbitMQ refuses mismatched arguments). */
export const ACTOR_QUEUE_OPTIONS = { durable: true, arguments: { 'x-max-priority': 10 } } as const;
export const INBOX_QUEUE_OPTIONS = { durable: true } as const;

/** Your chats and card answers go ahead of agent reports in the analyst's queue. */
export const PRIORITY = { user: 9, decision: 8, normal: 1 } as const;
