import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_HOST: z.string().default('::'), // dual-stack: 'localhost' resolves to ::1 first on Windows
  API_PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:3000')
    .transform((s) =>
      s
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean),
    ),
  APP_VERSION: z.string().default('0.1.0'),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
  /** e.g. https://<project-ref>.supabase.co — used to verify access tokens via its JWKS. */
  SUPABASE_URL: z.url({ protocol: /^https?$/ }),
  RATE_LIMIT_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  RATE_LIMIT_GLOBAL_MAX: z.coerce.number().int().positive().default(300),
  /** Trust X-Forwarded-For (only when running behind a known proxy/load balancer). */
  TRUST_PROXY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /** Secret for /internal/metrics (x-metrics-token header); unset disables the endpoint. */
  METRICS_TOKEN: z.string().min(16).optional(),
  /**
   * `supabase` (default): Supabase access tokens. `dev`: TEMPORARY testing mode that also accepts
   * an `x-dev-user: <email>` header with no password. Refused when NODE_ENV=production.
   */
  AUTH_MODE: z.enum(['supabase', 'dev']).default('supabase'),
  /**
   * Signs session tokens for email + password sign-in (32+ random characters). Without it the
   * password endpoints are off and only Supabase tokens are accepted.
   */
  AUTH_JWT_SECRET: z.string().min(32).optional(),
  /**
   * How phone sign-in codes are delivered. `log` (TEMPORARY, until an SMS provider is
   * connected): the code is written to the API log instead of being sent.
   */
  SMS_PROVIDER: z.enum(['log']).default('log'),
  /** Testing only: every sign-in code is this 6-digit value. Refused when NODE_ENV=production. */
  OTP_DEV_CODE: z
    .string()
    .regex(/^\d{6}$/)
    .optional(),
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Hosts such as Vercel tell the server which port to use via PORT.
  const parsed = EnvSchema.safeParse({ ...env, API_PORT: env.API_PORT ?? env.PORT });
  if (!parsed.success) {
    // Fail fast at boot: a misconfigured API must never start serving traffic.
    throw new Error(`Invalid environment configuration:\n${z.prettifyError(parsed.error)}`);
  }
  if (parsed.data.AUTH_MODE === 'dev' && parsed.data.NODE_ENV === 'production') {
    throw new Error('AUTH_MODE=dev (password-less testing login) is not allowed in production');
  }
  if (parsed.data.OTP_DEV_CODE && parsed.data.NODE_ENV === 'production') {
    throw new Error('OTP_DEV_CODE (fixed sign-in code) is not allowed in production');
  }
  return parsed.data;
}
