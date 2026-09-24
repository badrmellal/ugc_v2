import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createPool, type Db } from '../src/db/pool.js';
import { PgTurnLimiter } from '../src/db/turn-limiter.js';

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/omni_ugc_test';

describe('PgTurnLimiter', () => {
  let db: Db;
  let db2: Db;

  beforeAll(() => {
    const config = loadConfig({ NODE_ENV: 'test', GEMINI_MOCK: 'true', DATABASE_URL });
    db = createPool(config);
    // A second pool stands in for another worker process.
    db2 = createPool(config);
  });

  afterAll(async () => {
    await db.end();
    await db2.end();
  });

  it('caps concurrent turns across pools and hands the slot over on release', async () => {
    const a = new PgTurnLimiter(db, 1);
    const b = new PgTurnLimiter(db2, 1);
    const releaseA = await a.acquire(new AbortController().signal);

    let bAcquired = false;
    const pending = b.acquire(new AbortController().signal).then((release) => {
      bAcquired = true;
      return release;
    });
    await new Promise((r) => setTimeout(r, 500));
    expect(bAcquired).toBe(false);

    await releaseA();
    await releaseA(); // idempotent
    const releaseB = await pending;
    expect(bAcquired).toBe(true);
    await releaseB();
  });

  it('allows as many concurrent holders as slots', async () => {
    const limiter = new PgTurnLimiter(db, 2);
    const r1 = await limiter.acquire(new AbortController().signal);
    const r2 = await limiter.acquire(new AbortController().signal);
    await r1();
    await r2();
  });

  it('stops waiting when aborted', async () => {
    const limiter = new PgTurnLimiter(db, 1);
    const hold = await limiter.acquire(new AbortController().signal);
    const controller = new AbortController();
    const waiting = limiter.acquire(controller.signal);
    setTimeout(() => controller.abort(new Error('shutdown')), 100);
    await expect(waiting).rejects.toThrow('shutdown');
    await hold();
  });
});
