import pg from "pg";

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://codity:codity@localhost:5433/codity_test";

/** Recreates the test database and applies migrations before the suite runs. */
export default async function setup(): Promise<void> {
  const url = new URL(TEST_DB_URL);
  const dbName = url.pathname.slice(1);
  if (!/^[a-z0-9_]+$/.test(dbName)) {
    throw new Error(`suspicious test database name: ${dbName}`);
  }

  const adminUrl = new URL(TEST_DB_URL);
  adminUrl.pathname = "/postgres";
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();

  process.env.DATABASE_URL = TEST_DB_URL;
  const { migrate } = await import("../../src/db/migrate");
  const pool = new pg.Pool({ connectionString: TEST_DB_URL });
  await migrate(pool);
  await pool.end();
}
