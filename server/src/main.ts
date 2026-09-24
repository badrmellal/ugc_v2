import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { closeAppContext, createAppContext, type AppContext } from './app-context.js';
import { loadConfig, type AppConfig } from './config.js';
import { runMigrations } from './db/migrate.js';
import { isAuthEnabled } from './http/auth.js';
import { buildApp, buildHealthApp, resolveWebDist } from './http/app.js';
import { createLogger } from './logger.js';

/**
 * Hard stop if a graceful shutdown hangs (for example a slow client still downloading a video). Cloud
 * Run sends SIGKILL 10s after SIGTERM anyway; the worker releases its job leases within
 * WORKER_SHUTDOWN_GRACE_MS, before that. Platforms with a longer grace period get up to this long.
 */
const FORCE_EXIT_MS = 25_000;

function authMode(config: AppConfig): string {
  if (!isAuthEnabled(config)) return config.auth.disabled ? 'disabled (AUTH_DISABLED)' : 'disabled (development)';
  const modes = [
    config.auth.password ? 'password' : null,
    config.auth.apiTokens.length ? `${config.auth.apiTokens.length} API token(s)` : null,
  ].filter(Boolean);
  return modes.length ? modes.join(' + ') : 'enabled (no credentials configured)';
}

function logStartupSummary(config: AppConfig, logger: Logger): void {
  logger.info(
    {
      env: config.env,
      mock: config.gemini.mock,
      models: { video: config.gemini.videoModel, splitter: config.gemini.splitterModel },
      storage: config.storage.driver,
      presignedUrls: config.storage.driver === 's3' ? config.storage.s3.presignedUrls : false,
      auth: config.role === 'worker' ? 'not applicable (worker serves no API)' : authMode(config),
      publicOrigin: config.publicOrigin,
      dailyBudgetUsd: config.budget.dailyUsd,
      maxQueuedJobs: config.worker.maxQueuedJobs,
      workerConcurrency: config.role === 'web' ? 0 : config.worker.concurrency,
      webDist: config.role === 'worker' ? null : resolveWebDist(config),
    },
    'starting Omni UGC Studio',
  );
}

async function main(): Promise<void> {
  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (err) {
    // The logger depends on the configuration; report configuration errors plainly.
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const logger = createLogger(config);
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'unhandled promise rejection');
    process.exit(1);
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaught exception');
    process.exit(1);
  });

  try {
    await start(config, logger);
  } catch (err) {
    logger.fatal({ err }, 'startup failed');
    process.exit(1);
  }
}

async function start(config: AppConfig, logger: Logger): Promise<void> {
  logStartupSummary(config, logger);
  const ctx: AppContext = createAppContext(config, { logger });

  if (config.db.migrateOnStart) {
    const applied = await runMigrations(ctx.db, logger);
    logger.info({ applied }, applied.length ? 'database migrations applied' : 'database schema is up to date');
  }

  const app: FastifyInstance = config.role === 'worker' ? buildHealthApp(ctx) : buildApp(ctx);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    const force = setTimeout(() => {
      logger.error({ timeoutMs: FORCE_EXIT_MS }, 'graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, FORCE_EXIT_MS);
    force.unref();
    try {
      // Stop accepting requests first; the worker stops in parallel so long video streams do not
      // delay releasing job leases (another instance resumes the jobs from their checkpoints).
      const closing = app.close();
      await ctx.worker?.stop();
      await closing;
      await closeAppContext(ctx);
      logger.info('shutdown complete');
      clearTimeout(force);
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: config.host, port: config.port });
  // A SIGTERM that arrived while listen() was pending must not start claiming jobs.
  if (shuttingDown) return;
  ctx.worker?.start();
  logger.info(
    { host: config.host, port: config.port, worker: Boolean(ctx.worker) },
    config.role === 'worker' ? 'worker ready (serving /healthz and /readyz only)' : 'server ready',
  );
}

main().catch((err: unknown) => {
  console.error('Startup failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
