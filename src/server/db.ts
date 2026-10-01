import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

export function createPool(url: string): Db {
  return new pg.Pool({ connectionString: url, max: 10 });
}

export async function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const tx = await db.connect();
  try {
    await tx.query('BEGIN');
    const result = await fn(tx);
    await tx.query('COMMIT');
    return result;
  } catch (err) {
    await tx.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    tx.release();
  }
}

/** Applies *.sql files in name order, each once, in its own transaction. */
export async function migrate(db: Db, dir: string): Promise<string[]> {
  await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  for (const name of files) {
    await withTx(db, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(4242)');
      const done = await tx.query('SELECT 1 FROM schema_migrations WHERE name = $1', [name]);
      if (done.rowCount) return;
      await tx.query(await readFile(join(dir, name), 'utf8'));
      await tx.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
      applied.push(name);
    });
  }
  return applied;
}
