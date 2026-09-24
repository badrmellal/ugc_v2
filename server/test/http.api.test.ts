import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { get as httpGet } from 'node:http';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '../src/app-context.js';
import { loadConfig } from '../src/config.js';
import { TOKEN_ATTEMPTS_PER_MINUTE } from '../src/http/app.js';
import { signSession, SESSION_COOKIE } from '../src/http/auth.js';
import { FfmpegMediaTools } from '../src/media/ffmpeg.js';
import { estimateCost } from '../src/pricing/pricing.js';
import {
  DEFAULT_SETTINGS,
  LIMITS,
  type ApiErrorBody,
  type AppConfigResponse,
  type CostBreakdown,
  type GenerationDTO,
  type GenerationListResponse,
  type ScriptPlan,
  type SessionResponse,
} from '../src/shared/api.js';
import { generationKeys, LocalStorage } from '../src/storage/index.js';
import { createTestDb, type TestDb } from './helpers/db.js';
import { createRequest, makePng, multipart, SAMPLE_SCRIPT, SAMPLE_SETTINGS } from './helpers/fixtures.js';
import {
  bearer,
  createHarness,
  json,
  login,
  TEST_SESSION_SECRET,
  TEST_TOKEN,
  testEnv,
  type Harness,
} from './helpers/http.js';

let testDb: TestDb;
let current: Harness | null = null;

beforeAll(async () => {
  testDb = await createTestDb();
});
afterAll(async () => {
  await testDb?.close();
});
beforeEach(async () => {
  await testDb.reset();
});
afterEach(async () => {
  await current?.close();
  current = null;
});

async function harness(env: Record<string, string | undefined> = {}, overrides: Partial<AppContext> = {}) {
  current = await createHarness(testDb.db, env, overrides);
  return current;
}

function errorOf(res: { body: string }): ApiErrorBody['error'] {
  return (JSON.parse(res.body) as ApiErrorBody).error;
}

async function postGeneration(
  app: FastifyInstance,
  payload?: unknown,
  image?: { data: Buffer; contentType?: string; filename?: string },
  headers: Record<string, string> = bearer,
) {
  const req = createRequest(payload, image);
  return app.inject({
    method: 'POST',
    url: '/api/generations',
    headers: { ...headers, ...req.headers },
    payload: req.payload,
  });
}

async function createGeneration(app: FastifyInstance, payload?: unknown): Promise<GenerationDTO> {
  const res = await postGeneration(app, payload);
  expect(res.statusCode, res.body).toBe(202);
  return json<GenerationDTO>(res);
}

function samplePlan(): ScriptPlan {
  return {
    source: 'llm',
    character: 'The person in the reference image',
    setting: 'A bright kitchen',
    voice: 'Warm voice',
    audio: 'Room tone',
    language: 'en',
    segments: [
      {
        index: 1,
        startSec: 0,
        endSec: 10,
        dialogue: 'Okay, so I finally tried the new cold brew kit.',
        action: 'Holds up the kit',
        camera: 'Selfie framing',
        onScreenText: '',
        prompt: 'old prompt 1',
      },
      {
        index: 2,
        startSec: 10,
        endSec: 20,
        dialogue: 'Honestly, the smoothest coffee I have made at home.',
        action: 'Takes a sip',
        camera: 'Selfie framing',
        onScreenText: '',
        prompt: 'old prompt 2',
      },
    ],
    warnings: [],
    estimatedSpokenSeconds: 8,
  };
}

/** Simulates a finished generation: part 1, part 2 and the final video stored. */
async function completeGeneration(h: Harness, id: string, opts: { status?: 'succeeded' | 'failed' } = {}) {
  const keys = generationKeys(id);
  const video = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));
  await h.storage.putBuffer(keys.part1, video.subarray(0, 500), 'video/mp4');
  await h.storage.putBuffer(keys.final, video, 'video/mp4');
  await h.storage.putBuffer(keys.thumbnail, Buffer.from('fake-jpeg'), 'image/jpeg');
  const status = opts.status ?? 'succeeded';
  await h.ctx.repo.update(id, {
    status,
    stage: status === 'succeeded' ? 'completed' : 'failed',
    progress: status === 'succeeded' ? 100 : 50,
    plan: samplePlan(),
    part1InteractionId: `int-${id.slice(0, 8)}`,
    part1Status: 'completed',
    part1VideoKey: keys.part1,
    ...(status === 'succeeded'
      ? { finalVideoKey: keys.final, thumbnailKey: keys.thumbnail, durationSec: 20, assembly: 'model_full' as const }
      : {}),
    completedAt: new Date(),
  });
  return { keys, video };
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

