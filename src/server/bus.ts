// Moves events between the database and RabbitMQ.
//   Relay: events with delivery = 'pending' → build the delivery → publish (confirmed) → 'delivered'.
//          Interactive agents are skipped: they pull their assignments over MCP (server/workmcp.ts).
//   Inbox: runner messages from ariadne.inbox → Core.receive.
// With no broker configured, events simply wait as 'pending'.
import amqp from 'amqplib';
import { ZodError } from 'zod';
import { ACTOR_QUEUE_OPTIONS, actorQueue, DELIVER_EXCHANGE, INBOX_QUEUE, INBOX_QUEUE_OPTIONS, PRIORITY } from '../shared/bus';
import { USER_ID } from '../shared/model';
import { ContextBuilder, type Delivery } from './context';
import type { Core } from './core';
import { withTx } from './db';
import * as s from './store';

export interface Publisher {
  publish(recipient: string, d: Delivery, o: { messageId: string; priority: number }): Promise<void>;
}

export interface Log {
  info(msg: string, o?: object): void;
  error(msg: string, o?: object): void;
}

export class Relay {
  private running = false;
  private again = false;
  private timers: NodeJS.Timeout[] = [];
  private off: (() => void) | null = null;

  constructor(
    private readonly core: Core,
    private readonly publisher: Publisher,
    private readonly log: Log,
  ) {}

  start(intervalMs = 3000) {
    this.off = this.core.hub.on('deliver', () => void this.flush());
    this.timers.push(setInterval(() => void this.flush(), intervalMs));
    void this.flush();
  }

  stop() {
    this.off?.();
    for (const t of this.timers) clearInterval(t);
  }

  /** Publishes everything pending. Safe to call often; runs one pass at a time. */
  async flush(): Promise<number> {
    if (this.running) {
      this.again = true;
      return 0;
    }
    this.running = true;
    let total = 0;
    try {
      do {
        this.again = false;
        total += await this.pass();
      } while (this.again);
    } catch (err) {
      this.log.error('relay.failed', { error: err instanceof Error ? err.message : String(err) });
    } finally {
      this.running = false;
    }
    return total;
  }

  private async pass(): Promise<number> {
    let published = 0;
    for (;;) {
      const n = await withTx(this.core.db, async (tx) => {
        const r = await tx.query(
          `SELECT e.id FROM events e JOIN nodes n ON n.id = e.recipient
           WHERE e.delivery = 'pending' AND n.kind = 'agent' AND NOT coalesce((n.attrs->>'paused')::boolean, false)
             AND NOT coalesce((n.attrs->>'interactive')::boolean, false)
           ORDER BY e.created_at LIMIT 20 FOR UPDATE OF e SKIP LOCKED`,
        );
        if (!r.rowCount) return 0;
        const ctx = await ContextBuilder.load(tx);
        for (const row of r.rows) {
          const ev = await s.getEvent(tx, row.id);
          const d = await ctx.delivery(ev);
          const priority = ev.sender === USER_ID ? PRIORITY.user : ev.questions ? PRIORITY.decision : PRIORITY.normal;
          await this.publisher.publish(ev.recipient!, d, { messageId: ev.id, priority });
          await tx.query(`UPDATE events SET delivery = 'delivered', delivered_at = now() WHERE id = $1`, [ev.id]);
        }
        return r.rowCount;
      });
      published += n;
      if (n < 20) break;
    }
    if (published) this.core.hub.changed();
    return published;
  }
}

/** A RabbitMQ publisher that reconnects lazily. */
export function amqpPublisher(url: string, log: Log): Publisher & { close(): Promise<void> } {
  let conn: amqp.ChannelModel | null = null;
  let ch: amqp.ConfirmChannel | null = null;
  const declared = new Set<string>();
  async function open() {
    if (ch) return ch;
    conn = await amqp.connect(url);
    conn.on('error', (err: Error) => log.error('bus.error', { error: err.message }));
    conn.on('close', () => {
      conn = null;
      ch = null;
      declared.clear();
    });
    const c = await conn.createConfirmChannel();
    await c.assertExchange(DELIVER_EXCHANGE, 'direct', { durable: true });
    ch = c;
    return c;
  }
  return {
    async publish(recipient, d, o) {
      const c = await open();
      if (!declared.has(recipient)) {
        await c.assertQueue(actorQueue(recipient), ACTOR_QUEUE_OPTIONS);
        await c.bindQueue(actorQueue(recipient), DELIVER_EXCHANGE, recipient);
        declared.add(recipient);
      }
      await new Promise<void>((resolve, reject) =>
        c.publish(DELIVER_EXCHANGE, recipient, Buffer.from(JSON.stringify(d)), { persistent: true, contentType: 'application/json', messageId: o.messageId, priority: o.priority }, (err) =>
          err ? reject(err instanceof Error ? err : new Error(String(err))) : resolve(),
        ),
      );
    },
    async close() {
      await ch?.close().catch(() => {});
      await conn?.close().catch(() => {});
    },
  };
}

/** Consumes ariadne.inbox, reconnecting with backoff. Returns a stop function. */
export function consumeInbox(url: string, core: Core, log: Log): () => Promise<void> {
  let stopped = false;
  let conn: amqp.ChannelModel | null = null;
  const loop = async () => {
    let delay = 1000;
    while (!stopped) {
      try {
        conn = await amqp.connect(url);
        const closed = new Promise<void>((resolve) => conn!.on('close', () => resolve()));
        conn.on('error', (err: Error) => log.error('inbox.error', { error: err.message }));
        const ch = await conn.createChannel();
        await ch.assertQueue(INBOX_QUEUE, INBOX_QUEUE_OPTIONS);
        await ch.prefetch(10);
        await ch.consume(INBOX_QUEUE, (msg) => {
          if (!msg) return;
          void (async () => {
            try {
              await core.receive(JSON.parse(msg.content.toString('utf8')), msg.properties.userId ?? null);
              ch.ack(msg);
            } catch (err) {
              const permanent = err instanceof SyntaxError || err instanceof ZodError || err instanceof s.Invalid || err instanceof s.NotFound;
              log.error('inbox.rejected', { error: err instanceof Error ? err.message : String(err), permanent });
              if (permanent) ch.ack(msg);
              else setTimeout(() => ch.nack(msg, false, true), 5000);
            }
          })();
        });
        log.info('inbox.consuming', {});
        delay = 1000;
        await closed;
      } catch (err) {
        log.error('inbox.connect-failed', { error: err instanceof Error ? err.message : String(err) });
      }
      if (!stopped) await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 30_000);
    }
  };
  void loop();
  return async () => {
    stopped = true;
    await conn?.close().catch(() => {});
  };
}
