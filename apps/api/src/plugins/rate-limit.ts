import fp from 'fastify-plugin';
import rateLimit from '@fastify/rate-limit';
import { AppError } from '../lib/errors';

/** Per-route overrides, attached as `config: { rateLimit: LIMITS.x }`. */
export const LIMITS = {
  /** Seat holds are the expensive, abusable path. */
  booking: { max: 20, timeWindow: '1 minute' },
  /** Organizer registration: a handful per hour is plenty for humans. */
  registration: { max: 5, timeWindow: '1 hour' },
  /** Anonymous search/discovery. */
  search: { max: 120, timeWindow: '1 minute' },
} as const;

export interface RateLimitOptions {
  enabled: boolean;
  /** Default for every route without an override. */
  globalMax: number;
}

/**
 * In-memory, per-process limits keyed by client IP (set TRUST_PROXY behind a load balancer).
 * For several API instances, give @fastify/rate-limit a shared Redis store.
 */
export default fp<RateLimitOptions>(
  async (app, opts) => {
    if (!opts.enabled) return;
    await app.register(rateLimit, {
      global: true,
      max: opts.globalMax,
      timeWindow: '1 minute',
      // Thrown, so the standard error envelope is used ({ error: { code: 'RATE_LIMITED' } }).
      errorResponseBuilder: (_request, context) =>
        new AppError(
          'RATE_LIMITED',
          `Too many requests. Try again in ${Math.ceil(context.ttl / 1000)}s.`,
        ),
      allowList: (request) => request.url.startsWith('/v1/health'),
    });

    // @fastify/rate-limit appends its check after a route's own onRequest hooks, so our auth
    // guards would reject anonymous floods (401) before they are ever counted. This onRoute
    // hook runs right after the plugin's and moves its handler (the last entry) to the front.
    // Covered by test/hardening.test.ts.
    app.addHook('onRoute', (route) => {
      if (route.config?.rateLimit === false) return;
      const hooks = route.onRequest;
      if (Array.isArray(hooks) && hooks.length > 1) {
        route.onRequest = [hooks[hooks.length - 1]!, ...hooks.slice(0, -1)];
      }
    });
  },
  { name: 'rate-limit' },
);
