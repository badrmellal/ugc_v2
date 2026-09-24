import pg from 'pg';
import type { AppConfig } from '../config.js';

// Return numeric columns as JS numbers (costs are small, well within double precision).
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => (v === null ? null : Number(v)));

export type Db = pg.Pool;

export function createPool(config: AppConfig): Db {
  const pool = new pg.Pool({
    connectionString: config.db.url,
    max: config.db.poolMax,
    ssl: config.db.ssl ? { rejectUnauthorized: false } : undefined,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: `omni-ugc-${config.role}`,
  });
  // Without a listener an idle-client error would crash the process.
  pool.on('error', () => undefined);
  return pool;
}
