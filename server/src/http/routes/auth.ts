import type { FastifyInstance } from 'fastify';
import type { SessionResponse } from '../../shared/api.js';
import { clearSessionCookie, passwordMatches, SESSION_SUBJECT, setSessionCookie } from '../auth.js';
import { HttpError } from '../errors.js';
import { loginSchema } from '../schemas.js';
import type { RouteDeps } from './types.js';

export function registerAuthRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { config } = deps.ctx;
  const enabled = deps.authEnabled;

  app.get('/api/auth/session', async (req): Promise<SessionResponse> => {
    if (!enabled) return { authenticated: true, authRequired: false, user: null };
    return { authenticated: Boolean(req.auth), authRequired: true, user: req.auth?.subject ?? null };
  });

  app.post(
    '/api/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: 60_000 } } },
    async (req, reply): Promise<SessionResponse> => {
      const { password } = loginSchema.parse(req.body ?? {});
      if (!enabled) return { authenticated: true, authRequired: false, user: null };
      if (!config.auth.password) {
        throw new HttpError(401, 'unauthorized', 'Password sign-in is not enabled on this server. Use an API token.');
      }
      if (!passwordMatches(password, config.auth.password)) {
        req.log.warn({ ip: req.ip }, 'failed sign-in attempt');
        throw new HttpError(401, 'unauthorized', 'Incorrect password.');
      }
      setSessionCookie(req, reply, config);
      return { authenticated: true, authRequired: true, user: SESSION_SUBJECT };
    },
  );

  app.post('/api/auth/logout', async (req, reply) => {
    clearSessionCookie(req, reply, config);
    return reply.code(204).send();
  });
}
