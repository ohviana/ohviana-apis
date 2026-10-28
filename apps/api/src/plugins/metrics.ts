import { timingSafeEqual } from 'node:crypto';
import fp from 'fastify-plugin';
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';
import { outboxStats } from '../worker/maintenance';
import { notFound } from '../lib/errors';

declare module 'fastify' {
  interface FastifyInstance {
    metrics: {
      bookingsCreated: Counter<'source'>;
      bookingsRejected: Counter<'reason'>;
    };
  }
}

export interface MetricsOptions {
  /** Secret for /internal/metrics (x-metrics-token header). Without it the endpoint is off. */
  token?: string | undefined;
}

/** Own header: Authorization is reserved for user access tokens (verified on every request). */
export const METRICS_HEADER = 'x-metrics-token';

function tokenOk(header: string | string[] | undefined, token: string): boolean {
  const given = Buffer.from(typeof header === 'string' ? header : '');
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * Prometheus metrics (TDD §7): request rate/latency/errors per route pattern, booking outcomes,
 * outbox backlog and dead letters, plus Node process metrics. One registry per app instance.
 */
export default fp<MetricsOptions>(
  async (app, opts) => {
    const registry = new Registry();
    collectDefaultMetrics({ register: registry });

    const requests = new Counter({
      name: 'http_requests_total',
      help: 'HTTP requests by route pattern and status',
      labelNames: ['method', 'route', 'status'] as const,
      registers: [registry],
    });
    const duration = new Histogram({
      name: 'http_request_duration_seconds',
      help: 'HTTP request latency by route pattern',
      labelNames: ['method', 'route'] as const,
      buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [registry],
    });
    const bookingsCreated = new Counter({
      name: 'bookings_created_total',
      help: 'Confirmed bookings by attribution source',
      labelNames: ['source'] as const,
      registers: [registry],
    });
    const bookingsRejected = new Counter({
      name: 'bookings_rejected_total',
      help: 'Booking attempts refused (sold_out, booking_cutoff, ...)',
      labelNames: ['reason'] as const,
      registers: [registry],
    });
    const outbox = new Gauge({
      name: 'outbox_events',
      help: 'Outbox backlog: pending, dead (parked) and oldest pending age in seconds',
      labelNames: ['state'] as const,
      registers: [registry],
      async collect() {
        try {
          const s = await outboxStats(app.db);
          this.set({ state: 'pending' }, s.pending);
          this.set({ state: 'dead' }, s.dead);
          this.set({ state: 'oldest_pending_seconds' }, s.oldestPendingSeconds);
        } catch {
          // Scrape still succeeds; DB health has its own probe.
        }
      },
    });
    void outbox;

    app.decorate('metrics', { bookingsCreated, bookingsRejected });

    app.addHook('onResponse', async (request, reply) => {
      const route = request.routeOptions.url ?? 'unmatched';
      if (route === '/internal/metrics') return;
      requests.inc({ method: request.method, route, status: String(reply.statusCode) });
      duration.observe({ method: request.method, route }, reply.elapsedTime / 1000);
    });

    app.get('/internal/metrics', { schema: { hide: true } }, async (request, reply) => {
      if (!opts.token || !tokenOk(request.headers[METRICS_HEADER], opts.token))
        throw notFound('Route');
      return reply.header('content-type', registry.contentType).send(await registry.metrics());
    });
  },
  { name: 'metrics', dependencies: ['db'] },
);
