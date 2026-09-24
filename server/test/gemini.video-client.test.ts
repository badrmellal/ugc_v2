import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfig, type AppConfig } from '../src/config.js';
import { VideoModelError, type VideoTurnRequest } from '../src/core/ports.js';
import { classifyGeminiError } from '../src/gemini/errors.js';
import type { GenAiLike } from '../src/gemini/genai.js';
import {
  applyStreamEvent,
  buildTurnRequest,
  GeminiVideoClient,
  mapInteraction,
  newStreamedInteraction,
  stripImageTags,
} from '../src/gemini/video-client.js';

const API_KEY = 'AIzaSyTEST-key-0123456789abcdefghijklmnop';
const FILE_URI = 'https://generativelanguage.googleapis.com/v1beta/files/abc123';
const logger = pino({ level: 'silent' });

function testConfig(transport: 'stream' | 'background' = 'background'): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    GEMINI_API_KEY: API_KEY,
    GEMINI_REQUEST_TIMEOUT_SEC: '600',
    OMNI_TRANSPORT: transport,
  });
}

function req(over: Partial<VideoTurnRequest> = {}): VideoTurnRequest {
  return {
    kind: 'initial',
    prompt: 'Vertical 9:16 UGC selfie video. The person in <IMAGE_REF_0> says: "Hello there"',
    resolution: '720p',
    durationSec: 10,
    aspectRatio: '9:16',
    image: { uri: FILE_URI, mimeType: 'image/jpeg', name: 'files/abc123', expiresAt: null },
    imageMode: 'reference',
    previousInteractionId: null,
    generationId: 'gen-1',
    ...over,
  };
}

function fakeAi() {
  return {
    interactions: {
      create: vi.fn<GenAiLike['interactions']['create']>(),
      get: vi.fn<GenAiLike['interactions']['get']>(),
      cancel: vi.fn<GenAiLike['interactions']['cancel']>(),
    },
    files: {
      upload: vi.fn<GenAiLike['files']['upload']>(),
      get: vi.fn<GenAiLike['files']['get']>(),
    },
  } satisfies GenAiLike;
}

function apiError(status: number, message: string, statusText?: string) {
  return Object.assign(new Error(`${status} ${message}`), {
    name: status === 429 ? 'RateLimitError' : status === 400 ? 'BadRequestError' : 'APIError',
    status,
    error: { error: { code: status, message, status: statusText } },
  });
}

function client(ai: GenAiLike, fetchImpl?: typeof fetch, transport: 'stream' | 'background' = 'background') {
  return new GeminiVideoClient({
    config: testConfig(transport),
    logger,
    ai,
    fetchImpl,
    sleep: async () => undefined,
    fileActiveTimeoutMs: 5_000,
    filePollIntervalMs: 1,
    createAckTimeoutMs: 1_000,
  });
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/** A fake SSE stream: yields `events`, waits for `hold` after the first one, then optionally fails. */
function sseStream(events: unknown[], opts: { hold?: Promise<void>; failWith?: Error; signal?: AbortSignal } = {}) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const [i, event] of events.entries()) {
        if (i === 1 && opts.hold) await opts.hold;
        if (opts.signal?.aborted) throw Object.assign(new Error('Request aborted by client'), { name: 'AbortError' });
        yield event;
      }
      if (opts.failWith) throw opts.failWith;
    },
  };
}

