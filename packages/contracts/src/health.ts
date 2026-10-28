import { z } from 'zod';

export const HealthResponse = z.object({
  status: z.literal('ok'),
  service: z.string(),
  version: z.string(),
  time: z.string(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

const CheckStatus = z.enum(['ok', 'error']);

export const ReadinessResponse = z.object({
  status: z.enum(['ok', 'unavailable']),
  checks: z.object({
    database: z.object({ status: CheckStatus, latencyMs: z.number().int().nonnegative() }),
  }),
});
export type ReadinessResponse = z.infer<typeof ReadinessResponse>;
