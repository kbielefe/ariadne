// The whole loop through a real RabbitMQ: relay → runner → inbox → core.
// Needs TEST_DATABASE_URL (scripts/dev-db.sh) and TEST_AMQP_URL (scripts/dev-rabbit.sh).
import amqp from 'amqplib';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { amqpPublisher, consumeInbox, Relay } from '../server/bus';
import type { Core } from '../server/core';
import type { Db } from '../server/db';
import * as s from '../server/store';
import { who } from '../server/store';
import { ACTOR_QUEUE_OPTIONS, actorQueue, INBOX_QUEUE } from '../shared/bus';
import { ANALYST_ID, USER_ID } from '../shared/model';
import { freshCore } from '../test/db';
import { consume } from './adapters';
import { handleAgent, type Publish } from './handlers';

const URL = process.env.TEST_AMQP_URL ?? 'amqp://ariadne:ariadne-dev@127.0.0.1:5673/ariadne';
const log = { info() {}, error: (m: string, o?: object) => console.error(m, o) };
let db: Db;
let core: Core;
const stops: (() => Promise<void> | void)[] = [];

beforeEach(async () => {
  ({ db, core } = await freshCore());
  const conn = await amqp.connect(URL);
  const ch = await conn.createChannel();
  await ch.deleteQueue(INBOX_QUEUE).catch(() => {});
  await conn.close();
});
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  await db.end();
});

async function until<T>(fn: () => Promise<T | undefined | null | false>, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

it('delivers an assignment to an agent runner and records its report', async () => {
  const [{ id: coder } = { id: "" }] = await core.ops(who(USER_ID, 'ui'), [
    { op: 'create_node', ref: 'c', kind: 'agent', title: 'Coder', attrs: { models: ['sonnet'] } },
    { op: 'create_edge', src: '$c', kind: 'reports_to', dst: ANALYST_ID },
  ]);
  const conn = await amqp.connect(URL);
  const ch = await conn.createChannel();
  await ch.deleteQueue(actorQueue(coder!)).catch(() => {});
  await conn.close();

  const publisher = amqpPublisher(URL, log);
  const relay = new Relay(core, publisher, log);
  relay.start(200);
  stops.push(() => relay.stop(), () => publisher.close(), consumeInbox(URL, core, log));

  let publish: Publish = async () => {};
  const prompts: string[] = [];
  const runner = await consume(
    URL,
    coder!,
    (d) => handleAgent(d, async (o) => (prompts.push(o.prompt), { ok: true, text: 'Done: openid-client.\n\n```ariadne\n{"status":"done","proposals":[{"op":"create_node","kind":"task","title":"Write ADR"}]}\n```' }), publish, log),
    (p) => (publish = p),
    log,
  );
  stops.push(() => runner.close());

  const job = await core.send(who(ANALYST_ID, 'mcp'), { kind: 'assign', recipient: coder!, body: 'Pick an OIDC library' });
  const closed = await until(async () => {
    const e = await s.getEvent(db, job.id);
    return e.state === 'closed' && e;
  });
  expect(closed.delivery).toBe('delivered');
  expect(prompts[0]).toContain('Pick an OIDC library');
  const [report] = await s.listEvents(db, { kind: 'report', actor: coder! });
  expect(report).toMatchObject({ sender: coder, recipient: ANALYST_ID, body: 'Done: openid-client.', proposals: [{ title: 'Write ADR' }], delivery: expect.stringMatching(/pending|delivered/) });
});

it('leaves events for interactive agents (the Analyst) for claim_assignment, not RabbitMQ', async () => {
  const conn = await amqp.connect(URL);
  const ch = await conn.createChannel();
  await ch.deleteQueue(actorQueue(ANALYST_ID)).catch(() => {});
  await ch.assertQueue(actorQueue(ANALYST_ID), ACTOR_QUEUE_OPTIONS);
  const chat = await core.chat('urgent question');
  const publisher = amqpPublisher(URL, log);
  stops.push(() => publisher.close());
  expect(await new Relay(core, publisher, log).flush()).toBe(0);
  expect((await ch.checkQueue(actorQueue(ANALYST_ID))).messageCount).toBe(0);
  expect((await s.getEvent(db, chat.id)).delivery).toBe('pending');
  await conn.close();
});