describe('health', () => {
  it('serves /healthz without auth or dependencies', async () => {
    const { app } = await harness();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({ status: 'ok' });
  });

  it('reports readiness from the database and storage', async () => {
    const h = await harness();
    const ok = await h.app.inject({ method: 'GET', url: '/readyz' });
    expect(ok.statusCode).toBe(200);
    expect(json(ok)).toEqual({ status: 'ok', checks: { database: 'ok', storage: 'ok' } });

    h.storage.healthy = false;
    const down = await h.app.inject({ method: 'GET', url: '/readyz' });
    expect(down.statusCode).toBe(503);
    expect(json(down)).toEqual({ status: 'unavailable', checks: { database: 'ok', storage: 'error' } });
  });
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

describe('auth', () => {
  it('rejects unauthenticated API calls with 401', async () => {
    const { app } = await harness();
    const res = await app.inject({ method: 'GET', url: '/api/generations' });
    expect(res.statusCode).toBe(401);
    expect(errorOf(res).code).toBe('unauthorized');

    const session = await app.inject({ method: 'GET', url: '/api/auth/session' });
    expect(json<SessionResponse>(session)).toEqual({ authenticated: false, authRequired: true, user: null });
  });

  it('logs in with the password and uses the session cookie', async () => {
    const { app } = await harness();
    const wrong = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'nope' } });
    expect(wrong.statusCode).toBe(401);
    expect(errorOf(wrong)).toMatchObject({ code: 'unauthorized', message: 'Incorrect password.' });
    expect(wrong.cookies).toHaveLength(0);

    const empty = await app.inject({ method: 'POST', url: '/api/auth/login', payload: {} });
    expect(empty.statusCode).toBe(400);
    expect(errorOf(empty).code).toBe('validation_error');

    const ok = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: 'correct horse battery staple' },
    });
    expect(ok.statusCode).toBe(200);
    expect(json<SessionResponse>(ok)).toEqual({ authenticated: true, authRequired: true, user: 'admin' });
    const cookie = ok.cookies.find((c) => c.name === SESSION_COOKIE)!;
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/', maxAge: 7 * 24 * 3600 });
    expect(cookie.secure).toBeFalsy();

    const headers = { cookie: `${SESSION_COOKIE}=${cookie.value}` };
    const list = await app.inject({ method: 'GET', url: '/api/generations', headers });
    expect(list.statusCode).toBe(200);
    const session = await app.inject({ method: 'GET', url: '/api/auth/session', headers });
    expect(json<SessionResponse>(session)).toEqual({ authenticated: true, authRequired: true, user: 'admin' });
  });

  it('marks the cookie Secure behind an https proxy', async () => {
    const { app } = await harness();
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'x-forwarded-proto': 'https' },
      payload: { password: 'correct horse battery staple' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.cookies.find((c) => c.name === SESSION_COOKIE)?.secure).toBe(true);
  });

  it('rejects tampered, foreign and expired session cookies', async () => {
    const { app } = await harness();
    const now = Math.floor(Date.now() / 1000);
    const valid = signSession({ sub: 'admin', iat: now, exp: now + 60 }, TEST_SESSION_SECRET);
    const cases = [
      `${valid.slice(0, -2)}xx`,
      signSession({ sub: 'admin', iat: now, exp: now + 60 }, 'another-secret-another-secret-another-secret'),
      signSession({ sub: 'admin', iat: now - 120, exp: now - 60 }, TEST_SESSION_SECRET),
      'garbage',
    ];
    for (const token of cases) {
      const res = await app.inject({
        method: 'GET',
        url: '/api/generations',
        headers: { cookie: `omni_session=${token}` },
      });
      expect(res.statusCode, token).toBe(401);
    }
    const ok = await app.inject({
      method: 'GET',
      url: '/api/generations',
      headers: { cookie: `omni_session=${valid}` },
    });
    expect(ok.statusCode).toBe(200);
  });

  it('accepts bearer tokens and rejects unknown ones', async () => {
    const { app } = await harness();
    expect((await app.inject({ method: 'GET', url: '/api/generations', headers: bearer })).statusCode).toBe(200);
    const bad = await app.inject({
      method: 'GET',
      url: '/api/generations',
      headers: { authorization: 'Bearer not-a-valid-token' },
    });
    expect(bad.statusCode).toBe(401);
  });

  it('logs out by clearing the cookie', async () => {
    const { app } = await harness();
    const cookie = await login(app);
    const res = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
    expect(res.statusCode).toBe(204);
    const cleared = res.cookies.find((c) => c.name === SESSION_COOKIE)!;
    expect(cleared.value).toBe('');
    expect(cleared.expires?.getTime() ?? 0).toBeLessThanOrEqual(Date.now());
  });

  it('password login is refused when only API tokens are configured', async () => {
    const { app } = await harness({ APP_PASSWORD: undefined });
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'anything' } });
    expect(res.statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/generations', headers: bearer })).statusCode).toBe(200);
  });

  it('is skipped entirely when disabled', async () => {
    const { app } = await harness({ AUTH_DISABLED: 'true' });
    expect((await app.inject({ method: 'GET', url: '/api/generations' })).statusCode).toBe(200);
    const session = await app.inject({ method: 'GET', url: '/api/auth/session' });
    expect(json<SessionResponse>(session)).toEqual({ authenticated: true, authRequired: false, user: null });
    const config = await app.inject({ method: 'GET', url: '/api/config' });
    expect(json<AppConfigResponse>(config).authRequired).toBe(false);
  });

  it('is disabled outside production when no password or token is set', async () => {
    const { app } = await harness({ APP_PASSWORD: undefined, API_TOKENS: undefined });
    expect((await app.inject({ method: 'GET', url: '/api/generations' })).statusCode).toBe(200);
  });

  it('requires auth on percent-encoded API paths (the router decodes them)', async () => {
    const h = await harness();
    for (const url of ['/%61pi/generations', '/ap%69/config', `/%61pi/generations/${randomUUID()}/video`]) {
      const res = await h.app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(401);
      expect(errorOf(res).code).toBe('unauthorized');
    }
    const req = createRequest();
    const created = await h.app.inject({
      method: 'POST',
      url: '/%61pi/generations',
      headers: req.headers,
      payload: req.payload,
    });
    expect(created.statusCode).toBe(401);
    expect(await h.ctx.repo.countActive()).toBe(0);
    expect(h.storage.objects.size).toBe(0);

    // The auth routes stay public (also encoded); unknown routes under /api/auth/ do not.
    expect((await h.app.inject({ method: 'GET', url: '/%61pi/auth/session' })).statusCode).toBe(200);
    expect((await h.app.inject({ method: 'GET', url: '/api/auth/nope' })).statusCode).toBe(401);

    const ok = await h.app.inject({ method: 'GET', url: '/%61pi/config', headers: bearer });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['cache-control']).toBe('no-store');
  });

  it('rate limits percent-encoded API paths like plain ones', async () => {
    const { app } = await harness({ RATE_LIMIT_PER_MINUTE: '2' });
    for (let i = 0; i < 2; i++) {
      expect((await app.inject({ method: 'GET', url: '/%61pi/config', headers: bearer })).statusCode).toBe(200);
    }
    const limited = await app.inject({ method: 'GET', url: '/%61pi/config', headers: bearer });
    expect(limited.statusCode).toBe(429);
  });

  it('blocks bearer-token guessing after repeated failures', async () => {
    const { app } = await harness();
    const guess = (token: string) =>
      app.inject({ method: 'GET', url: '/api/generations', headers: { authorization: `Bearer ${token}` } });
    for (let i = 0; i < TOKEN_ATTEMPTS_PER_MINUTE; i++) {
      expect((await guess(`wrong-${i}`)).statusCode).toBe(401);
    }
    const blocked = await guess('wrong-again');
    expect(blocked.statusCode).toBe(429);
    expect(errorOf(blocked).code).toBe('rate_limited');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    // While blocked, even the right token is refused, so a correct guess cannot be recognized.
    expect((await guess(TEST_TOKEN)).statusCode).toBe(429);
    // Cookie sessions are not affected.
    const cookie = await login(app);
    expect((await app.inject({ method: 'GET', url: '/api/generations', headers: { cookie } })).statusCode).toBe(200);
  });

  it('does not count valid tokens as failures', async () => {
    const { app } = await harness();
    for (let i = 0; i < TOKEN_ATTEMPTS_PER_MINUTE + 5; i++) {
      expect((await app.inject({ method: 'GET', url: '/api/config', headers: bearer })).statusCode).toBe(200);
    }
  });

  it('rate limits login attempts to 10 per minute', async () => {
    const { app } = await harness();
    for (let i = 0; i < 10; i++) {
      const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'wrong' } });
      expect(res.statusCode).toBe(401);
    }
    const limited = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'wrong' } });
    expect(limited.statusCode).toBe(429);
    expect(errorOf(limited).code).toBe('rate_limited');
    expect(limited.headers['retry-after']).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Origin check, headers, errors
// ---------------------------------------------------------------------------

