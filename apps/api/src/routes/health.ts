import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { HealthResponse, ReadinessResponse } from '@ohviana/contracts';

const READINESS_TIMEOUT_MS = 5_000;

export const healthRoutes: FastifyPluginAsyncZod<{ version: string }> = async (app, opts) => {
  app.get(
    '/health',
    {
      schema: {
        tags: ['system'],
        summary: 'Liveness probe (process is up; no dependencies checked)',
        response: { 200: HealthResponse },
      },
    },
    async () => ({
      status: 'ok' as const,
      service: 'ohviana-api',
      version: opts.version,
      time: new Date().toISOString(),
    }),
  );

  app.get(
    '/health/ready',
    {
      schema: {
        tags: ['system'],
        summary: 'Readiness probe (database reachable)',
        response: { 200: ReadinessResponse, 503: ReadinessResponse },
      },
    },
    async (request, reply) => {
      const started = performance.now();
      let ok = true;
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          app.dbClient.ping(),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('Database ping timed out')),
              READINESS_TIMEOUT_MS,
            );
          }),
        ]);
      } catch (err) {
        ok = false;
        request.log.error({ err }, 'Readiness check failed');
      } finally {
        clearTimeout(timer);
      }
      const latencyMs = Math.round(performance.now() - started);
      return reply.status(ok ? 200 : 503).send({
        status: ok ? 'ok' : 'unavailable',
        checks: { database: { status: ok ? 'ok' : 'error', latencyMs } },
      });
    },
  );
};
