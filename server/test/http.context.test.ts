import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAppContext, createAppContext, runsWorker } from '../src/app-context.js';
import { loadConfig } from '../src/config.js';
import { buildApp, buildHealthApp, resolveWebDist } from '../src/http/app.js';
import { Worker } from '../src/pipeline/worker.js';
import { TEST_DATABASE_URL } from './helpers/db.js';

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'omni-context-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function config(role: 'all' | 'web' | 'worker', extra: Record<string, string> = {}) {
  return loadConfig({
    NODE_ENV: 'test',
    ROLE: role,
    GEMINI_MOCK: 'true',
    LOG_LEVEL: 'silent',
    DATABASE_URL: TEST_DATABASE_URL,
    LOCAL_STORAGE_DIR: join(dir, 'storage'),
    WEB_DIST_DIR: join(dir, 'no-web-build'),
    ...extra,
  });
}

describe('createAppContext', () => {
  it('wires the real adapters and runs no worker for ROLE=web', async () => {
    const ctx = createAppContext(config('web'), { logger: pino({ level: 'silent' }) });
    try {
      expect(ctx.worker).toBeNull();
      expect(ctx.storage.kind).toBe('local');
      expect(ctx.video.isMock).toBe(true);
      expect(typeof ctx.planner.split).toBe('function');
      await ctx.repo.ping();
      await ctx.storage.healthCheck();

      const app = buildApp(ctx);
      const ready = await app.inject({ method: 'GET', url: '/readyz' });
      expect(ready.statusCode).toBe(200);
      await app.close();
    } finally {
      await closeAppContext(ctx);
    }
    expect(ctx.db.ended).toBe(true);
    // Idempotent.
    await closeAppContext(ctx);
  });

  it('creates a worker for ROLE=all and ROLE=worker, and honours an explicit override', async () => {
    expect(runsWorker('all')).toBe(true);
    expect(runsWorker('worker')).toBe(true);
    expect(runsWorker('web')).toBe(false);

    const ctx = createAppContext(config('all'), { logger: pino({ level: 'silent' }) });
    expect(ctx.worker).toBeInstanceOf(Worker);
    await closeAppContext(ctx);

    const none = createAppContext(config('worker'), { logger: pino({ level: 'silent' }), worker: null });
    expect(none.worker).toBeNull();
    await closeAppContext(none);
  });
});

describe('buildHealthApp (ROLE=worker)', () => {
  it('serves only the health probes', async () => {
    const ctx = createAppContext(config('worker'), { logger: pino({ level: 'silent' }), worker: null });
    const app = buildHealthApp(ctx);
    try {
      expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(200);
      const api = await app.inject({ method: 'GET', url: '/api/config' });
      expect(api.statusCode).toBe(404);
      expect(JSON.parse(api.body)).toMatchObject({ error: { code: 'not_found' } });
    } finally {
      await app.close();
      await closeAppContext(ctx);
    }
  });

  it('reports 503 when the database is unreachable', async () => {
    const ctx = createAppContext(
      config('worker', { DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:1/nothing' }),
      { logger: pino({ level: 'silent' }), worker: null },
    );
    const app = buildHealthApp(ctx);
    try {
      const res = await app.inject({ method: 'GET', url: '/readyz' });
      expect(res.statusCode).toBe(503);
      expect(JSON.parse(res.body)).toEqual({ status: 'unavailable', checks: { database: 'error', storage: 'ok' } });
    } finally {
      await app.close();
      await closeAppContext(ctx);
    }
  });
});

describe('resolveWebDist', () => {
  it('uses WEB_DIST_DIR only when it contains index.html', () => {
    expect(resolveWebDist(config('web'))).toBeNull();
  });
});
