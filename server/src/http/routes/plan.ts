import type { FastifyInstance } from 'fastify';
import type { ScriptSplitResult } from '../../core/ports.js';
import { redactSecrets } from '../../pipeline/errors.js';
import { estimateCost } from '../../pricing/pricing.js';
import type { CostBreakdown, ScriptPlan } from '../../shared/api.js';
import { HttpError } from '../errors.js';
import { estimateRequestSchema, planRequestSchema } from '../schemas.js';
import type { RouteDeps } from './types.js';

export function registerPlanRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { ctx } = deps;

  app.post('/api/plan', { onRequest: deps.planLimit }, async (req): Promise<ScriptPlan> => {
    const body = planRequestSchema.parse(req.body ?? {});
    let result: ScriptSplitResult;
    try {
      result = await ctx.planner.split({ script: body.script, settings: body.settings });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      req.log.error({ error: redactSecrets(message, [ctx.config.gemini.apiKey]) }, 'script split failed');
      throw new HttpError(
        502,
        'splitter_failed',
        'The script could not be split into two parts right now. Try again, or generate directly: the server splits the script automatically.',
      );
    }
    if (result.model !== null) {
      // Billable text-model call: keep it in the spend ledger (not tied to a generation yet).
      await ctx.repo
        .recordApiCall({
          generationId: null,
          kind: 'split',
          model: result.model,
          interactionId: null,
          status: 'completed',
          usage: result.usage,
          costUsd: result.costUsd,
          costBasis: result.usage ? 'actual' : 'estimate',
        })
        .catch((err: unknown) => req.log.warn({ err }, 'failed to record the split call in the ledger'));
    }
    return result.plan;
  });

  app.post('/api/estimate', async (req): Promise<CostBreakdown> => {
    const body = estimateRequestSchema.parse(req.body ?? {});
    const mode = body.mode ?? 'full';
    return estimateCost(ctx.config.pricing, {
      resolution: body.settings.resolution,
      mode,
      needsSplit: mode !== 'part2',
      reinforceCharacterOnExtend: body.settings.reinforceCharacterOnExtend ?? false,
    });
  });
}