const created = (id: string) => ({
  event_type: 'interaction.created',
  event_id: 'e1',
  interaction: { id, status: 'in_progress' },
});

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'omni-gemini-test-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('buildTurnRequest', () => {
  it('builds turn 1 with the reference image, 9:16, 10s, uri delivery and background', () => {
    const r = req();
    expect(buildTurnRequest(r, 'gemini-omni-1.1-flash', { background: true, includeDuration: true })).toEqual({
      model: 'gemini-omni-1.1-flash',
      input: [
        { type: 'image', uri: FILE_URI, mime_type: 'image/jpeg' },
        { type: 'text', text: r.prompt },
      ],
      response_format: { type: 'video', aspect_ratio: '9:16', duration: '10s', resolution: '720p', delivery: 'uri' },
      background: true,
    });
  });

  it('never sets generation_config or task, and prefixes <FIRST_FRAME> in first_frame mode', () => {
    const params = buildTurnRequest(req({ imageMode: 'first_frame', prompt: 'A person talks to camera.' }), 'm', {
      background: false,
      includeDuration: true,
    });
    expect(params).not.toHaveProperty('generation_config');
    expect(params).not.toHaveProperty('background');
    const text = (params.input as { type: string; text?: string }[])[1]!.text!;
    expect(text.startsWith('<FIRST_FRAME>')).toBe(true);
  });

  it('drops a stray <FIRST_FRAME> tag from a reference-mode prompt', () => {
    const params = buildTurnRequest(req({ prompt: '<FIRST_FRAME> A person talks to camera.' }), 'm', {
      background: false,
      includeDuration: true,
    });
    const text = (params.input as { text?: string }[])[1]!.text!;
    expect(text).not.toContain('<FIRST_FRAME>');
    expect(text).toContain('<IMAGE_REF_0>');
  });

  it('adds an <IMAGE_REF_0> binding when a reference prompt forgot it', () => {
    const params = buildTurnRequest(req({ prompt: 'A person talks to camera.' }), 'm', {
      background: true,
      includeDuration: true,
    });
    expect((params.input as { text?: string }[])[1]!.text).toContain('<IMAGE_REF_0>');
  });

  it('builds turn 2 as an extension: previous id, no aspect_ratio or task, same resolution, 10s, uri', () => {
    const params = buildTurnRequest(
      req({
        kind: 'extension',
        prompt: 'Extend this video.',
        image: null,
        previousInteractionId: 'int-1',
        resolution: '360p',
      }),
      'm',
      { background: true, includeDuration: true },
    );
    expect(params).toEqual({
      model: 'm',
      previous_interaction_id: 'int-1',
      input: 'Extend this video.',
      response_format: { type: 'video', resolution: '360p', delivery: 'uri', duration: '10s' },
      background: true,
    });
    expect(params.response_format).not.toHaveProperty('aspect_ratio');
    expect(params).not.toHaveProperty('generation_config');
  });

  it('re-sends the image on turn 2 only when requested, bound with <IMAGE_REF_0>', () => {
    const params = buildTurnRequest(
      req({ kind: 'extension', prompt: 'Extend this video. Same person.', previousInteractionId: 'int-1' }),
      'm',
      { background: true, includeDuration: false },
    );
    expect(Array.isArray(params.input)).toBe(true);
    const [image, text] = params.input as [{ type: string; uri: string }, { type: string; text: string }];
    expect(image).toEqual({ type: 'image', uri: FILE_URI, mime_type: 'image/jpeg' });
    expect(text.type).toBe('text');
    expect(text.text).toContain('<IMAGE_REF_0>');
    expect(params.response_format).toEqual({ type: 'video', resolution: '720p', delivery: 'uri' });
  });

  it('rejects a turn 1 without image and a turn 2 without previous interaction', () => {
    expect(() => buildTurnRequest(req({ image: null }), 'm', { background: true, includeDuration: true })).toThrow(
      VideoModelError,
    );
    expect(() =>
      buildTurnRequest(req({ kind: 'extension', previousInteractionId: null }), 'm', {
        background: true,
        includeDuration: true,
      }),
    ).toThrow(/part 1 interaction id/);
  });

  it('marks a streamed turn with stream: true and never with background', () => {
    const p = buildTurnRequest(req(), 'm', { background: true, stream: true, includeDuration: true });
    expect(p.stream).toBe(true);
    expect(p).not.toHaveProperty('background');
  });

  it('drops image tags from an extension prompt sent without the image', () => {
    const params = buildTurnRequest(
      req({
        kind: 'extension',
        image: null,
        previousInteractionId: 'int-1',
        prompt:
          'Extend this video.\nThe person is the same person shown in <IMAGE_REF_0>; keep the face as in <IMAGE_REF_0>.\nSame voice.',
      }),
      'm',
      { background: false, includeDuration: true },
    );
    expect(params.input).toBe('Extend this video.\nSame voice.');
    expect(stripImageTags('No tags here.')).toBe('No tags here.');
  });

  it('clamps the duration string to 3-10 seconds', () => {
    const p = buildTurnRequest(req({ durationSec: 14 }), 'm', { background: true, includeDuration: true });
    expect(p.response_format.duration).toBe('10s');
  });
});

