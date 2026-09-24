import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createTransportStore } from '../src/db/transport-store.js';
import type { GenAiLike } from '../src/gemini/genai.js';
import { GeminiVideoClient } from '../src/gemini/video-client.js';

const logger = pino({ level: 'silent' });

function memoryRepo(initial: unknown = null) {
  let value: unknown = initial;
  return {
    getAppState: vi.fn(async (_key: string): Promise<unknown> => value),
    setAppState: vi.fn(async (_key: string, v: unknown) => {
      value = v;
    }),
    peek: () => value,
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('transport store', () => {
  it('persists a rejected transport and reports it to other workers', async () => {
    const repo = memoryRepo();
    const a = createTransportStore(repo, logger);
    a.onTransportRejected('background', 'GET 400 API key not valid');
    await flush();
    const stored = repo.peek() as { transport: string }[];
    expect(stored.map((e) => e.transport)).toEqual(['background']);

    const b = createTransportStore(repo, logger);
    expect(await b.loadUnsupportedTransports()).toEqual(['background']);
  });

  it('ignores expired, malformed and blocking entries', async () => {
    const old = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
    const repo = memoryRepo([
      { transport: 'stream', at: old, reason: 'x' },
      { transport: 'blocking', at: new Date().toISOString(), reason: 'x' },
      { nope: true },
      'junk',
    ]);
    const store = createTransportStore(repo, logger);
    expect(await store.loadUnsupportedTransports()).toEqual([]);
    store.onTransportRejected('blocking', 'x');
    await flush();
    expect(repo.setAppState).not.toHaveBeenCalled();
  });

  it('the video client skips transports persisted by another worker', async () => {
    const config = loadConfig({ NODE_ENV: 'test', GEMINI_API_KEY: 'AIzaSyTEST-key-0123456789abcdefghijklmnop' });
    const ai = {
      interactions: { create: vi.fn(), get: vi.fn(), cancel: vi.fn() },
      files: { upload: vi.fn(), get: vi.fn() },
    } as unknown as GenAiLike;
    const rejected: string[] = [];
    const client = new GeminiVideoClient({
      config,
      logger,
      ai,
      loadUnsupportedTransports: async () => ['stream'],
      onTransportRejected: (t) => rejected.push(t),
    });
    expect(client.transport).toBe('stream');
    client.markUnsupported(['stream', 'blocking']);
    expect(client.transport).toBe('background');
    expect(rejected).toEqual([]);
  });
});