describe('origin check and security headers', () => {
  const estimate = { settings: { resolution: '720p' } };

  it('rejects mutating requests from another origin', async () => {
    const { app } = await harness();
    const cookie = await login(app);
    const foreign = await app.inject({
      method: 'POST',
      url: '/api/estimate',
      headers: { cookie, origin: 'https://evil.example' },
      payload: estimate,
    });
    expect(foreign.statusCode).toBe(403);
    expect(errorOf(foreign).code).toBe('forbidden_origin');

    const same = await app.inject({
      method: 'POST',
      url: '/api/estimate',
      headers: { cookie, origin: 'http://localhost' },
      payload: estimate,
    });
    expect(same.statusCode).toBe(200);

    const noOrigin = await app.inject({ method: 'POST', url: '/api/estimate', headers: { cookie }, payload: estimate });
    expect(noOrigin.statusCode).toBe(200);

    const read = await app.inject({
      method: 'GET',
      url: '/api/config',
      headers: { cookie, origin: 'https://evil.example' },
    });
    expect(read.statusCode).toBe(200);

    const loginCsrf = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: 'https://evil.example' },
      payload: { password: 'correct horse battery staple' },
    });
    expect(loginCsrf.statusCode).toBe(403);
  });

  it('checks the origin on percent-encoded API paths too', async () => {
    const { app } = await harness();
    const cookie = await login(app);
    const foreign = await app.inject({
      method: 'POST',
      url: '/%61pi/estimate',
      headers: { cookie, origin: 'https://evil.example' },
      payload: estimate,
    });
    expect(foreign.statusCode).toBe(403);
    expect(errorOf(foreign).code).toBe('forbidden_origin');
  });

  it('exempts bearer-token requests', async () => {
    const { app } = await harness();
    const res = await app.inject({
      method: 'POST',
      url: '/api/estimate',
      headers: { ...bearer, origin: 'https://evil.example' },
      payload: estimate,
    });
    expect(res.statusCode).toBe(200);
  });

  it('uses PUBLIC_ORIGIN when configured', async () => {
    const { app } = await harness({ PUBLIC_ORIGIN: 'https://ugc.example.com/' });
    const cookie = await login(app);
    const ok = await app.inject({
      method: 'POST',
      url: '/api/estimate',
      headers: { cookie, origin: 'https://ugc.example.com' },
      payload: estimate,
    });
    expect(ok.statusCode).toBe(200);
    const local = await app.inject({
      method: 'POST',
      url: '/api/estimate',
      headers: { cookie, origin: 'http://localhost' },
      payload: estimate,
    });
    expect(local.statusCode).toBe(403);
  });

  it('sets security headers, request ids and no-store on API responses', async () => {
    const { app } = await harness();
    const res = await app.inject({
      method: 'GET',
      url: '/api/config',
      headers: { ...bearer, 'x-request-id': 'trace-12345678' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-request-id']).toBe('trace-12345678');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("media-src 'self' blob:");

    const unauthorized = await app.inject({ method: 'GET', url: '/api/generations' });
    expect(unauthorized.headers['x-content-type-options']).toBe('nosniff');
  });

  it('hides internal errors and secrets behind internal_error', async () => {
    const h = await harness();
    h.ctx.repo.countActive = async () => {
      throw new Error('connection to db failed with key AIzaSyA1234567890abcdefghijklmnopqrstu');
    };
    const res = await postGeneration(h.app);
    expect(res.statusCode).toBe(500);
    const error = errorOf(res);
    expect(error.code).toBe('internal_error');
    expect(res.body).not.toContain('AIza');
    expect(res.body).not.toContain('connection');
    expect(error.details).toMatchObject({ requestId: expect.any(String) });
  });

  it('returns JSON 404 for unknown API routes (401 before that when unauthenticated)', async () => {
    const { app } = await harness();
    const res = await app.inject({ method: 'GET', url: '/api/does-not-exist', headers: bearer });
    expect(res.statusCode).toBe(404);
    expect(errorOf(res).code).toBe('not_found');
    const anonymous = await app.inject({ method: 'DELETE', url: '/api/does-not-exist' });
    expect(anonymous.statusCode).toBe(401);
  });

  it('applies the global per-minute API rate limit but not to health probes', async () => {
    const { app } = await harness({ RATE_LIMIT_PER_MINUTE: '3' });
    for (let i = 0; i < 3; i++) {
      expect((await app.inject({ method: 'GET', url: '/api/config', headers: bearer })).statusCode).toBe(200);
    }
    const limited = await app.inject({ method: 'GET', url: '/api/config', headers: bearer });
    expect(limited.statusCode).toBe(429);
    expect(errorOf(limited).code).toBe('rate_limited');
    for (let i = 0; i < 5; i++) {
      expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    }
  });
});

// ---------------------------------------------------------------------------
// Config, plan, estimate
// ---------------------------------------------------------------------------

describe('config, plan and estimate', () => {
  it('GET /api/config returns the public configuration', async () => {
    const { app } = await harness({ DAILY_BUDGET_USD: '25' });
    await createGeneration(app);
    const res = await app.inject({ method: 'GET', url: '/api/config', headers: bearer });
    expect(res.statusCode).toBe(200);
    const body = json<AppConfigResponse>(res);
    expect(body.mock).toBe(true);
    expect(body.models).toEqual({ video: 'gemini-omni-1.1-flash', splitter: expect.any(String) });
    expect(Object.keys(body.pricing).sort()).toEqual(
      [
        'extensionBilling',
        'inputUsdPerMillionTokens',
        'source',
        'splitterUsdPerCallEstimate',
        'textOutputUsdPerMillionTokens',
        'videoOutputUsdPerMillionTokens',
        'videoOutputUsdPerSecond',
      ].sort(),
    );
    expect(body.pricing.videoOutputUsdPerSecond['720p']).toBeGreaterThan(0);
    expect(body.defaults).toEqual(DEFAULT_SETTINGS);
    expect(body.limits.imageMaxBytes).toBe(LIMITS.imageMaxBytes);
    expect(body.resolutions).toEqual(['360p', '720p', '1080p', '4k']);
    expect(body.styles).toEqual(['ugc', 'scientific']);
    expect(body.budget.dailyLimitUsd).toBe(25);
    expect(body.budget.spentTodayUsd).toBe(0);
    expect(body.budget.reservedUsd).toBeGreaterThan(0);
    expect(body.authRequired).toBe(true);
  });

  it('POST /api/plan splits the script and records the call in the ledger', async () => {
    const h = await harness();
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/plan',
      headers: bearer,
      payload: { script: SAMPLE_SCRIPT, settings: SAMPLE_SETTINGS },
    });
    expect(res.statusCode).toBe(200);
    const plan = json<ScriptPlan>(res);
    expect(plan.source).toBe('llm');
    expect(plan.segments).toHaveLength(2);
    expect(plan.segments[1].prompt).toContain('part 2');
    const { rows } = await testDb.db.query(
      `SELECT kind, model, generation_id, cost_usd FROM api_calls WHERE kind = 'split'`,
    );
    expect(rows).toEqual([{ kind: 'split', model: 'fake-splitter', generation_id: null, cost_usd: 0.0021 }]);

    h.planner.model = null;
    const fallback = await h.app.inject({
      method: 'POST',
      url: '/api/plan',
      headers: bearer,
      payload: { script: SAMPLE_SCRIPT, settings: SAMPLE_SETTINGS },
    });
    expect(fallback.statusCode).toBe(200);
    const count = await testDb.db.query(`SELECT COUNT(*)::int AS n FROM api_calls`);
    expect(count.rows[0].n).toBe(1);
  });

  it('POST /api/plan returns 502 splitter_failed when the planner throws, 400 on bad input', async () => {
    const h = await harness();
    h.planner.failSplit = true;
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/plan',
      headers: bearer,
      payload: { script: SAMPLE_SCRIPT, settings: SAMPLE_SETTINGS },
    });
    expect(res.statusCode).toBe(502);
    expect(errorOf(res).code).toBe('splitter_failed');

    const short = await h.app.inject({ method: 'POST', url: '/api/plan', headers: bearer, payload: { script: 'hi' } });
    expect(short.statusCode).toBe(400);
    const error = errorOf(short);
    expect(error.code).toBe('validation_error');
    expect(error.details).toEqual([expect.objectContaining({ path: ['script'] })]);
  });

  it('POST /api/plan has its own hourly limit', async () => {
    const { app } = await harness({ CREATE_RATE_LIMIT_PER_HOUR: '1' });
    const body = { script: SAMPLE_SCRIPT, settings: SAMPLE_SETTINGS };
    expect((await app.inject({ method: 'POST', url: '/api/plan', headers: bearer, payload: body })).statusCode).toBe(
      200,
    );
    const limited = await app.inject({ method: 'POST', url: '/api/plan', headers: bearer, payload: body });
    expect(limited.statusCode).toBe(429);
    expect(errorOf(limited).code).toBe('rate_limited');
  });

  it('POST /api/estimate prices full and part-2 generations', async () => {
    const { app } = await harness();
    const full = await app.inject({
      method: 'POST',
      url: '/api/estimate',
      headers: bearer,
      payload: { settings: { resolution: '720p' } },
    });
    expect(full.statusCode).toBe(200);
    const fullCost = json<CostBreakdown>(full);
    expect(fullCost).toMatchObject({ currency: 'USD', basis: 'estimate' });
    expect(fullCost.items.some((i) => i.label.startsWith('Script split'))).toBe(true);
    expect(fullCost.items.some((i) => i.label.startsWith('Part 1'))).toBe(true);

    const part2 = json<CostBreakdown>(
      await app.inject({
        method: 'POST',
        url: '/api/estimate',
        headers: bearer,
        payload: { settings: { resolution: '720p' }, mode: 'part2' },
      }),
    );
    expect(part2.items.some((i) => i.label.startsWith('Part 1') || i.label.startsWith('Script'))).toBe(false);
    expect(part2.totalUsd).toBeLessThan(fullCost.totalUsd);

    const bad = await app.inject({
      method: 'POST',
      url: '/api/estimate',
      headers: bearer,
      payload: { settings: { resolution: '8k' } },
    });
    expect(bad.statusCode).toBe(400);
    expect(errorOf(bad).details).toEqual([expect.objectContaining({ path: ['settings', 'resolution'] })]);
  });
});

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

