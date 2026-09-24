/** Gemini adapters: real clients or mocks, selected by `GEMINI_MOCK`. */
import type { Logger } from 'pino';
import type { AppConfig } from '../config.js';
import type { MediaTools, TextModelClient, VideoModelClient } from '../core/ports.js';
import { MockTextClient, MockVideoClient } from './mock.js';
import { GeminiTextClient } from './text-client.js';
import { GeminiVideoClient, type GeminiVideoClientOptions } from './video-client.js';

export { classifyGeminiError, extractUpstreamError, AUTH_HINT, SAFETY_HINT } from './errors.js';
export { MockTextClient, MockVideoClient, mockSplitAnswer, MOCK_FILE_SCHEME } from './mock.js';
export { GeminiTextClient, TextModelResponseError, parseJsonLoose } from './text-client.js';
export {
  GeminiVideoClient,
  applyStreamEvent,
  buildTurnRequest,
  ensureImageTag,
  mapInteraction,
  stripImageTags,
  type OmniTransport,
} from './video-client.js';
export type { GenAiLike } from './genai.js';

export function createVideoClient(
  config: AppConfig,
  logger: Logger,
  media: MediaTools,
  transportStore?: Pick<GeminiVideoClientOptions, 'loadUnsupportedTransports' | 'onTransportRejected'>,
): VideoModelClient {
  if (config.gemini.mock) {
    logger.warn('GEMINI_MOCK=true: videos are synthesized locally, Google is never called');
    return new MockVideoClient({ config, logger, media });
  }
  return new GeminiVideoClient({ config, logger, ...transportStore });
}

export function createTextClient(config: AppConfig, logger: Logger): TextModelClient {
  if (config.gemini.mock) return new MockTextClient({ config });
  return new GeminiTextClient({ config, logger });
}
