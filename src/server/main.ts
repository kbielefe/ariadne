// Ariadne server: web UI + API + MCP, in one process.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { registerApi } from './api';
import { Core } from './core';
import { createPool, migrate } from './db';
import { Hub } from './hub';
import { dropExpiredIntents } from './steward';

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

  const db = createPool(databaseUrl);
  const applied = await migrate(db, env.ARIADNE_MIGRATIONS_DIR ?? resolve(import.meta.dirname, 'migrations'));
  if (applied.length) console.log(`Applied migrations: ${applied.join(', ')}`);
  if (process.argv.includes('--migrate-only')) return db.end();

  const hub = new Hub();
  const core = new Core(db, hub);

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

  await app.listen({ host, port });
  // Teammates' steward intents expire: drop them now and every few minutes (docs/DESIGN.md §6).
  const sweep = () => void dropExpiredIntents(core).catch((err) => app.log.error(err, 'dropping expired intents'));
  sweep();
  const sweeper = setInterval(sweep, 5 * 60_000);
  sweeper.unref();
  const shutdown = async () => {
    clearInterval(sweeper);
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
