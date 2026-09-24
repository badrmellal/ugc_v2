import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, type AppConfig } from '../src/config.js';
import { VideoModelError, type InteractionState, type VideoTurnRequest } from '../src/core/ports.js';
import { createTextClient, createVideoClient } from '../src/gemini/index.js';
import { MockTextClient, MockVideoClient } from '../src/gemini/mock.js';
import { FfmpegMediaTools } from '../src/media/ffmpeg.js';
import { turnCostFromUsage } from '../src/pricing/pricing.js';

const logger = pino({ level: 'silent' });
const media = new FfmpegMediaTools({ timeoutMs: 120_000 });

function config(extensionReturnsFull: boolean, turnSeconds = 5): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    GEMINI_MOCK: 'true',
    MOCK_TURN_SECONDS: String(turnSeconds),
    MOCK_EXTENSION_RETURNS_FULL: extensionReturnsFull ? 'true' : 'false',
  });
}

function probeSeconds(file: string): { duration: number; width: number; height: number; audio: boolean } {
  const out = JSON.parse(
    execFileSync('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file]).toString(),
  ) as { format: { duration: string }; streams: { codec_type: string; width?: number; height?: number }[] };
  const video = out.streams.find((s) => s.codec_type === 'video');
  return {
    duration: Number(out.format.duration),
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    audio: out.streams.some((s) => s.codec_type === 'audio'),
  };
}

let dir: string;
let imagePng: Buffer;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'omni-mock-test-'));
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=c=orange:s=300x400',
    '-frames:v',
    '1',
    join(dir, 'character.png'),
  ]);
  imagePng = await readFile(join(dir, 'character.png'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function turn(over: Partial<VideoTurnRequest>): VideoTurnRequest {
  return {
    kind: 'initial',
    prompt: 'Vertical 9:16 UGC selfie video. The person in <IMAGE_REF_0> says: "Hi"',
    resolution: '720p',
    durationSec: 10,
    aspectRatio: '9:16',
    image: null,
    imageMode: 'reference',
    previousInteractionId: null,
    generationId: 'gen-mock',
    ...over,
  };
}

/** Runs a turn to completion with a controllable clock. */
async function runTurn(
  client: MockVideoClient,
  clock: { t: number },
  req: VideoTurnRequest,
): Promise<InteractionState> {
  const started = await client.startTurn(req);
  expect(started.status).toBe('in_progress');
  expect(started.id).toMatch(/^mock_[0-9a-f-]{36}$/);
  clock.t += 1_000;
  expect((await client.getInteraction(started.id)).status).toBe('in_progress');
  clock.t += 10_000;
  return client.getInteraction(started.id);
}

describe('MockVideoClient', () => {
  it('generates a 10s part 1 and a full ~20s extension', async () => {
    const clock = { t: 1_000_000 };
    const cfg = config(true);
    const client = new MockVideoClient({ config: cfg, logger, media, workDir: join(dir, 'full'), now: () => clock.t });
    const image = await client.uploadImage({ data: imagePng, mimeType: 'image/png', displayName: 'character' });
    expect(image.uri).toMatch(/^mock-file:\/\/upload-.+\.png$/);
    expect(image.expiresAt!.getTime()).toBeGreaterThan(clock.t);

    const part1 = await runTurn(client, clock, turn({ image }));
    expect(part1.status).toBe('completed');
    expect(part1.video?.uri).toMatch(/^mock-file:\/\//);
    expect(part1.usage?.videoOutputTokens).toBe(10 * 5792);
    expect(turnCostFromUsage(cfg.pricing, part1.usage)?.usd).toBeGreaterThan(1);
    const p1 = join(dir, 'p1.mp4');
    await client.downloadVideo(part1.video!, p1);
    const probe1 = probeSeconds(p1);
    expect(probe1.duration).toBeGreaterThan(9.5);
    expect(probe1.duration).toBeLessThan(10.5);
    expect([probe1.width, probe1.height]).toEqual([720, 1280]);
    expect(probe1.audio).toBe(true);

    const part2 = await runTurn(
      client,
      clock,
      turn({ kind: 'extension', prompt: 'Extend this video.', previousInteractionId: part1.id }),
    );
    expect(part2.status).toBe('completed');
    // EXTENSION_BILLING=new_seconds (default): only the new 10s are billed as output, part 1 as input.
    expect(part2.usage?.videoOutputTokens).toBe(10 * 5792);
    expect(part2.usage?.videoInputTokens).toBe(10 * 5792);
    const p2 = join(dir, 'p2.mp4');
    await client.downloadVideo(part2.video!, p2);
    const probe2 = probeSeconds(p2);
    expect(probe2.duration).toBeGreaterThan(19);
    expect(probe2.duration).toBeLessThan(21);
    await client.dispose();
  });

  it('returns only the new 10s when MOCK_EXTENSION_RETURNS_FULL=false, with a stand-in after a restart', async () => {
    const clock = { t: 5_000_000 };
    const client = new MockVideoClient({
      config: config(false),
      logger,
      media,
      workDir: join(dir, 'new'),
      now: () => clock.t,
    });
    // "unknown-previous" simulates a restart: the part 1 interaction is not in memory.
    const part2 = await runTurn(
      client,
      clock,
      turn({ kind: 'extension', prompt: 'Extend this video.', previousInteractionId: 'mock_unknown-previous' }),
    );
    expect(part2.status).toBe('completed');
    const out = join(dir, 'new-only.mp4');
    await client.downloadVideo(part2.video!, out);
    const probe = probeSeconds(out);
    expect(probe.duration).toBeGreaterThan(9.5);
    expect(probe.duration).toBeLessThan(10.5);
    await client.dispose();
  });

  it('bills the whole returned clip with EXTENSION_BILLING=full_output and cleans up stand-in clips', async () => {
    const clock = { t: 9_000_000 };
    const workDir = join(dir, 'full-output');
    const cfg = loadConfig({
      NODE_ENV: 'test',
      GEMINI_MOCK: 'true',
      MOCK_TURN_SECONDS: '5',
      EXTENSION_BILLING: 'full_output',
    });
    const client = new MockVideoClient({ config: cfg, logger, media, workDir, now: () => clock.t });
    const part2 = await runTurn(
      client,
      clock,
      turn({ kind: 'extension', prompt: 'Extend this video.', previousInteractionId: 'mock_lost-after-restart' }),
    );
    expect(part2.status).toBe('completed');
    expect(part2.usage?.videoOutputTokens).toBe(20 * 5792);
    const files = await readdir(workDir);
    expect(files.filter((f) => f.startsWith('standin-') || f.endsWith('-new.mp4'))).toEqual([]);
    await client.dispose();
  });

  it('throws not_found for unknown interactions and supports failure injection', async () => {
    const clock = { t: 0 };
    const client = new MockVideoClient({
      config: config(true, 0),
      logger,
      media,
      workDir: join(dir, 'fail'),
      now: () => clock.t,
    });
    await expect(client.getInteraction('mock_does-not-exist')).rejects.toMatchObject({
      code: 'not_found',
      retryable: false,
    });

    client.failNextTurnWith(new VideoModelError('rate_limited', 'Mock rate limit', { retryable: true, status: 429 }));
    await expect(
      client.startTurn(
        turn({ image: { uri: 'mock-file://x.png', mimeType: 'image/png', name: null, expiresAt: null } }),
      ),
    ).rejects.toMatchObject({
      code: 'rate_limited',
    });

    client.failNextCompletionWith({ code: 'safety_blocked', message: 'Mock safety block', retryable: false });
    const started = await client.startTurn(
      turn({ image: { uri: 'mock-file://missing.png', mimeType: 'image/png', name: null, expiresAt: null } }),
    );
    const done = await client.getInteraction(started.id);
    expect(done).toMatchObject({ status: 'failed', video: null, error: { code: 'safety_blocked' } });
    await client.dispose();
  });

  it('cancels an in-progress turn', async () => {
    const clock = { t: 0 };
    const client = new MockVideoClient({
      config: config(true),
      logger,
      media,
      workDir: join(dir, 'cancel'),
      now: () => clock.t,
    });
    const started = await client.startTurn(
      turn({ image: { uri: 'mock-file://none.png', mimeType: 'image/png', name: null, expiresAt: null } }),
    );
    await client.cancel(started.id);
    clock.t += 60_000;
    expect((await client.getInteraction(started.id)).status).toBe('cancelled');
    await client.dispose();
  });

  it('is selected by createVideoClient / createTextClient in mock mode', () => {
    const cfg = config(true);
    const video = createVideoClient(cfg, logger, media);
    expect(video).toBeInstanceOf(MockVideoClient);
    expect(video.isMock).toBe(true);
    expect(video.model).toBe('gemini-omni-1.1-flash');
    expect(createTextClient(cfg, logger)).toBeInstanceOf(MockTextClient);
  });
});