describe('mapInteraction', () => {
  const usage = {
    total_input_tokens: 1500,
    total_output_tokens: 57920,
    total_thought_tokens: 300,
    output_tokens_by_modality: [{ modality: 'video', tokens: 57920 }],
  };

  it('maps a completed interaction with a uri video and usage', () => {
    const s = mapInteraction({
      id: 'int-1',
      status: 'completed',
      output_video: {
        type: 'video',
        uri: 'https://generativelanguage.googleapis.com/v1beta/files/v1',
        mime_type: 'video/mp4',
      },
      usage,
    });
    expect(s.status).toBe('completed');
    expect(s.video).toEqual({
      uri: 'https://generativelanguage.googleapis.com/v1beta/files/v1',
      mimeType: 'video/mp4',
      inlineData: null,
    });
    expect(s.usage?.videoOutputTokens).toBe(57920);
    expect(s.usage?.thoughtTokens).toBe(300);
    expect(s.error).toBeNull();
  });

  it('maps inline base64 video data from GET responses', () => {
    const s = mapInteraction({
      id: 'int-1',
      status: 'completed',
      output_video: { type: 'video', data: 'AAAAIGZ0eXA=', mime_type: 'video/mp4' },
    });
    expect(s.video).toEqual({ uri: null, mimeType: 'video/mp4', inlineData: 'AAAAIGZ0eXA=' });
  });

  it('finds the video in the steps of the current turn when output_video is absent', () => {
    const s = mapInteraction({
      id: 'int-2',
      status: 'completed',
      steps: [
        { type: 'user_input', content: [{ type: 'text', text: 'turn 1' }] },
        { type: 'model_output', content: [{ type: 'video', uri: 'files/old' }] },
        { type: 'user_input', content: [{ type: 'text', text: 'Extend this video.' }] },
        { type: 'thought', summary: [] },
        {
          type: 'model_output',
          content: [
            { type: 'text', text: 'ok' },
            { type: 'video', data: 'BBBB' },
          ],
        },
      ],
    });
    expect(s.video).toEqual({ uri: null, mimeType: 'video/mp4', inlineData: 'BBBB' });
  });

  it('does not return a previous turn video as the current output', () => {
    const s = mapInteraction({
      id: 'int-2',
      status: 'completed',
      steps: [
        { type: 'model_output', content: [{ type: 'video', uri: 'files/old' }] },
        { type: 'user_input', content: [{ type: 'text', text: 'Extend this video.' }] },
        { type: 'model_output', content: [] },
      ],
    });
    expect(s.status).toBe('completed');
    expect(s.video).toBeNull();
  });

  it('maps failed interactions with errors[] and classifies safety blocks', () => {
    const failed = mapInteraction({
      id: 'int-3',
      status: 'failed',
      errors: [{ code: 'https://errors/internal', message: 'Internal error while generating' }],
    });
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatchObject({ code: 'generation_failed', retryable: true });
    expect(failed.error?.message).toContain('Internal error while generating');

    const blocked = mapInteraction({
      id: 'int-4',
      status: 'failed',
      errors: [{ code: 'safety', message: "Input blocked: we can't create videos with real people's likenesses" }],
    });
    expect(blocked.error).toMatchObject({ code: 'safety_blocked', retryable: false });
    expect(blocked.error?.message).toMatch(/recognizable people/);
  });

  it('treats a completed interaction without video but with errors as failed', () => {
    const s = mapInteraction({
      id: 'int-5',
      status: 'completed',
      steps: [{ type: 'model_output', content: [], error: { code: 3, message: 'Output blocked by safety filters' } }],
    });
    expect(s.status).toBe('failed');
    expect(s.error?.code).toBe('safety_blocked');
  });

  it('maps queued, requires_action, budget_exceeded, cancelled and incomplete', () => {
    expect(mapInteraction({ id: 'a', status: 'queued' }).status).toBe('in_progress');
    expect(mapInteraction({ id: 'a', status: 'in_progress' }).status).toBe('in_progress');
    expect(mapInteraction({ id: 'a', status: 'requires_action' }).status).toBe('in_progress');
    const budget = mapInteraction({ id: 'a', status: 'budget_exceeded' });
    expect(budget.status).toBe('failed');
    expect(budget.error).toMatchObject({ code: 'budget_exceeded', retryable: false });
    expect(mapInteraction({ id: 'a', status: 'cancelled' })).toMatchObject({ status: 'cancelled', error: null });
    expect(mapInteraction({ id: 'a', status: 'incomplete' }).error).toMatchObject({
      code: 'interaction_incomplete',
      retryable: true,
    });
  });

  it('rejects responses without an id', () => {
    expect(() => mapInteraction({ status: 'completed' })).toThrow(/without an id/);
  });

  it('redacts secrets that appear in error messages', () => {
    const s = mapInteraction({ id: 'a', status: 'failed', errors: [{ message: `bad key ${API_KEY}` }] }, [API_KEY]);
    expect(s.error?.message).not.toContain(API_KEY);
  });
});

