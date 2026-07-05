import pg from "pg";
import { config } from "../config";

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
});

/** Either the shared pool or a transaction-scoped client. */
export type Db = pg.Pool | pg.PoolClient;

function camelKey(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/** Maps a snake_case row from Postgres into a camelCase object. */
export function camelRow<T = Record<string, unknown>>(row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[camelKey(k)] = v;
  return out as T;
}

/** Query returning camelCased rows. */
export async function q<T = Record<string, unknown>>(
  db: Db,
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await db.query(text, params);
  return res.rows.map((r) => camelRow<T>(r));
}

/** Query returning the first row or null. */
export async function qOne<T = Record<string, unknown>>(
  db: Db,
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await q<T>(db, text, params);
  return rows[0] ?? null;
}

/** Runs `fn` inside a transaction, rolling back on any error. */
export async function withTx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