describe('POST /api/generations', () => {
  it('queues a generation from a script and a PNG', async () => {
    const h = await harness();
    const png = makePng();
    const res = await postGeneration(h.app, undefined, { data: png });
    expect(res.statusCode, res.body).toBe(202);
    const dto = json<GenerationDTO>(res);
    expect(dto).toMatchObject({
      status: 'queued',
      stage: 'queued',
      progress: 0,
      title: 'Okay, so I finally tried the new cold brew kit.',
      script: SAMPLE_SCRIPT,
      settings: SAMPLE_SETTINGS,
      plan: null,
      characterImageUrl: `/api/generations/${dto.id}/character`,
      part1VideoUrl: null,
      videoUrl: null,
      downloadUrl: null,
      thumbnailUrl: null,
      parentId: null,
      regenerationMode: null,
      canCancel: true,
      canRegeneratePart2: false,
      actualCost: null,
      error: null,
    });
    expect(dto.etaSeconds).toBeGreaterThan(0);
    expect(dto.events.map((e) => e.message)).toEqual(['Queued']);
    expect(dto.estimatedCost.items.some((i) => i.label.startsWith('Script split'))).toBe(true);

    const keys = generationKeys(dto.id);
    expect(h.storage.objects.get(keys.characterImage)?.data.equals(png)).toBe(true);
    const row = await h.ctx.repo.get(dto.id);
    expect(row).toMatchObject({ createdBy: 'api-token', characterImageKey: keys.characterImage, maxAttempts: 3 });
    expect(row!.characterImageSha256).toMatch(/^[0-9a-f]{64}$/);

    const got = await h.app.inject({ method: 'GET', url: `/api/generations/${dto.id}`, headers: bearer });
    expect(got.statusCode).toBe(200);
    expect(json<GenerationDTO>(got).id).toBe(dto.id);
  });

  it('records the session subject as creator and accepts a JSON-typed payload part', async () => {
    const h = await harness();
    const cookie = await login(h.app);
    const body = multipart([
      {
        name: 'payload',
        contentType: 'application/json',
        value: JSON.stringify({ script: SAMPLE_SCRIPT, settings: { resolution: '360p' } }),
      },
      { name: 'characterImage', filename: 'me.png', contentType: 'image/png', data: makePng() },
    ]);
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/generations',
      headers: { cookie, ...body.headers },
      payload: body.payload,
    });
    expect(res.statusCode, res.body).toBe(202);
    const dto = json<GenerationDTO>(res);
    expect(dto.settings).toEqual({ ...DEFAULT_SETTINGS, resolution: '360p' });
    expect((await h.ctx.repo.get(dto.id))?.createdBy).toBe('admin');
  });

  it('uses a provided plan, rebuilding its prompts server-side', async () => {
    const h = await harness();
    const plan = samplePlan();
    const dto = await createGeneration(h.app, { script: SAMPLE_SCRIPT, settings: SAMPLE_SETTINGS, plan });
    expect(dto.plan?.source).toBe('user');
    expect(dto.plan?.segments[0].prompt).toBe(
      '[ugc/reference] part 1: Okay, so I finally tried the new cold brew kit. | Holds up the kit | Selfie framing',
    );
    expect(dto.estimatedCost.items.some((i) => i.label.startsWith('Script split'))).toBe(false);
    expect(h.planner.splitCalls).toBe(0);
  });

  it('rejects a plan the planner refuses', async () => {
    const h = await harness();
    const plan = { ...samplePlan(), character: '   ' };
    const res = await postGeneration(h.app, { script: SAMPLE_SCRIPT, settings: SAMPLE_SETTINGS, plan });
    expect(res.statusCode).toBe(400);
    expect(errorOf(res).code).toBe('validation_error');
  });

  it('rejects files that are not JPEG, PNG or WebP (by content, not declared type)', async () => {
    const { app } = await harness();
    const text = await postGeneration(app, undefined, {
      data: Buffer.from('just some text, not an image'),
      contentType: 'text/plain',
      filename: 'notes.txt',
    });
    expect(text.statusCode).toBe(415);
    expect(errorOf(text).code).toBe('unsupported_media_type');

    const disguised = await postGeneration(app, undefined, {
      data: Buffer.from('%PDF-1.7\n% fake pdf disguised as png\n'.repeat(20)),
      contentType: 'image/png',
      filename: 'selfie.png',
    });
    expect(disguised.statusCode).toBe(415);
    expect(errorOf(disguised).message).toContain('PDF');

    const gif = await postGeneration(app, undefined, {
      data: Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(64)]),
      contentType: 'image/gif',
      filename: 'a.gif',
    });
    expect(gif.statusCode).toBe(415);
  });

  it('rejects images larger than the limit with 413', async () => {
    const { app } = await harness();
    const png = makePng();
    const big = Buffer.concat([png, Buffer.alloc(LIMITS.imageMaxBytes + 1 - png.length + 10)]);
    const res = await postGeneration(app, undefined, { data: big });
    expect(res.statusCode).toBe(413);
    expect(errorOf(res).code).toBe('payload_too_large');
  });

  it('rejects images the decoder cannot read', async () => {
    const h = await harness();
    h.media.failNormalize = 'invalid_media';
    const bad = await postGeneration(h.app);
    expect(bad.statusCode).toBe(415);
    h.media.failNormalize = 'image_too_large';
    const huge = await postGeneration(h.app);
    expect(huge.statusCode).toBe(413);
    expect(await h.ctx.repo.countActive()).toBe(0);
    expect(h.storage.objects.size).toBe(0);
  });

  it('validates the payload', async () => {
    const { app } = await harness();
    const invalidSettings = await postGeneration(app, { script: SAMPLE_SCRIPT, settings: { resolution: '8k' } });
    expect(invalidSettings.statusCode).toBe(400);
    const error = errorOf(invalidSettings);
    expect(error.code).toBe('validation_error');
    expect(error.details).toEqual([expect.objectContaining({ path: ['settings', 'resolution'] })]);

    const tooLong = await postGeneration(app, { script: 'x'.repeat(LIMITS.scriptMaxChars + 1) });
    expect(tooLong.statusCode).toBe(400);

    const notJson = multipart([
      { name: 'payload', value: '{not json' },
      { name: 'characterImage', filename: 'a.png', contentType: 'image/png', data: makePng() },
    ]);
    const badJson = await app.inject({
      method: 'POST',
      url: '/api/generations',
      headers: { ...bearer, ...notJson.headers },
      payload: notJson.payload,
    });
    expect(badJson.statusCode).toBe(400);

    const noImage = multipart([{ name: 'payload', value: JSON.stringify({ script: SAMPLE_SCRIPT }) }]);
    const missing = await app.inject({
      method: 'POST',
      url: '/api/generations',
      headers: { ...bearer, ...noImage.headers },
      payload: noImage.payload,
    });
    expect(missing.statusCode).toBe(400);
    expect(errorOf(missing).message).toContain('characterImage');

    const noPayload = multipart([
      { name: 'characterImage', filename: 'a.png', contentType: 'image/png', data: makePng() },
    ]);
    const missingPayload = await app.inject({
      method: 'POST',
      url: '/api/generations',
      headers: { ...bearer, ...noPayload.headers },
      payload: noPayload.payload,
    });
    expect(missingPayload.statusCode).toBe(400);

    const jsonBody = await app.inject({
      method: 'POST',
      url: '/api/generations',
      headers: bearer,
      payload: { script: SAMPLE_SCRIPT },
    });
    expect(jsonBody.statusCode).toBe(415);
  });

  it('rejects truncated and malformed multipart bodies with 400 instead of hanging', async () => {
    const h = await harness();
    const full = createRequest(undefined, { data: Buffer.concat([makePng(), Buffer.alloc(5000, 7)]) });
    const cases: { name: string; headers: Record<string, string>; payload: Buffer | string }[] = [
      {
        name: 'ends inside the file',
        headers: full.headers,
        payload: full.payload.subarray(0, full.payload.length - 2000),
      },
      { name: 'ends inside the payload field', headers: full.headers, payload: full.payload.subarray(0, 150) },
      { name: 'no boundary', headers: { 'content-type': 'multipart/form-data' }, payload: 'hello' },
      { name: 'no parts', headers: { 'content-type': 'multipart/form-data; boundary=xyz' }, payload: 'no parts here' },
    ];
    for (const c of cases) {
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/generations',
        headers: { ...bearer, ...c.headers },
        payload: c.payload,
      });
      expect(res.statusCode, c.name).toBe(400);
      expect(errorOf(res).code, c.name).toBe('validation_error');
    }
    expect(await h.ctx.repo.countActive()).toBe(0);
    expect(h.storage.objects.size).toBe(0);
  }, 15_000);

  it('removes the temporary upload when the client disconnects mid-upload', async () => {
    const h = await harness();
    const uploads = async () => (await readdir(tmpdir())).filter((name) => name.startsWith('omni-upload-')).length;
    const before = await uploads();
    const address = await h.app.listen({ port: 0, host: '127.0.0.1' });
    const body = createRequest(undefined, { data: Buffer.concat([makePng(), Buffer.alloc(512 * 1024, 7)]) });
    const socket = connect(Number(new URL(address).port), '127.0.0.1');
    await once(socket, 'connect');
    socket.write(
      `POST /api/generations HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${TEST_TOKEN}\r\n` +
        `Content-Type: ${body.headers['content-type']}\r\nContent-Length: ${body.payload.length}\r\n\r\n`,
    );
    socket.write(body.payload.subarray(0, 64 * 1024));
    await vi.waitFor(async () => expect(await uploads()).toBeGreaterThan(before), { timeout: 5000 });
    socket.destroy();
    await vi.waitFor(async () => expect(await uploads()).toBe(before), { timeout: 5000 });
    expect(await h.ctx.repo.countActive()).toBe(0);
    expect(h.storage.objects.size).toBe(0);
  });

  it('drops lone surrogates and NUL before they reach jsonb columns', async () => {
    const h = await harness();
    const plan = { ...samplePlan(), character: 'Person \udc00in the image', warnings: ['check\u0000 pacing \ud800'] };
    const dto = await createGeneration(h.app, {
      script: 'Hello \ud83d\ude00 there\ud800, this is a test script.',
      settings: { ...SAMPLE_SETTINGS, voiceHint: 'calm \ud800voice', extraDirections: 'x\udfffy' },
      plan,
    });
    expect(dto.script).toBe('Hello \ud83d\ude00 there, this is a test script.');
    expect(dto.settings).toMatchObject({ voiceHint: 'calm voice', extraDirections: 'xy' });
    expect(dto.plan?.character).toBe('Person in the image');
    expect(dto.plan?.warnings).toEqual(['check pacing ']);

    const regen = await h.app.inject({
      method: 'POST',
      url: `/api/generations/${dto.id}/regenerate`,
      headers: { ...bearer, 'content-type': 'application/json' },
      payload: '{"mode":"full","settings":{"voiceHint":"deep\\ud800 voice"}}',
    });
    expect(regen.statusCode, regen.body).toBe(202);
    expect(json<GenerationDTO>(regen).settings.voiceHint).toBe('deep voice');
  });

  it('strips control characters from text', async () => {
    const { app } = await harness();
    const dto = await createGeneration(app, {
      script: `Hello\u0000 there, this is a test script.\u0007`,
      settings: { ...SAMPLE_SETTINGS, voiceHint: 'calm\u0000 voice' },
    });
    expect(dto.script).toBe('Hello there, this is a test script.');
    expect(dto.settings.voiceHint).toBe('calm voice');
  });

  it('enforces the daily budget with 402 budget_exceeded', async () => {
    const h = await harness({ DAILY_BUDGET_USD: '0.5' });
    const res = await postGeneration(h.app);
    expect(res.statusCode).toBe(402);
    const error = errorOf(res);
    expect(error.code).toBe('budget_exceeded');
    expect(error.message).toContain('$0.50');
    expect(error.details).toMatchObject({ dailyLimitUsd: 0.5, remainingUsd: 0.5 });

    // Recorded spend counts too.
    const h2 = await harness({ DAILY_BUDGET_USD: '10' });
    await testDb.db.query(
      `INSERT INTO api_calls (kind, model, status, cost_usd, cost_basis) VALUES ('part1', 'm', 'completed', 9, 'actual')`,
    );
    const res2 = await postGeneration(h2.app);
    expect(res2.statusCode).toBe(402);
    expect(errorOf(res2).message).toContain('only $1.00');
    await h.close();
  });

  it('rejects new jobs with 429 queue_full when the queue is full', async () => {
    const { app } = await harness({ MAX_QUEUED_JOBS: '1' });
    const first = await createGeneration(app);
    const second = await postGeneration(app);
    expect(second.statusCode).toBe(429);
    expect(errorOf(second).code).toBe('queue_full');
    await app.inject({ method: 'POST', url: `/api/generations/${first.id}/cancel`, headers: bearer });
    expect((await postGeneration(app)).statusCode).toBe(202);
  });

  it('admits no more than MAX_QUEUED_JOBS jobs from concurrent requests', async () => {
    const h = await harness({ MAX_QUEUED_JOBS: '3' });
    const source = await createGeneration(h.app);
    await completeGeneration(h, source.id);
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        h.app.inject({
          method: 'POST',
          url: `/api/generations/${source.id}/regenerate`,
          headers: bearer,
          payload: { mode: 'part2' },
        }),
      ),
    );
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes).toEqual([202, 202, 202, 429, 429, 429, 429, 429]);
    expect(results.filter((r) => r.statusCode === 429).every((r) => errorOf(r).code === 'queue_full')).toBe(true);
    expect(await h.ctx.repo.countActive()).toBe(3);
  });

  it('never overshoots the daily budget with concurrent requests', async () => {
    const part2 = estimateCost(loadConfig(testEnv()).pricing, { resolution: '720p', mode: 'part2', needsSplit: false });
    // Room for exactly two part-2 regenerations once the source has finished.
    const h = await harness({ DAILY_BUDGET_USD: String(Math.round(part2.totalUsd * 2.5 * 100) / 100) });
    const source = await createGeneration(h.app);
    await completeGeneration(h, source.id);
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        h.app.inject({
          method: 'POST',
          url: `/api/generations/${source.id}/regenerate`,
          headers: bearer,
          payload: { mode: 'part2' },
        }),
      ),
    );
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes).toEqual([202, 202, 402, 402, 402, 402]);
    expect(await h.ctx.repo.countActive()).toBe(2);
  });

  it('applies the hourly creation limit', async () => {
    const { app } = await harness({ CREATE_RATE_LIMIT_PER_HOUR: '2' });
    const first = await createGeneration(app);
    await createGeneration(app);
    const limited = await postGeneration(app);
    expect(limited.statusCode).toBe(429);
    expect(errorOf(limited).code).toBe('rate_limited');
    // Regeneration shares the same budget.
    const regen = await app.inject({
      method: 'POST',
      url: `/api/generations/${first.id}/regenerate`,
      headers: bearer,
      payload: { mode: 'full' },
    });
    expect(regen.statusCode).toBe(429);
  });
});

