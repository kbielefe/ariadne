// Ariadne v2 server: web UI + API + MCP + the scheduler + the RabbitMQ relay, in one process.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { registerApi } from './api';
import { amqpPublisher, consumeInbox, Relay } from './bus';
import { Core } from './core';
import { createPool, migrate } from './db';
import { Hub } from './hub';
import { startScheduler } from './scheduler';

const env = process.env;

/** VALUE, or the contents of the file named by VALUE_FILE. */
function secret(name: string): string | undefined {
  if (env[name]) return env[name];
  const file = env[`${name}_FILE`];
  if (file && existsSync(file)) return readFileSync(file, 'utf8').trim() || undefined;
  return undefined;
}

async function main() {
  const databaseUrl = secret('DATABASE_URL');
  if (!databaseUrl) throw new Error('Set DATABASE_URL');
  const host = env.ARIADNE_LISTEN_HOST ?? '127.0.0.1';
  const port = Number(env.ARIADNE_LISTEN_PORT ?? 3100);
  const allowedHosts = (env.ARIADNE_ALLOWED_HOSTS ?? `127.0.0.1:${port},localhost:${port}`).split(',').map((h) => h.trim());
  const amqpUrl = secret('ARIADNE_AMQP_URL');

  const db = createPool(databaseUrl);
  const applied = await migrate(db, env.ARIADNE_MIGRATIONS_DIR ?? resolve(import.meta.dirname, 'migrations'));
  if (applied.length) console.log(`Applied migrations: ${applied.join(', ')}`);
  if (process.argv.includes('--migrate-only')) return db.end();

  const hub = new Hub();
  const core = new Core(db, hub, { decideTimeoutMs: Number(env.ARIADNE_DECIDE_TIMEOUT_MS ?? 5000), claimTimeoutMinutes: Number(env.ARIADNE_CLAIM_TIMEOUT_MINUTES ?? 30), claimWaitMinutes: Number(env.ARIADNE_CLAIM_WAIT_MINUTES ?? 480) });
  await core.releaseHeld();

  const app = Fastify({ logger: { level: env.LOG_LEVEL ?? 'info' }, bodyLimit: 2 * 1024 * 1024 });
  registerApi(app, core, { allowedHosts });
  const webDir = resolve(env.ARIADNE_WEB_DIR ?? 'dist/web');
  if (existsSync(webDir)) {
    await app.register(fastifyStatic, { root: webDir });
    // Client-side routes get the app; missing API routes and assets get a plain 404.
    app.setNotFoundHandler((req, reply) =>
      req.method !== 'GET' || /^\/(api|assets|mcp)\b/.test(req.url) ? reply.code(404).send({ error: 'Not found' }) : reply.sendFile('index.html'),
    );
  }

  const log = { info: (m: string, o?: object) => app.log.info(o ?? {}, m), error: (m: string, o?: object) => app.log.error(o ?? {}, m) };
  const stops: (() => Promise<void> | void)[] = [startScheduler(core, log)];
  if (amqpUrl) {
    const publisher = amqpPublisher(amqpUrl, log);
    const relay = new Relay(core, publisher, log);
    relay.start();
    stops.push(() => relay.stop(), () => publisher.close(), consumeInbox(amqpUrl, core, log));
  } else {
    app.log.warn('No ARIADNE_AMQP_URL: agents will not receive deliveries (events wait as pending).');
  }

  await app.listen({ host, port });
  const shutdown = async () => {
    for (const stop of stops) await stop();
    await app.close();
    await db.end();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
