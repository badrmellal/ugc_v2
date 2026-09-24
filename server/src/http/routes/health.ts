import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../app-context.js';
import { redactSecrets } from '../../pipeline/errors.js';

const CHECK_TIMEOUT_MS = 3000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Liveness (no dependencies) and readiness (database + storage). Never authenticated. */
export function registerHealthRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/healthz', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
    return { status: 'ok' };
  });

  app.get('/readyz', async (req, reply) => {
    const [database, storage] = await Promise.allSettled([
      withTimeout(ctx.repo.ping(), CHECK_TIMEOUT_MS),
      withTimeout(ctx.storage.healthCheck(), CHECK_TIMEOUT_MS),
    ]);
    const checks = {
      database: database.status === 'fulfilled' ? 'ok' : 'error',
      storage: storage.status === 'fulfilled' ? 'ok' : 'error',
    };
    const ready = checks.database === 'ok' && checks.storage === 'ok';
    if (!ready) {
      // Driver errors can echo endpoints or credentials: log them redacted.
      const secrets = [ctx.config.storage.s3.secretAccessKey, ctx.config.gemini.apiKey];
      const reason = (r: PromiseSettledResult<unknown>) =>
        r.status === 'rejected'
          ? redactSecrets(r.reason instanceof Error ? r.reason.message : String(r.reason), secrets)
          : 'ok';
      req.log.warn({ database: reason(database), storage: reason(storage) }, 'readiness check failed');
    }
    reply.header('cache-control', 'no-store');
    return reply.code(ready ? 200 : 503).send({ status: ready ? 'ok' : 'unavailable', checks });
  });
}
