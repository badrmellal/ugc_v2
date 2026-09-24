import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../../app-context.js';

/** An onRequest hook that throws a 429 `rate_limited` HttpError when its limit is exceeded. */
export type LimitHook = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface RouteDeps {
  ctx: AppContext;
  authEnabled: boolean;
  /** Seconds per Omni turn used for ETAs and live progress. */
  turnSeconds: number;
  /** Shared hourly limit for POST /api/generations and /regenerate. */
  createLimit: LimitHook;
  /** Hourly limit for POST /api/plan. */
  planLimit: LimitHook;
}