describe('classifyGeminiError', () => {
  const cases: {
    name: string;
    err: unknown;
    context?: 'create' | 'get' | 'download';
    code: string;
    retryable: boolean;
    contains?: RegExp;
  }[] = [
    {
      name: '429 RESOURCE_EXHAUSTED',
      err: apiError(429, 'Resource has been exhausted (e.g. check quota).', 'RESOURCE_EXHAUSTED'),
      code: 'rate_limited',
      retryable: true,
      contains: /10 minute window/,
    },
    {
      name: '500',
      err: apiError(500, 'Internal error encountered.', 'INTERNAL'),
      code: 'upstream_unavailable',
      retryable: true,
    },
    {
      name: '503',
      err: apiError(503, 'The model is overloaded.', 'UNAVAILABLE'),
      code: 'upstream_unavailable',
      retryable: true,
    },
    {
      name: '504',
      err: apiError(504, 'Deadline exceeded', 'DEADLINE_EXCEEDED'),
      code: 'upstream_unavailable',
      retryable: true,
    },
    {
      name: '400 INVALID_ARGUMENT',
      err: apiError(400, 'Invalid value for response_format.duration', 'INVALID_ARGUMENT'),
      code: 'invalid_request',
      retryable: false,
      contains: /response_format\.duration/,
    },
    {
      name: '400 bad API key',
      err: apiError(400, 'API key not valid. Please pass a valid API key.', 'INVALID_ARGUMENT'),
      code: 'auth_error',
      retryable: false,
      contains: /billing/,
    },
    {
      name: '401',
      err: apiError(401, 'Request had invalid authentication credentials.', 'UNAUTHENTICATED'),
      code: 'auth_error',
      retryable: false,
    },
    {
      name: '403 API disabled',
      err: apiError(
        403,
        'Generative Language API has not been used in project 123 before or it is disabled.',
        'PERMISSION_DENIED',
      ),
      code: 'auth_error',
      retryable: false,
      contains: /no free tier/,
    },
    {
      name: '404 on get',
      err: apiError(404, 'Interaction not found', 'NOT_FOUND'),
      context: 'get',
      code: 'not_found',
      retryable: false,
    },
    {
      name: '404 on download',
      err: { status: 404, message: 'Not Found' },
      context: 'download',
      code: 'output_not_found',
      retryable: true,
    },
    {
      name: 'safety block',
      err: apiError(
        400,
        'The prompt could not be submitted: it contains prominent people or violates the usage policies.',
        'INVALID_ARGUMENT',
      ),
      code: 'safety_blocked',
      retryable: false,
      contains: /minors are not supported in the EEA/,
    },
    {
      name: 'region',
      err: apiError(400, 'User location is not supported for the API use.', 'FAILED_PRECONDITION'),
      code: 'region_unsupported',
      retryable: false,
    },
    {
      name: 'SDK timeout',
      err: Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' }),
      code: 'timeout',
      retryable: true,
    },
    {
      name: 'AbortSignal.timeout',
      err: new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
      code: 'timeout',
      retryable: true,
    },
    {
      name: 'network',
      err: Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('socket'), { code: 'ECONNRESET' }),
      }),
      code: 'network_error',
      retryable: true,
    },
    {
      name: 'legacy Files API ApiError with JSON message',
      err: Object.assign(
        new Error(
          JSON.stringify({
            error: { code: 400, message: 'Request contains an invalid argument.', status: 'INVALID_ARGUMENT' },
          }),
        ),
        {
          name: 'ApiError',
          status: 400,
        },
      ),
      code: 'invalid_request',
      retryable: false,
      contains: /Request contains an invalid argument\./,
    },
  ];

  for (const c of cases) {
    it(`classifies ${c.name}`, () => {
      const e = classifyGeminiError(c.err, API_KEY, c.context ?? 'create');
      expect(e).toBeInstanceOf(VideoModelError);
      expect(e.code).toBe(c.code);
      expect(e.retryable).toBe(c.retryable);
      if (c.contains) expect(e.message).toMatch(c.contains);
    });
  }

  it('never returns the API key', () => {
    const e = classifyGeminiError(apiError(400, `Bad request for key=${API_KEY} and ${API_KEY}`), API_KEY);
    expect(e.message).not.toContain(API_KEY);
    expect(e.message).toContain('[REDACTED]');
  });
});

