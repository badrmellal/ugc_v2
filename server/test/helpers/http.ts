/**
 * Builds the real Fastify app on a real Postgres database with fake adapters (no Google, no ffmpeg
 * unless overridden). The worker is null (ROLE=web), so queued jobs stay queued.
 */
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { pino } from 'pino';
import type { AppContext } from '../../src/app-context.js';
import { loadConfig } from '../../src/config.js';
import type { Db } from '../../src/db/pool.js';
import { GenerationRepository } from '../../src/db/repository.js';
import { buildApp } from '../../src/http/app.js';
import type { GenerationPipeline } from '../../src/pipeline/runner.js';
import { TEST_DATABASE_URL } from './db.js';
import { FakeMediaTools, FakePlanner, FakeTextClient, FakeVideoClient } from './fakes.js';
import { MemoryStorage } from './memory-storage.js';

export const TEST_PASSWORD = 'correct horse battery staple';
export const TEST_TOKEN = 'test-api-token-0123456789abcdef';
export const TEST_SESSION_SECRET = 'test-session-secret-0123456789abcdef-0123456789';

export function testEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    ROLE: 'web',
    GEMINI_MOCK: 'true',
    LOG_LEVEL: 'silent',
    DATABASE_URL: TEST_DATABASE_URL,
    APP_PASSWORD: TEST_PASSWORD,
    SESSION_SECRET: TEST_SESSION_SECRET,
    API_TOKENS: TEST_TOKEN,
    RATE_LIMIT_PER_MINUTE: '100000',
    CREATE_RATE_LIMIT_PER_HOUR: '100000',
    MAX_QUEUED_JOBS: '100',
    WEB_DIST_DIR: '/nonexistent/omni-web-dist',
    ...extra,
  };
}

export interface Harness {
  app: FastifyInstance;
  ctx: AppContext;
  storage: MemoryStorage;
  planner: FakePlanner;
  media: FakeMediaTools;
  close(): Promise<void>;
}

export async function createHarness(
  db: Db,
  env: Record<string, string | undefined> = {},
  overrides: Partial<AppContext> = {},
): Promise<Harness> {
  const config = loadConfig(testEnv(env));
  const storage = new MemoryStorage();
  const planner = new FakePlanner();
  const media = new FakeMediaTools();
  const ctx: AppContext = {
    config,
    logger: pino({ level: 'silent' }),
    db,
    repo: new GenerationRepository(db),
    storage,
    media,
    video: new FakeVideoClient(),
    text: new FakeTextClient(),
    planner,
    // The API never runs jobs itself; it only needs the worker (null here) to be notified.
    pipeline: {} as GenerationPipeline,
    captions: null,
    worker: null,
    ...overrides,
  } as AppContext;
  const app = buildApp(ctx);
  await app.ready();
  return { app, ctx, storage, planner, media, close: () => app.close() };
}

export const bearer = { authorization: `Bearer ${TEST_TOKEN}` };

/** Signs in with the test password and returns the `cookie` header value to send back. */
export async function login(app: FastifyInstance): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: TEST_PASSWORD } });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  const cookie = res.cookies.find((c) => c.name === 'omni_session');
  if (!cookie) throw new Error('login did not set the session cookie');
  return `omni_session=${cookie.value}`;
}

export function json<T = unknown>(res: LightMyRequestResponse): T {
  return JSON.parse(res.body) as T;
}
