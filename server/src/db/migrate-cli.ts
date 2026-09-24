import { pino } from 'pino';
import { loadConfig } from '../config.js';
import { createPool } from './pool.js';
import { runMigrations } from './migrate.js';

const logger = pino({ name: 'migrate' });

async function main(): Promise<void> {
  // Migrations do not need Gemini credentials.
  const config = loadConfig({ GEMINI_MOCK: 'true', ...process.env, NODE_ENV: 'development' });
  const pool = createPool(config);
  try {
    const applied = await runMigrations(pool, logger);
    logger.info({ applied }, applied.length ? 'migrations applied' : 'database is up to date');
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  logger.error({ err }, 'migration failed');
  process.exit(1);
});