describe('GeminiVideoClient with a fake SDK', () => {
  it('creates turns with maxRetries 0 and switches from background to streaming, then to blocking', async () => {
    const ai = fakeAi();
    ai.interactions.create
      .mockRejectedValueOnce(apiError(400, 'background is not supported for this model', 'INVALID_ARGUMENT'))
      .mockRejectedValueOnce(apiError(400, 'Streaming is not supported for this model', 'INVALID_ARGUMENT'))
      .mockResolvedValueOnce({ id: 'int-1', status: 'completed', output_video: { type: 'video', data: 'AAAA' } })
      .mockResolvedValueOnce({ id: 'int-2', status: 'completed', output_video: { type: 'video', data: 'BBBB' } });
    const c = client(ai);
    expect(c.transport).toBe('background');
    const s = await c.startTurn(req());
    expect(s).toMatchObject({ id: 'int-1', status: 'completed', video: { inlineData: 'AAAA' } });
    expect(ai.interactions.create).toHaveBeenCalledTimes(3);
    const [first, second, third] = ai.interactions.create.mock.calls as [
      Record<string, unknown>,
      { maxRetries: number; timeout: number; signal?: AbortSignal },
    ][];
    expect(first![0].background).toBe(true);
    expect(first![0]).not.toHaveProperty('stream');
    expect(second![0].stream).toBe(true);
    expect(second![0]).not.toHaveProperty('background');
    expect(third![0]).not.toHaveProperty('background');
    expect(third![0]).not.toHaveProperty('stream');
    for (const call of [first, second, third]) expect(call![1].maxRetries).toBe(0);
    expect(first![1].timeout).toBe(1_000);
    expect(third![1]).toEqual({ maxRetries: 0, timeout: 600_000 });
    expect(c.transport).toBe('blocking');
    expect(c.usesBackground).toBe(false);

    await c.startTurn(req());
    expect(ai.interactions.create).toHaveBeenCalledTimes(4);
    expect(ai.interactions.create.mock.calls[3]![0]).not.toHaveProperty('background');
  });

  it('retries an extension once without duration when duration is rejected, and remembers it', async () => {
    const ai = fakeAi();
    ai.interactions.create
      .mockRejectedValueOnce(
        apiError(400, 'Duration cannot be set in response format for extend task', 'INVALID_ARGUMENT'),
      )
      .mockResolvedValue({ id: 'int-2', status: 'queued' });
    const c = client(ai);
    const ext = req({ kind: 'extension', image: null, previousInteractionId: 'int-1', prompt: 'Extend this video.' });
    const s = await c.startTurn(ext);
    expect(s).toEqual({ id: 'int-2', status: 'in_progress', video: null, usage: null, error: null });
    const calls = ai.interactions.create.mock.calls as [{ response_format: Record<string, unknown> }][];
    expect(calls[0]![0].response_format.duration).toBe('10s');
    expect(calls[1]![0].response_format).not.toHaveProperty('duration');

    await c.startTurn(ext);
    expect(calls[2]![0].response_format).not.toHaveProperty('duration');
    await c.startTurn(req());
    expect(calls[3]![0].response_format.duration).toBe('10s');
  });

  it('drops resolution on extensions and uri delivery when the API rejects them', async () => {
    const ai = fakeAi();
    ai.interactions.create
      .mockRejectedValueOnce(apiError(400, 'Resolution cannot be set in response format for extend task'))
      .mockRejectedValueOnce(apiError(400, 'delivery mode uri is not supported'))
      .mockResolvedValue({ id: 'int-3', status: 'queued' });
    const c = client(ai);
    await c.startTurn(
      req({ kind: 'extension', image: null, previousInteractionId: 'int-1', prompt: 'Extend this video.' }),
    );
    const calls = ai.interactions.create.mock.calls as unknown as [{ response_format: Record<string, unknown> }][];
    expect(calls[0]![0].response_format).toMatchObject({ resolution: '720p', delivery: 'uri' });
    expect(calls[1]![0].response_format).not.toHaveProperty('resolution');
    expect(calls[2]![0].response_format).toEqual({ type: 'video', duration: '10s' });
    await c.startTurn(req());
    // Turn 1 always keeps its resolution; the delivery downgrade applies to both turns.
    expect(calls[3]![0].response_format).toEqual({
      type: 'video',
      aspect_ratio: '9:16',
      duration: '10s',
      resolution: '720p',
    });
  });

  it('does not retry paid creates on 429 or on other 400s', async () => {
    const ai = fakeAi();
    ai.interactions.create.mockRejectedValueOnce(apiError(429, 'Resource exhausted', 'RESOURCE_EXHAUSTED'));
    const c = client(ai);
    await expect(c.startTurn(req())).rejects.toMatchObject({ code: 'rate_limited', retryable: true });
    ai.interactions.create.mockRejectedValueOnce(apiError(400, 'Invalid duration value', 'INVALID_ARGUMENT'));
    await expect(c.startTurn(req())).rejects.toMatchObject({ code: 'invalid_request', retryable: false });
    expect(ai.interactions.create).toHaveBeenCalledTimes(2);
  });

  it('polls, reports unreadable interactions as lost (to be recreated) and ignores cancel of finished ones', async () => {
    const ai = fakeAi();
    ai.interactions.get.mockResolvedValueOnce({ id: 'int-1', status: 'in_progress' });
    ai.interactions.get.mockRejectedValueOnce(apiError(404, 'Not found', 'NOT_FOUND'));
    ai.interactions.get.mockRejectedValueOnce(apiError(503, 'The model is overloaded', 'UNAVAILABLE'));
    ai.interactions.cancel.mockRejectedValueOnce(apiError(400, 'Interaction is not running'));
    const c = client(ai);
    expect((await c.getInteraction('int-1')).status).toBe('in_progress');
    await expect(c.getInteraction('int-1')).rejects.toMatchObject({ code: 'interaction_lost', retryable: true });
    await expect(c.getInteraction('int-1')).rejects.toMatchObject({ code: 'upstream_unavailable', retryable: true });
    await expect(c.cancel('int-1')).resolves.toBeUndefined();
    // Only a background interaction created by this process switches the transport.
    expect(c.transport).toBe('background');
  });

  it('reports mock interaction ids as lost instead of calling Google', async () => {
    const ai = fakeAi();
    const c = client(ai);
    await expect(c.getInteraction('mock_123')).rejects.toMatchObject({ code: 'interaction_lost', retryable: true });
    await expect(c.cancel('mock_123')).resolves.toBeUndefined();
    expect(ai.interactions.get).not.toHaveBeenCalled();
    expect(ai.interactions.cancel).not.toHaveBeenCalled();
  });

  it('uploads the character image and waits until the file is ACTIVE', async () => {
    const ai = fakeAi();
    ai.files.upload.mockResolvedValue({
      name: 'files/img1',
      uri: FILE_URI,
      mimeType: 'image/png',
      state: 'PROCESSING',
    });
    ai.files.get.mockResolvedValueOnce({ name: 'files/img1', state: 'PROCESSING' }).mockResolvedValueOnce({
      name: 'files/img1',
      uri: FILE_URI,
      mimeType: 'image/png',
      state: 'ACTIVE',
      expirationTime: '2030-01-02T03:04:05Z',
    });
    const c = client(ai);
    const ref = await c.uploadImage({
      data: Buffer.from('png-bytes'),
      mimeType: 'image/png',
      displayName: 'character-1',
    });
    expect(ref).toEqual({
      uri: FILE_URI,
      mimeType: 'image/png',
      name: 'files/img1',
      expiresAt: new Date('2030-01-02T03:04:05Z'),
    });
    const [params] = ai.files.upload.mock.calls[0] as [{ file: Blob; config: Record<string, string> }];
    expect(params.config).toEqual({ mimeType: 'image/png', displayName: 'character-1' });
    expect(params.file.size).toBe(9);
    expect(ai.files.get).toHaveBeenCalledTimes(2);
  });

  it('writes inline video data', async () => {
    const c = client(fakeAi());
    const dest = join(dir, 'inline.mp4');
    await c.downloadVideo(
      { uri: null, mimeType: 'video/mp4', inlineData: Buffer.from('fake-mp4').toString('base64') },
      dest,
    );
    expect((await readFile(dest)).toString()).toBe('fake-mp4');
  });

  it('streams a Files API video with the key in a header, never in the URL', async () => {
    const ai = fakeAi();
    ai.files.get
      .mockResolvedValueOnce({ name: 'files/vid123', state: 'PROCESSING' })
      .mockResolvedValueOnce({ name: 'files/vid123', state: 'ACTIVE' });
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const body = Buffer.from('video-bytes-0123456789');
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      return new Response(body, { status: 200, headers: { 'content-length': String(body.length) } });
    }) as unknown as typeof fetch;
    const c = client(ai, fetchImpl);
    const dest = join(dir, 'uri.mp4');
    await c.downloadVideo(
      {
        uri: 'https://generativelanguage.googleapis.com/v1beta/files/vid123:download?alt=media',
        mimeType: 'video/mp4',
        inlineData: null,
      },
      dest,
    );
    expect(await readFile(dest)).toEqual(body);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('https://generativelanguage.googleapis.com/v1beta/files/vid123:download?alt=media');
    expect(seen[0]!.url).not.toContain(API_KEY);
    expect(seen[0]!.headers['x-goog-api-key']).toBe(API_KEY);
    expect(ai.files.get).toHaveBeenCalledWith({ name: 'files/vid123' });
  });

  it('does not forward the key when a download redirects to another host', async () => {
    const ai = fakeAi();
    ai.files.get.mockResolvedValue({ name: 'files/vid9', state: 'ACTIVE' });
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      if (seen.length === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://storage.googleapis.com/bucket/vid9.mp4' },
        });
      }
      return new Response(Buffer.from('redirected'), { status: 200 });
    }) as unknown as typeof fetch;
    const dest = join(dir, 'redirect.mp4');
    await client(ai, fetchImpl).downloadVideo({ uri: 'files/vid9', mimeType: 'video/mp4', inlineData: null }, dest);
    expect((await readFile(dest)).toString()).toBe('redirected');
    expect(seen[1]!.url).toBe('https://storage.googleapis.com/bucket/vid9.mp4');
    expect(seen[1]!.headers).not.toHaveProperty('x-goog-api-key');
  });

  it('refuses to follow a download redirect to plain http', async () => {
    const ai = fakeAi();
    ai.files.get.mockResolvedValue({ name: 'files/vid7', state: 'ACTIVE' });
    const fetchImpl = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'http://example.com/vid7.mp4' },
      })) as unknown as typeof fetch;
    const dest = join(dir, 'insecure.mp4');
    await expect(
      client(ai, fetchImpl).downloadVideo({ uri: 'files/vid7', mimeType: 'video/mp4', inlineData: null }, dest),
    ).rejects.toMatchObject({ code: 'invalid_output', retryable: false });
    expect(existsSync(`${dest}.part`)).toBe(false);
  });

  it('maps a failed download to a retryable error and leaves no partial file', async () => {
    const ai = fakeAi();
    ai.files.get.mockRejectedValue(apiError(403, 'forbidden', 'PERMISSION_DENIED'));
    const fetchImpl = (async () =>
      new Response('{"error":{"code":404,"message":"File not found"}}', { status: 404 })) as unknown as typeof fetch;
    const dest = join(dir, 'missing.mp4');
    await expect(
      client(ai, fetchImpl).downloadVideo({ uri: FILE_URI, mimeType: 'video/mp4', inlineData: null }, dest),
    ).rejects.toMatchObject({ code: 'output_not_found', retryable: true });
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(`${dest}.part`)).toBe(false);
  });
});