// ---------------------------------------------------------------------------
// List / get
// ---------------------------------------------------------------------------

describe('GET /api/generations', () => {
  it('paginates newest first with a cursor and filters by status', async () => {
    const { app } = await harness();
    const a = await createGeneration(app);
    const b = await createGeneration(app);
    const c = await createGeneration(app);

    const page1 = json<GenerationListResponse>(
      await app.inject({ method: 'GET', url: '/api/generations?limit=2', headers: bearer }),
    );
    expect(page1.items.map((i) => i.id)).toEqual([c.id, b.id]);
    expect(page1.nextCursor).toEqual(expect.any(String));
    expect(page1.items[0]).toMatchObject({
      status: 'queued',
      characterImageUrl: `/api/generations/${c.id}/character`,
      thumbnailUrl: null,
      actualCostUsd: null,
      parentId: null,
    });
    expect(page1.items[0]!.estimatedCostUsd).toBeGreaterThan(0);

    const page2 = json<GenerationListResponse>(
      await app.inject({
        method: 'GET',
        url: `/api/generations?limit=2&cursor=${encodeURIComponent(page1.nextCursor!)}`,
        headers: bearer,
      }),
    );
    expect(page2.items.map((i) => i.id)).toEqual([a.id]);
    expect(page2.nextCursor).toBeNull();

    await app.inject({ method: 'POST', url: `/api/generations/${b.id}/cancel`, headers: bearer });
    const canceled = json<GenerationListResponse>(
      await app.inject({ method: 'GET', url: '/api/generations?status=canceled', headers: bearer }),
    );
    expect(canceled.items.map((i) => i.id)).toEqual([b.id]);

    for (const bad of ['limit=51', 'limit=0', 'status=bogus']) {
      const res = await app.inject({ method: 'GET', url: `/api/generations?${bad}`, headers: bearer });
      expect(res.statusCode, bad).toBe(400);
    }
  });

  it('returns 404 for unknown or malformed ids', async () => {
    const { app } = await harness();
    for (const id of [randomUUID(), 'not-a-uuid']) {
      const res = await app.inject({ method: 'GET', url: `/api/generations/${id}`, headers: bearer });
      expect(res.statusCode).toBe(404);
      expect(errorOf(res).code).toBe('not_found');
    }
  });

  it('exposes finished media URLs and part-2 regeneration eligibility', async () => {
    const h = await harness();
    const dto = await createGeneration(h.app);
    await completeGeneration(h, dto.id);
    const done = json<GenerationDTO>(
      await h.app.inject({ method: 'GET', url: `/api/generations/${dto.id}`, headers: bearer }),
    );
    expect(done).toMatchObject({
      status: 'succeeded',
      progress: 100,
      etaSeconds: null,
      // Final media URLs carry a version so a re-rendered file (e.g. captions added) is never served from cache.
      videoUrl: expect.stringMatching(new RegExp(`^/api/generations/${dto.id}/video\\?v=\\d+$`)),
      downloadUrl: expect.stringMatching(new RegExp(`^/api/generations/${dto.id}/video\\?v=\\d+&download=1$`)),
      part1VideoUrl: `/api/generations/${dto.id}/part1`,
      thumbnailUrl: expect.stringMatching(new RegExp(`^/api/generations/${dto.id}/thumbnail\\?v=\\d+$`)),
      canRegeneratePart2: true,
      canCancel: false,
    });
  });
});

