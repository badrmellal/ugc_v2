/**
 * Real-Postgres test database: runs the migrations once per test file and truncates every table
 * between tests. Point TEST_DATABASE_URL at a disposable database (it is wiped).
 */
import { loadConfig } from '../../src/config.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createPool, type Db } from '../../src/db/pool.js';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/omni_ugc_test';

export interface TestDb {
  db: Db;
  /** Removes every row (generations, events, ledger). */
  reset(): Promise<void>;
  close(): Promise<void>;
}

export async function truncateAll(db: Db): Promise<void> {
  await db.query('TRUNCATE generation_events, api_calls, generations RESTART IDENTITY CASCADE');
}

export async function createTestDb(): Promise<TestDb> {
  const config = loadConfig({
    NODE_ENV: 'test',
    GEMINI_MOCK: 'true',
    DATABASE_URL: TEST_DATABASE_URL,
    DATABASE_POOL_MAX: '5',
  });
  const db = createPool(config);
  await runMigrations(db);
  await truncateAll(db);
  return {
    db,
    reset: () => truncateAll(db),
    close: () => db.end(),
  };
}