describe('GeminiVideoClient stream transport (OMNI_TRANSPORT=stream, the default)', () => {
  it('uses the stream transport by default', () => {
    const c = new GeminiVideoClient({
      config: loadConfig({ NODE_ENV: 'test', GEMINI_API_KEY: API_KEY }),
      logger,
      ai: fakeAi(),
    });
    expect(c.transport).toBe('stream');
  });

  it('returns as soon as the interaction id arrives, then serves the streamed result from memory', async () => {
    const ai = fakeAi();
    const hold = deferred();
    const events = [
      created('int-s1'),
      { event_type: 'interaction.status_update', interaction_id: 'int-s1', status: 'in_progress' },
      { event_type: 'step.start', index: 0, step: { type: 'thought', summary: [] } },
      { event_type: 'step.start', index: 1, step: { type: 'model_output', content: [] } },
      { event_type: 'step.delta', index: 1, delta: { type: 'video', uri: FILE_URI, mime_type: 'video/mp4' } },
      { event_type: 'step.stop', index: 1, usage: { total_input_tokens: 1500, total_output_tokens: 57920 } },
      { event_type: 'interaction.completed', event_id: 'e9', interaction: { id: 'int-s1', status: 'completed' } },
    ];
    ai.interactions.create.mockImplementation(async (_params, options) =>
      sseStream(events, { hold: hold.promise, signal: options?.signal }),
    );
    const c = client(ai, undefined, 'stream');
    const started = await c.startTurn(req());
    expect(started).toEqual({ id: 'int-s1', status: 'in_progress', video: null, usage: null, error: null });
    const [params, options] = ai.interactions.create.mock.calls[0] as [
      Record<string, unknown>,
      { maxRetries: number; timeout: number; signal?: AbortSignal },
    ];
    expect(params.stream).toBe(true);
    expect(params).not.toHaveProperty('background');
    expect(params.response_format).toEqual({
      type: 'video',
      aspect_ratio: '9:16',
      duration: '10s',
      resolution: '720p',
      delivery: 'uri',
    });
    expect(options.maxRetries).toBe(0);
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.timeout).toBeGreaterThanOrEqual(1_500_000);

    expect((await c.getInteraction('int-s1')).status).toBe('in_progress');
    hold.resolve();
    await vi.waitFor(async () => expect((await c.getInteraction('int-s1')).status).toBe('completed'));
    const done = await c.getInteraction('int-s1');
    expect(done.video).toEqual({ uri: FILE_URI, mimeType: 'video/mp4', inlineData: null });
    expect(done.usage?.outputTokens).toBe(57920);
    expect(ai.interactions.get).not.toHaveBeenCalled();
  });

  it('reads the stored interaction when the stream finished without a video part', async () => {
    const ai = fakeAi();
    ai.interactions.create.mockResolvedValue(
      sseStream([
        created('int-s2'),
        { event_type: 'interaction.completed', interaction: { id: 'int-s2', status: 'completed' } },
      ]),
    );
    ai.interactions.get.mockResolvedValue({
      id: 'int-s2',
      status: 'completed',
      output_video: { type: 'video', uri: FILE_URI, mime_type: 'video/mp4' },
    });
    const c = client(ai, undefined, 'stream');
    await c.startTurn(req());
    await vi.waitFor(async () => expect((await c.getInteraction('int-s2')).video?.uri).toBe(FILE_URI));
  });

  it('falls back to polling when the stream is cut, and reports the turn lost when it cannot be read', async () => {
    const ai = fakeAi();
    const cut = Object.assign(new TypeError('terminated'), {
      cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
    });
    ai.interactions.create
      .mockResolvedValueOnce(sseStream([created('int-s3')], { failWith: cut }))
      .mockResolvedValueOnce(sseStream([created('int-s4')], { failWith: cut }));
    ai.interactions.get
      .mockResolvedValueOnce({ id: 'int-s3', status: 'in_progress' })
      .mockResolvedValueOnce({ id: 'int-s3', status: 'completed', output_video: { type: 'video', data: 'AAAA' } })
      .mockRejectedValueOnce(apiError(404, 'Interaction not found', 'NOT_FOUND'));
    const c = client(ai, undefined, 'stream');

    await c.startTurn(req());
    await flush();
    // The stream was cut before a terminal event: the next polls read the stored interaction.
    expect((await c.getInteraction('int-s3')).status).toBe('in_progress');
    const done = await c.getInteraction('int-s3');
    expect(done).toMatchObject({ status: 'completed', video: { inlineData: 'AAAA' } });
    expect(ai.interactions.get).toHaveBeenCalledTimes(2);

    await c.startTurn(req());
    await flush();
    await expect(c.getInteraction('int-s4')).rejects.toMatchObject({ code: 'interaction_lost', retryable: true });
  });

  it('applies request downgrades when the stream rejects the request with an invalid-argument error event', async () => {
    const ai = fakeAi();
    ai.interactions.create
      .mockResolvedValueOnce(
        sseStream([
          {
            event_type: 'error',
            error: { code: 'invalid_argument', message: 'Duration cannot be set in response format for extend task' },
          },
        ]),
      )
      .mockResolvedValueOnce(sseStream([created('int-s6')]));
    const c = client(ai, undefined, 'stream');
    const ext = req({ kind: 'extension', image: null, previousInteractionId: 'int-1', prompt: 'Extend this video.' });
    expect((await c.startTurn(ext)).id).toBe('int-s6');
    const calls = ai.interactions.create.mock.calls as unknown as [{ response_format: Record<string, unknown> }][];
    expect(calls[0]![0].response_format.duration).toBe('10s');
    expect(calls[1]![0].response_format).not.toHaveProperty('duration');
  });

  it('maps an error event before the interaction id to a classified error', async () => {
    const ai = fakeAi();
    ai.interactions.create.mockResolvedValue(
      sseStream([
        {
          event_type: 'error',
          error: { code: 'safety', message: "Input blocked: we can't create videos with real people's likenesses" },
        },
      ]),
    );
    const c = client(ai, undefined, 'stream');
    await expect(c.startTurn(req())).rejects.toMatchObject({ code: 'safety_blocked', retryable: false });
    expect(ai.interactions.create).toHaveBeenCalledTimes(1);
  });

  it('times out when the stream sends no interaction id', async () => {
    const ai = fakeAi();
    let signal: AbortSignal | undefined;
    ai.interactions.create.mockImplementation(async (_params, options) => {
      signal = options?.signal;
      // A stream that never sends an event.
      return {
        [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<unknown>>(() => undefined) }),
      };
    });
    const c = client(ai, undefined, 'stream');
    await expect(c.startTurn(req())).rejects.toMatchObject({ code: 'timeout', retryable: true });
    expect(signal?.aborted).toBe(true);
  });

  it('cancels a streamed turn by closing the stream', async () => {
    const ai = fakeAi();
    const hold = deferred();
    let signal: AbortSignal | undefined;
    ai.interactions.create.mockImplementation(async (_params, options) => {
      signal = options?.signal;
      return sseStream([created('int-s5'), { event_type: 'interaction.status_update', status: 'in_progress' }], {
        hold: hold.promise,
        signal,
      });
    });
    ai.interactions.cancel.mockRejectedValue(apiError(400, 'Only background interactions can be cancelled'));
    const c = client(ai, undefined, 'stream');
    await c.startTurn(req());
    await c.cancel('int-s5');
    expect(signal?.aborted).toBe(true);
    hold.resolve();
    await vi.waitFor(async () => expect((await c.getInteraction('int-s5')).status).toBe('cancelled'));
  });

  it('switches to streaming when a background interaction cannot be polled', async () => {
    const ai = fakeAi();
    ai.interactions.create.mockResolvedValueOnce({ id: 'int-b1', status: 'in_progress' });
    ai.interactions.get.mockRejectedValueOnce(
      apiError(403, 'The caller does not have permission', 'PERMISSION_DENIED'),
    );
    const c = client(ai);
    expect((await c.startTurn(req())).id).toBe('int-b1');
    await expect(c.getInteraction('int-b1')).rejects.toMatchObject({ code: 'interaction_lost', retryable: true });
    expect(c.transport).toBe('stream');
  });
});