// ---------------------------------------------------------------------------
// Regenerate
// ---------------------------------------------------------------------------

describe('POST /api/generations/:id/regenerate', () => {
  it('full: creates a new generation reusing the character image', async () => {
    const h = await harness();
    const source = await createGeneration(h.app);
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/generations/${source.id}/regenerate`,
      headers: bearer,
      payload: { mode: 'full' },
    });
    expect(res.statusCode, res.body).toBe(202);
    const regen = json<GenerationDTO>(res);
    expect(regen.id).not.toBe(source.id);
    expect(regen).toMatchObject({
      parentId: source.id,
      regenerationMode: 'full',
      status: 'queued',
      title: source.title,
    });
    const [srcRow, newRow] = await Promise.all([h.ctx.repo.get(source.id), h.ctx.repo.get(regen.id)]);
    expect(newRow!.characterImageKey).toBe(srcRow!.characterImageKey);
    expect(h.storage.objects.size).toBe(1);

    const image = await h.app.inject({ method: 'GET', url: regen.characterImageUrl, headers: bearer });
    expect(image.statusCode).toBe(200);
  });

  it('full: keeps, rebuilds or drops the plan depending on the edits', async () => {
    const h = await harness();
    const source = await createGeneration(h.app);
    await completeGeneration(h, source.id);
    const regen = async (body: object) => {
      const res = await h.app.inject({
        method: 'POST',
        url: `/api/generations/${source.id}/regenerate`,
        headers: bearer,
        payload: { mode: 'full', ...body },
      });
      expect(res.statusCode, res.body).toBe(202);
      return json<GenerationDTO>(res);
    };

    const same = await regen({});
    expect(same.plan).toEqual(samplePlan());

    const resolution = await regen({ settings: { resolution: '1080p' } });
    expect(resolution.settings.resolution).toBe('1080p');
    expect(resolution.plan?.source).toBe('llm');
    expect(resolution.plan?.segments[0].prompt).toContain('[ugc/reference] part 1');
    expect(resolution.estimatedCost.items.some((i) => i.label.startsWith('Script split'))).toBe(false);

    const language = await regen({ settings: { language: 'fr' } });
    expect(language.plan).toBeNull();
    expect(language.settings).toMatchObject({ language: 'fr', resolution: '720p' });

    const script = await regen({ script: 'A brand new script for this character. It has two sentences.' });
    expect(script.plan).toBeNull();
    expect(script.title).toBe('A brand new script for this character.');
    expect(script.estimatedCost.items.some((i) => i.label.startsWith('Script split'))).toBe(true);

    const edited = await regen({ plan: samplePlan() });
    expect(edited.plan?.source).toBe('user');
  });

  it('part2: requires a completed part 1', async () => {
    const h = await harness();
    const source = await createGeneration(h.app);
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/generations/${source.id}/regenerate`,
      headers: bearer,
      payload: { mode: 'part2' },
    });
    expect(res.statusCode).toBe(409);
    expect(errorOf(res).code).toBe('conflict');
  });

  it('part2: reuses part 1 and applies extension edits', async () => {
    const h = await harness();
    const source = await createGeneration(h.app);
    const { keys } = await completeGeneration(h, source.id);
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/generations/${source.id}/regenerate`,
      headers: bearer,
      payload: { mode: 'part2', part2: { dialogue: 'A brand new ending line.' } },
    });
    expect(res.statusCode, res.body).toBe(202);
    const regen = json<GenerationDTO>(res);
    expect(regen).toMatchObject({
      parentId: source.id,
      regenerationMode: 'part2',
      part1VideoUrl: `/api/generations/${regen.id}/part1`,
      videoUrl: null,
    });
    expect(regen.plan?.source).toBe('user');
    expect(regen.plan?.segments[0].dialogue).toBe(samplePlan().segments[0].dialogue);
    expect(regen.plan?.segments[1].dialogue).toBe('A brand new ending line.');
    expect(regen.plan?.segments[1].prompt).toContain('A brand new ending line.');
    expect(regen.estimatedCost.items.every((i) => i.label.startsWith('Part 2'))).toBe(true);

    const row = await h.ctx.repo.get(regen.id);
    expect(row).toMatchObject({
      part1VideoKey: keys.part1,
      part1InteractionId: `int-${source.id.slice(0, 8)}`,
      part1Status: 'completed',
      part2VideoKey: null,
    });
    const part1 = await h.app.inject({ method: 'GET', url: regen.part1VideoUrl!, headers: bearer });
    expect(part1.statusCode).toBe(200);
    expect(part1.rawPayload.length).toBe(500);

    const noEdits = await h.app.inject({
      method: 'POST',
      url: `/api/generations/${source.id}/regenerate`,
      headers: bearer,
      payload: { mode: 'part2' },
    });
    expect(json<GenerationDTO>(noEdits).plan).toEqual(samplePlan());
  });

  it('part2: refuses while the source is running and when part 1 is too old', async () => {
    const h = await harness();
    const source = await createGeneration(h.app);
    await completeGeneration(h, source.id);
    await h.ctx.repo.update(source.id, { status: 'running', stage: 'extending_part2' });
    const running = await h.app.inject({
      method: 'POST',
      url: `/api/generations/${source.id}/regenerate`,
      headers: bearer,
      payload: { mode: 'part2' },
    });
    expect(running.statusCode).toBe(409);

    await h.ctx.repo.update(source.id, { status: 'failed', stage: 'failed' });
    await testDb.db.query(`UPDATE generations SET created_at = now() - interval '60 days' WHERE id = $1`, [source.id]);
    const old = await h.app.inject({
      method: 'POST',
      url: `/api/generations/${source.id}/regenerate`,
      headers: bearer,
      payload: { mode: 'part2' },
    });
    expect(old.statusCode).toBe(409);
    expect(errorOf(old).message).toContain('55 days');
    const dto = json<GenerationDTO>(
      await h.app.inject({ method: 'GET', url: `/api/generations/${source.id}`, headers: bearer }),
    );
    expect(dto.canRegeneratePart2).toBe(false);
  });

  it('part2: dates chained regenerations by the original part 1 interaction', async () => {
    const h = await harness();
    const source = await createGeneration(h.app);
    await completeGeneration(h, source.id);
    const child = json<GenerationDTO>(
      await h.app.inject({
        method: 'POST',
        url: `/api/generations/${source.id}/regenerate`,
        headers: bearer,
        payload: { mode: 'part2' },
      }),
    );
    await h.ctx.repo.update(child.id, { status: 'succeeded', stage: 'completed' });
    // The part 1 interaction was created 60 days ago (ledger), although the child row is new.
    await testDb.db.query(
      `INSERT INTO api_calls (generation_id, kind, model, interaction_id, status, cost_usd, created_at)
       VALUES ($1, 'part1', 'm', $2, 'completed', 1, now() - interval '60 days')`,
      [source.id, `int-${source.id.slice(0, 8)}`],
    );
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/generations/${child.id}/regenerate`,
      headers: bearer,
      payload: { mode: 'part2' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('returns 404 and admits nothing when the source is deleted while the request is in flight', async () => {
    const h = await harness();
    const source = await createGeneration(h.app);
    await completeGeneration(h, source.id);
    const get = h.ctx.repo.get.bind(h.ctx.repo);
    h.ctx.repo.get = async (id: string) => {
      const found = await get(id);
      // Simulates a DELETE that commits right after the regenerate request read its source.
      if (found && id === source.id) await testDb.db.query('DELETE FROM generations WHERE id = $1', [id]);
      return found;
    };
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/generations/${source.id}/regenerate`,
      headers: bearer,
      payload: { mode: 'part2' },
    });
    expect(res.statusCode).toBe(404);
    expect(errorOf(res).code).toBe('not_found');
    const { rows } = await testDb.db.query('SELECT COUNT(*)::int AS n FROM generations');
    expect(rows[0].n).toBe(0);
  });

  it('validates the body and the id', async () => {
    const h = await harness();
    const source = await createGeneration(h.app);
    const bad = await h.app.inject({
      method: 'POST',
      url: `/api/generations/${source.id}/regenerate`,
      headers: bearer,
      payload: { mode: 'everything' },
    });
    expect(bad.statusCode).toBe(400);
    const missing = await h.app.inject({
      method: 'POST',
      url: `/api/generations/${randomUUID()}/regenerate`,
      headers: bearer,
      payload: { mode: 'full' },
    });
    expect(missing.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Cancel / delete
// ---------------------------------------------------------------------------

describe('cancel and delete', () => {
  it('cancels a queued job immediately and refuses to cancel twice', async () => {
    const { app } = await harness();
    const dto = await createGeneration(app);
    const res = await app.inject({ method: 'POST', url: `/api/generations/${dto.id}/cancel`, headers: bearer });
    expect(res.statusCode).toBe(200);
    const canceled = json<GenerationDTO>(res);
    expect(canceled).toMatchObject({ status: 'canceled', stage: 'canceled', canCancel: false });
    expect(canceled.events.map((e) => e.message)).toContain('Canceled while waiting in the queue');

    const again = await app.inject({ method: 'POST', url: `/api/generations/${dto.id}/cancel`, headers: bearer });
    expect(again.statusCode).toBe(409);
    expect(errorOf(again)).toMatchObject({ code: 'conflict', message: 'This generation has already been canceled.' });
  });

  it('returns 409 when the job finishes while the cancel request is in flight', async () => {
    const h = await harness();
    const dto = await createGeneration(h.app);
    const requestCancel = h.ctx.repo.requestCancel.bind(h.ctx.repo);
    h.ctx.repo.requestCancel = async (id: string) => {
      await h.ctx.repo.update(id, { status: 'succeeded', stage: 'completed', progress: 100 });
      return requestCancel(id);
    };
    const res = await h.app.inject({ method: 'POST', url: `/api/generations/${dto.id}/cancel`, headers: bearer });
    expect(res.statusCode).toBe(409);
    expect(errorOf(res).message).toContain('already finished');
    const events = await h.ctx.repo.listEvents(dto.id);
    expect(events.map((e) => e.message)).toEqual(['Queued']);
  });

  it('flags a running job for cancellation (with an empty JSON body)', async () => {
    const h = await harness();
    const dto = await createGeneration(h.app);
    await h.ctx.repo.update(dto.id, { status: 'running', stage: 'generating_part1', stageStartedAt: new Date() });
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/generations/${dto.id}/cancel`,
      headers: { ...bearer, 'content-type': 'application/json' },
      payload: '',
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = json<GenerationDTO>(res);
    expect(body).toMatchObject({ status: 'running', canCancel: false });
    expect((await h.ctx.repo.get(dto.id))?.cancelRequested).toBe(true);
  });

  it('refuses to delete an active job, then deletes the row and its files', async () => {
    const h = await harness();
    const dto = await createGeneration(h.app);
    const active = await h.app.inject({ method: 'DELETE', url: `/api/generations/${dto.id}`, headers: bearer });
    expect(active.statusCode).toBe(409);

    await completeGeneration(h, dto.id);
    await h.storage.putBuffer(`${generationKeys(dto.id).prefix}leftover.tmp`, Buffer.from('x'), 'text/plain');
    const res = await h.app.inject({ method: 'DELETE', url: `/api/generations/${dto.id}`, headers: bearer });
    expect(res.statusCode).toBe(204);
    expect(h.storage.objects.size).toBe(0);
    const gone = await h.app.inject({ method: 'GET', url: `/api/generations/${dto.id}`, headers: bearer });
    expect(gone.statusCode).toBe(404);
  });

  it('keeps files still used by other generations', async () => {
    const h = await harness();
    const source = await createGeneration(h.app);
    const { keys } = await completeGeneration(h, source.id);
    const child = json<GenerationDTO>(
      await h.app.inject({
        method: 'POST',
        url: `/api/generations/${source.id}/regenerate`,
        headers: bearer,
        payload: { mode: 'part2' },
      }),
    );
    await h.app.inject({ method: 'POST', url: `/api/generations/${child.id}/cancel`, headers: bearer });

    const res = await h.app.inject({ method: 'DELETE', url: `/api/generations/${source.id}`, headers: bearer });
    expect(res.statusCode).toBe(204);
    expect(h.storage.has(keys.characterImage)).toBe(true);
    expect(h.storage.has(keys.part1)).toBe(true);
    expect(h.storage.has(keys.final)).toBe(false);
    expect(h.storage.has(keys.thumbnail)).toBe(false);
    const childDto = json<GenerationDTO>(
      await h.app.inject({ method: 'GET', url: `/api/generations/${child.id}`, headers: bearer }),
    );
    expect(childDto.parentId).toBeNull();

    expect(
      (await h.app.inject({ method: 'DELETE', url: `/api/generations/${child.id}`, headers: bearer })).statusCode,
    ).toBe(204);
    expect(h.storage.objects.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

describe('media routes', () => {
  async function finished() {
    const h = await harness();
    const dto = await createGeneration(h.app);
    const { video } = await completeGeneration(h, dto.id);
    return { h, id: dto.id, video, url: `/api/generations/${dto.id}/video` };
  }

  it('streams the full file with caching headers', async () => {
    const { h, video, url } = await finished();
    const res = await h.app.inject({ method: 'GET', url, headers: bearer });
    expect(res.statusCode).toBe(200);
    expect(res.headers).toMatchObject({
      'content-type': 'video/mp4',
      'content-length': '1000',
      'accept-ranges': 'bytes',
      'cache-control': 'private, max-age=3600',
    });
    expect(res.headers.etag).toMatch(/^W\/"/);
    expect(res.headers['content-disposition']).toBeUndefined();
    expect(res.rawPayload.equals(video)).toBe(true);
  });

  it('serves byte ranges', async () => {
    const { h, video, url } = await finished();
    const range = async (value: string) => h.app.inject({ method: 'GET', url, headers: { ...bearer, range: value } });

    const first = await range('bytes=0-99');
    expect(first.statusCode).toBe(206);
    expect(first.headers['content-range']).toBe('bytes 0-99/1000');
    expect(first.headers['content-length']).toBe('100');
    expect(first.rawPayload.equals(video.subarray(0, 100))).toBe(true);

    const open = await range('bytes=900-');
    expect(open.statusCode).toBe(206);
    expect(open.headers['content-range']).toBe('bytes 900-999/1000');
    expect(open.rawPayload.equals(video.subarray(900))).toBe(true);

    const suffix = await range('bytes=-10');
    expect(suffix.headers['content-range']).toBe('bytes 990-999/1000');
    expect(suffix.rawPayload.equals(video.subarray(990))).toBe(true);

    const clamped = await range('bytes=950-5000');
    expect(clamped.headers['content-range']).toBe('bytes 950-999/1000');

    const unsatisfiable = await range('bytes=1000-1100');
    expect(unsatisfiable.statusCode).toBe(416);
    expect(unsatisfiable.headers['content-range']).toBe('bytes */1000');
    expect(errorOf(unsatisfiable).code).toBe('range_not_satisfiable');

    const multi = await range('bytes=0-1,5-6');
    expect(multi.statusCode).toBe(200);
    expect(multi.rawPayload.length).toBe(1000);

    const staleIfRange = await h.app.inject({
      method: 'GET',
      url,
      headers: { ...bearer, range: 'bytes=0-9', 'if-range': 'W/"stale"' },
    });
    expect(staleIfRange.statusCode).toBe(200);
  });

  it('supports HEAD and conditional requests', async () => {
    const { h, url } = await finished();
    const head = await h.app.inject({ method: 'HEAD', url, headers: bearer });
    expect(head.statusCode).toBe(200);
    expect(head.headers['content-length']).toBe('1000');
    expect(head.body).toBe('');
    expect(h.storage.openedStreams).toHaveLength(0);

    const etag = String(head.headers.etag);
    const notModified = await h.app.inject({ method: 'GET', url, headers: { ...bearer, 'if-none-match': etag } });
    expect(notModified.statusCode).toBe(304);
    expect(notModified.body).toBe('');
    expect(notModified.headers.etag).toBe(etag);
  });

  it('adds an attachment disposition for downloads', async () => {
    const { h, id, url } = await finished();
    const res = await h.app.inject({ method: 'GET', url: `${url}?download=1`, headers: bearer });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="okay-so-i-finally-tried-the-new-cold-brew-kit-${id.slice(0, 8)}.mp4"`,
    );
  });

  it('serves part 1, the thumbnail and the character image, 404 when missing', async () => {
    const h = await harness();
    const dto = await createGeneration(h.app);
    const base = `/api/generations/${dto.id}`;
    const character = await h.app.inject({ method: 'GET', url: `${base}/character`, headers: bearer });
    expect(character.statusCode).toBe(200);
    expect(character.headers['content-type']).toBe('image/jpeg');

    for (const kind of ['video', 'part1', 'thumbnail']) {
      const res = await h.app.inject({ method: 'GET', url: `${base}/${kind}`, headers: bearer });
      expect(res.statusCode, kind).toBe(404);
      expect(errorOf(res).code).toBe('not_found');
    }
    await completeGeneration(h, dto.id);
    const thumb = await h.app.inject({ method: 'GET', url: `${base}/thumbnail`, headers: bearer });
    expect(thumb.statusCode).toBe(200);
    expect(thumb.headers['content-type']).toBe('image/jpeg');
    const part1 = await h.app.inject({ method: 'GET', url: `${base}/part1`, headers: bearer });
    expect(part1.statusCode).toBe(200);

    const unknown = await h.app.inject({
      method: 'GET',
      url: `/api/generations/${randomUUID()}/video`,
      headers: bearer,
    });
    expect(unknown.statusCode).toBe(404);
    const unauthenticated = await h.app.inject({ method: 'GET', url: `${base}/video` });
    expect(unauthenticated.statusCode).toBe(401);
  });

  it('destroys the storage stream when the client aborts', async () => {
    const h = await harness();
    const dto = await createGeneration(h.app);
    const { keys } = await completeGeneration(h, dto.id);
    const chunk = Buffer.alloc(64 * 1024, 1);
    const chunks = 160;
    await h.storage.putBuffer(keys.final, Buffer.alloc(chunk.length * chunks, 1), 'video/mp4');
    let produced: Readable | null = null;
    h.storage.createReadStream = async () => {
      let sent = 0;
      produced = new Readable({
        read() {
          setTimeout(() => this.push(sent++ < chunks ? chunk : null), 5);
        },
      });
      return produced;
    };
    const address = await h.app.listen({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((resolve, reject) => {
      const req = httpGet(`${address}/api/generations/${dto.id}/video`, { headers: bearer }, (res) => {
        expect(res.statusCode).toBe(200);
        res.once('data', () => {
          req.destroy();
          resolve();
        });
      });
      req.on('error', (err) => (req.destroyed ? undefined : reject(err)));
    });
    await vi.waitFor(() => expect((produced as Readable | null)?.destroyed).toBe(true), { timeout: 3000 });
  });

  it('redirects to presigned URLs when the storage provides them', async () => {
    const { h, id, url } = await finished();
    h.storage.signedUrlBase = 'https://bucket.example.com';
    const res = await h.app.inject({ method: 'GET', url: `${url}?download=1`, headers: bearer });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`https://bucket.example.com/${generationKeys(id).final}`);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(h.storage.signedRequests[0]).toMatchObject({
      downloadFileName: `okay-so-i-finally-tried-the-new-cold-brew-kit-${id.slice(0, 8)}.mp4`,
      contentType: 'video/mp4',
    });
  });
});

// ---------------------------------------------------------------------------
// SPA
// ---------------------------------------------------------------------------

describe('single-page app', () => {
  let dist: string;

  beforeAll(async () => {
    dist = await mkdtemp(join(tmpdir(), 'omni-web-'));
    await mkdir(join(dist, 'assets'));
    await writeFile(join(dist, 'index.html'), '<!doctype html><title>Omni UGC Studio</title><div id="root"></div>');
    await writeFile(join(dist, 'assets', 'app-abc123.js'), 'console.log("app")');
  });
  afterAll(async () => {
    await rm(dist, { recursive: true, force: true });
  });

  it('serves index.html, hashed assets and client-side routes', async () => {
    const { app } = await harness({ WEB_DIST_DIR: dist });
    const html = { accept: 'text/html,application/xhtml+xml' };

    const index = await app.inject({ method: 'GET', url: '/', headers: html });
    expect(index.statusCode).toBe(200);
    expect(index.headers['content-type']).toContain('text/html');
    expect(index.headers['cache-control']).toBe('no-cache');
    expect(index.body).toContain('Omni UGC Studio');
    expect(String(index.headers['content-security-policy'])).toContain("frame-ancestors 'none'");

    const asset = await app.inject({ method: 'GET', url: '/assets/app-abc123.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');

    const route = await app.inject({ method: 'GET', url: '/generations/123?tab=log', headers: html });
    expect(route.statusCode).toBe(200);
    expect(route.body).toContain('Omni UGC Studio');
    expect(route.headers['cache-control']).toBe('no-cache');

    const missingAsset = await app.inject({ method: 'GET', url: '/assets/missing.js', headers: { accept: '*/*' } });
    expect(missingAsset.statusCode).toBe(404);
    expect(errorOf(missingAsset).code).toBe('not_found');

    const api = await app.inject({ method: 'GET', url: '/api/nope', headers: { ...bearer, ...html } });
    expect(api.statusCode).toBe(404);
    expect(api.headers['content-type']).toContain('application/json');
    const encodedApi = await app.inject({ method: 'GET', url: '/%61pi/nope', headers: { ...bearer, ...html } });
    expect(encodedApi.statusCode).toBe(404);
    expect(encodedApi.headers['content-type']).toContain('application/json');
    const anonymousApi = await app.inject({ method: 'GET', url: '/%61pi/generations', headers: html });
    expect(anonymousApi.statusCode).toBe(401);

    const post = await app.inject({ method: 'POST', url: '/somewhere', headers: html });
    expect(post.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Real adapters: ffmpeg image normalization and local disk storage
// ---------------------------------------------------------------------------

describe('with FfmpegMediaTools and LocalStorage', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'omni-http-storage-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('re-encodes the upload to JPEG and streams ranges from disk', async () => {
    const storage = new LocalStorage(dir);
    const h = await harness({}, { media: new FfmpegMediaTools(), storage });
    const dto = await createGeneration(h.app);

    const image = await h.app.inject({ method: 'GET', url: dto.characterImageUrl, headers: bearer });
    expect(image.statusCode).toBe(200);
    expect(image.headers['content-type']).toBe('image/jpeg');
    expect([...image.rawPayload.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);

    const keys = generationKeys(dto.id);
    const video = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7) % 256));
    await storage.putBuffer(keys.final, video, 'video/mp4');
    await h.ctx.repo.update(dto.id, { status: 'succeeded', stage: 'completed', finalVideoKey: keys.final });
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/generations/${dto.id}/video`,
      headers: { ...bearer, range: 'bytes=100-1123' },
    });
    expect(res.statusCode).toBe(206);
    expect(res.headers['content-range']).toBe('bytes 100-1123/4096');
    expect(res.rawPayload.equals(video.subarray(100, 1124))).toBe(true);
  });

  it('rejects a PNG signature with a corrupt body', async () => {
    const h = await harness({}, { media: new FfmpegMediaTools(), storage: new LocalStorage(dir) });
    const corrupt = Buffer.concat([makePng().subarray(0, 40), Buffer.alloc(200, 0x41)]);
    const res = await postGeneration(h.app, undefined, { data: corrupt });
    expect(res.statusCode).toBe(415);
    expect(errorOf(res).code).toBe('unsupported_media_type');
  });
});
