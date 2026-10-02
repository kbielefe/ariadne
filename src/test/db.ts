import { resolve } from 'node:path';
import { Core } from '../server/core';
import { createPool, type Db, migrate } from '../server/db';
import { Hub } from '../server/hub';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://ariadne:ariadne-dev@127.0.0.1:55433/ariadne_test';

/** A fresh schema and a Core on it. */
export async function freshCore(): Promise<{ db: Db; hub: Hub; core: Core }> {
  const db = createPool(TEST_DATABASE_URL);
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db, resolve(import.meta.dirname, '../server/migrations'));
  const hub = new Hub();
  return { db, hub, core: new Core(db, hub) };
}