describe('applyStreamEvent', () => {
  it('assembles chunked inline video data and keeps the terminal status', () => {
    const acc = newStreamedInteraction();
    applyStreamEvent(acc, created('int-x'));
    applyStreamEvent(acc, {
      event_type: 'step.delta',
      index: 2,
      delta: { type: 'video', data: 'AAAA', mime_type: 'video/mp4' },
    });
    applyStreamEvent(acc, { event_type: 'step.delta', index: 2, delta: { type: 'video', data: 'BBBB' } });
    applyStreamEvent(acc, { event_type: 'interaction.completed', interaction: { id: 'int-x', status: 'completed' } });
    applyStreamEvent(acc, { event_type: 'interaction.status_update', status: 'in_progress' });
    expect(acc.id).toBe('int-x');
    expect(acc.status).toBe('completed');
    const state = mapInteraction({ id: acc.id, status: acc.status, steps: acc.steps });
    expect(state.video).toEqual({ uri: null, mimeType: 'video/mp4', inlineData: 'AAAABBBB' });
  });

  it('records error events as a failed turn', () => {
    const acc = newStreamedInteraction();
    applyStreamEvent(acc, created('int-y'));
    applyStreamEvent(acc, { event_type: 'error', error: { message: 'Output blocked by safety filters' } });
    const state = mapInteraction({ id: 'int-y', status: acc.status, errors: acc.errors });
    expect(state).toMatchObject({ status: 'failed', error: { code: 'safety_blocked', retryable: false } });
  });
});
