import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { generateKeyPair } from '@libp2p/crypto/keys';
import type { Ed25519PrivateKey } from '@libp2p/interface';
import { USER_ID } from '../../shared/model';
import { Core } from '../core';
import { createPool, type Db, migrate } from '../db';
import { Hub } from '../hub';
import { who } from '../store';
import { TEST_DATABASE_URL } from '../../test/db';
import { ident, Federation, type FederationOptions } from './index';
import { proxyFederation } from './proxy';

const NAMES = ['ariadne_fed_a', 'ariadne_fed_b', 'ariadne_fed_c'] as const;

interface Running {
  db: Db;
  core: Core;
  fed: Federation;
}

async function database(name: string): Promise<Db> {
  const admin = createPool(TEST_DATABASE_URL);
  await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [name]);
  await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${name}`;
  const db = createPool(url.toString());
  await migrate(db, resolve(import.meta.dirname, '../migrations'));
  return db;
}

async function boot(name: string, opt: FederationOptions): Promise<Running> {
  const db = await database(name);
  const hub = new Hub();
  const core = new Core(db, hub);
  opt.identity = ident((await generateKeyPair('Ed25519')) as Ed25519PrivateKey);
  const fed = await Federation.start(db, hub, opt);
  core.federation = fed;
  fed.core = core;
  return { db, core, fed };
}

async function titles(db: Db): Promise<string[]> {
  const r = await db.query('SELECT title FROM nodes');
  return r.rows.map((row) => row.title as string);
}

async function nodeByTitle(db: Db, title: string): Promise<{ id: string; version: number; home: string | null }> {
  const r = await db.query('SELECT id, version, home FROM nodes WHERE title = $1', [title]);
  if (!r.rows[0]) throw new Error(`no node ${title}`);
  return { id: r.rows[0].id as string, version: r.rows[0].version as number, home: (r.rows[0].home as string) ?? null };
}

describe('federation over a websocket proxy', () => {
  let A: Running;
  let B: Running;
  let C: Running;
  let proxy: Server;
  const optA: FederationOptions = { relay: 'server', listen: { host: '127.0.0.1', port: 0 } };

  beforeAll(async () => {
    A = await boot(NAMES[0], optA);
    const listen = A.fed.host.listenAddr ?? '';
    const port = Number(listen.match(/\/tcp\/(\d+)\//)?.[1]);
    if (!port) throw new Error(`A did not listen: ${listen}`);
    proxy = createServer((_req, res) => {
      res.end('ok');
    });
    await new Promise<void>((resolveListen) => proxy.listen(0, '127.0.0.1', () => resolveListen()));
    proxyFederation(proxy, port);
    optA.publicUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    B = await boot(NAMES[1], { relay: 'client', listen: { host: '127.0.0.1', port: 0 } });
    C = await boot(NAMES[2], { relay: 'client' });
    await B.fed.accept(await A.fed.invite('direct'));
  }, 60_000);

  afterAll(async () => {
    await Promise.all([A?.fed.stop(), B?.fed.stop(), C?.fed.stop()].map((p) => p?.catch(() => {})));
    await new Promise<void>((resolveClose) => (proxy ? proxy.close(() => resolveClose()) : resolveClose()));
    await Promise.all([A?.db.end(), B?.db.end(), C?.db.end()].map((p) => p?.catch(() => {})));
    const admin = createPool(TEST_DATABASE_URL);
    for (const name of NAMES) await admin.query(`DROP DATABASE IF EXISTS ${name}`).catch(() => {});
    await admin.end();
  });

  it('shares A with B through the proxy, and keeps an outside task local', async () => {
    const made = await B.fed.apply(who(null, 'ui'), [
      { op: 'create_node', ref: 'root', kind: 'task', title: 'Shared with A' },
      { op: 'create_node', ref: 'child', kind: 'task', title: 'Needed by shared' },
      { op: 'create_edge', src: '$root', kind: 'needs', dst: '$child' },
      { op: 'create_node', ref: 'out', kind: 'task', title: 'Outside the share' },
      { op: 'create_edge', src: '$out', kind: 'needs', dst: '$root' },
      { op: 'create_edge', src: '$root', kind: 'involves', dst: USER_ID },
    ]);
    const root = made.results.find((r) => r.ref === 'root')!.id;
    await B.fed.share(root, A.fed.peerId);
    await A.fed.sync();
    const onA = await titles(A.db);
    expect(onA).toContain('Shared with A');
    expect(onA).toContain('Needed by shared');
    expect(onA).not.toContain('Outside the share');
    const shared = await nodeByTitle(A.db, 'Shared with A');
    const involved = await A.db.query(`SELECT dst FROM edges WHERE src = $1 AND kind = 'involves'`, [shared.id]);
    expect(involved.rows).toHaveLength(1);
    expect(involved.rows[0].dst).not.toBe(USER_ID);
    const edited = await A.fed.apply(who(null, 'ui'), [{ op: 'update_node', id: shared.id, version: shared.version, title: 'Shared with A edited' }]);
    expect(edited.pending).toEqual([]);
    expect(await titles(B.db)).toContain('Shared with A edited');
    expect(await titles(A.db)).toContain('Shared with A edited');

    const current = await nodeByTitle(A.db, 'Shared with A edited');
    const stale = await A.fed.apply(who(null, 'ui'), [{ op: 'update_node', id: current.id, version: 1, title: 'Stale write' }]);
    expect(stale.pending[0]?.error).toMatch(/version/i);
    expect(await titles(A.db)).not.toContain('Stale write');
    expect(await titles(B.db)).not.toContain('Stale write');

    const child = await nodeByTitle(B.db, 'Needed by shared');
    await B.fed.apply(who(null, 'ui'), [{ op: 'delete_edge', src: root, kind: 'needs', dst: child.id }]);
    await A.fed.sync();
    expect(await titles(A.db)).not.toContain('Needed by shared');
  }, 60_000);

  it('relays a different share between B and C without showing it to A', async () => {
    const made = await B.fed.apply(who(null, 'ui'), [{ op: 'create_node', ref: 'root', kind: 'task', title: 'Between B and C' }]);
    const root = made.results[0]!.id;
    await C.fed.accept(await B.fed.invite('relay'));
    await B.fed.share(root, C.fed.peerId);
    await C.fed.sync();
    expect(await titles(C.db)).toContain('Between B and C');
    expect(await titles(A.db)).not.toContain('Between B and C');

    const created = await C.fed.apply(who(null, 'ui'), [
      { op: 'create_node', ref: 'n', kind: 'task', title: 'Only B and C' },
      { op: 'create_edge', src: root, kind: 'needs', dst: '$n' },
    ]);
    expect(created.pending).toEqual([]);
    expect(await titles(B.db)).toContain('Only B and C');
    expect(await titles(A.db)).not.toContain('Only B and C');

    await B.fed.stop();
    const rootOnC = await nodeByTitle(C.db, 'Between B and C');
    const proposed = await C.fed.apply(who(null, 'ui'), [{ op: 'update_node', id: rootOnC.id, version: rootOnC.version, title: 'Proposed while B slept' }]);
    expect(proposed.pending.length).toBe(1);
    const spool = await A.db.query('SELECT blob FROM spool');
    expect(spool.rows.length).toBeGreaterThan(0);
    const visible = spool.rows.map((row) => Buffer.from(row.blob as Buffer).toString('utf8')).join('\n');
    expect(visible).not.toContain('Proposed while B slept');

    await B.fed.host.start();
    await B.fed.sync();
    expect(await titles(B.db)).toContain('Proposed while B slept');
    await C.fed.sync();
    expect(await titles(C.db)).toContain('Proposed while B slept');
    expect(await titles(A.db)).not.toContain('Proposed while B slept');
    expect(await titles(A.db)).not.toContain('Only B and C');
  }, 90_000);
});
