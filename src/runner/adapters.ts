// Runner adapters: RabbitMQ in and out, and `claude -p` as the model.
import { spawn } from 'node:child_process';
import amqp from 'amqplib';
import type { Delivery } from '../server/context';
import { ACTOR_QUEUE_OPTIONS, actorQueue, DELIVER_EXCHANGE, INBOX_QUEUE, INBOX_QUEUE_OPTIONS } from '../shared/bus';
import type { Log, Publish, RunModel } from './handlers';

/**
 * Consumes this actor's queue, one delivery at a time, until the connection closes.
 * Duplicate deliveries (same message id) are acked without running again.
 */
export async function consume(url: string, actorId: string, handle: (d: Delivery) => Promise<void>, publishVia: (p: Publish) => void, log: Log): Promise<{ closed: Promise<void>; close(): Promise<void> }> {
  const conn = await amqp.connect(url);
  conn.on('error', (err: Error) => log.error('runner.broker-error', { error: err.message }));
  const closed = new Promise<void>((resolve) => conn.on('close', () => resolve()));
  const out = await conn.createConfirmChannel();
  await out.assertQueue(INBOX_QUEUE, INBOX_QUEUE_OPTIONS);
  publishVia(
    (m) =>
      new Promise<void>((resolve, reject) =>
        out.sendToQueue(INBOX_QUEUE, Buffer.from(JSON.stringify(m)), { persistent: m.type !== 'status', contentType: 'application/json' }, (err) => (err ? reject(err instanceof Error ? err : new Error(String(err))) : resolve())),
      ),
  );
  const ch = await conn.createChannel();
  await ch.assertExchange(DELIVER_EXCHANGE, 'direct', { durable: true });
  await ch.assertQueue(actorQueue(actorId), ACTOR_QUEUE_OPTIONS);
  await ch.bindQueue(actorQueue(actorId), DELIVER_EXCHANGE, actorId);
  await ch.prefetch(1);
  const seen: string[] = [];
  await ch.consume(actorQueue(actorId), (msg) => {
    if (!msg) return;
    void (async () => {
      const id = msg.properties.messageId as string | undefined;
      if (id && seen.includes(id)) return ch.ack(msg);
      try {
        await handle(JSON.parse(msg.content.toString('utf8')) as Delivery);
        if (id) seen.push(id) > 500 && seen.shift();
        ch.ack(msg);
      } catch (err) {
        log.error('runner.handle-failed', { error: err instanceof Error ? err.message : String(err), id });
        // Back off before retrying, so a broken message doesn't spin.
        setTimeout(() => ch.nack(msg, false, true), 15_000);
      }
    })();
  });
  log.info('runner.consuming', { queue: actorQueue(actorId) });
  return { closed, close: async () => conn.close().catch(() => {}) };
}

export interface ClaudeOptions {
  command: string;
  /** Extra arguments for every run: tools, permission mode, sandbox... */
  args: string[];
  cwd: string;
  timeoutMs: number;
  log: Log;
}

/** Runs `claude -p` and returns its final text. */
export function claude(o: ClaudeOptions): RunModel {
  return (r) =>
    new Promise((resolve) => {
      const args = ['-p', r.prompt, '--output-format', 'json', '--no-session-persistence'];
      if (r.systemPrompt) args.push('--append-system-prompt', r.systemPrompt);
      if (r.model) args.push('--model', r.model);
      if (r.effort) args.push('--effort', r.effort);
      // Headless agents get no MCP servers: their delivery is all they need.
      args.push('--strict-mcp-config');
      args.push(...o.args);
      const child = spawn(o.command, args, { cwd: o.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (b: Buffer) => (stdout += b.toString()));
      child.stderr.on('data', (b: Buffer) => (stderr += b.toString()));
      const timer = setTimeout(() => child.kill('SIGTERM'), o.timeoutMs);
      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ ok: false, text: err.message });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        try {
          const j = JSON.parse(stdout) as { result?: string; is_error?: boolean };
          resolve({ ok: code === 0 && !j.is_error, text: j.result ?? '' });
        } catch {
          o.log.error('claude.unparsed-output', { code, stderr: stderr.slice(0, 500) });
          resolve({ ok: false, text: (stderr || stdout).slice(0, 2000) });
        }
      });
    });
}
