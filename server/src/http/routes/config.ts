import type { FastifyInstance } from 'fastify';
import {
  DEFAULT_SETTINGS,
  LIMITS,
  RESOLUTIONS,
  VIDEO_STYLES,
  type AppConfigResponse,
  type PricingInfo,
} from '../../shared/api.js';
import { startOfUtcDay } from '../budget.js';
import type { RouteDeps } from './types.js';

const round4 = (n: number) => Math.round(n * 1e4) / 1e4;

export function registerConfigRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { ctx } = deps;
  const { config } = ctx;
  const p = config.pricing;
  // Only the public price list; token rates used internally stay on the server.
  const pricing: PricingInfo = {
    videoOutputUsdPerSecond: { ...p.videoOutputUsdPerSecond },
    videoOutputUsdPerMillionTokens: p.videoOutputUsdPerMillionTokens,
    inputUsdPerMillionTokens: p.inputUsdPerMillionTokens,
    textOutputUsdPerMillionTokens: p.textOutputUsdPerMillionTokens,
    splitterUsdPerCallEstimate: p.splitterUsdPerCallEstimate,
    extensionBilling: p.extensionBilling,
    source: p.source,
  };

  app.get('/api/config', async (): Promise<AppConfigResponse> => {
    const spend = await ctx.repo.spendSince(startOfUtcDay());
    return {
      mock: config.gemini.mock,
      models: { video: config.gemini.videoModel, splitter: config.gemini.splitterModel },
      pricing,
      defaults: { ...DEFAULT_SETTINGS },
      limits: LIMITS,
      resolutions: RESOLUTIONS,
      styles: VIDEO_STYLES,
      budget: {
        dailyLimitUsd: config.budget.dailyUsd,
        spentTodayUsd: round4(spend.spentUsd),
        reservedUsd: round4(spend.reservedUsd),
      },
      authRequired: deps.authEnabled,
    };
  });
}
