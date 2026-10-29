import { randomUUID } from 'node:crypto';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyServerOptions,
  type RawReplyDefaultExpression,
  type RawRequestDefaultExpression,
  type RawServerDefault,
} from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { DbClient } from '@ohviana/db';
import { createLogOtpSender, type OtpSender } from './auth/sms';
import {
  createCompositeVerifier,
  createSupabaseVerifier,
  type TokenVerifier,
} from './auth/verifier';
import type { Config } from './config';
import { adminRoutes } from './modules/admin/routes';
import { authRoutes } from './modules/auth/routes';
import { bookingRoutes, organizerBookingRoutes } from './modules/bookings/routes';
import { mediaRoutes } from './modules/media/routes';
import { meRoutes } from './modules/me/routes';
import { organizerRegistrationRoutes, organizerRoutes } from './modules/organizer/routes';
import { publicRoutes } from './modules/public/routes';
import { adminReviewRoutes, organizerReviewRoutes, reviewRoutes } from './modules/reviews/routes';
import authPlugin from './plugins/auth';
import dbPlugin from './plugins/db';
import { MAX_UPLOAD_BYTES } from './lib/images';
import errorHandler from './plugins/error-handler';
import metricsPlugin from './plugins/metrics';
import rateLimitPlugin from './plugins/rate-limit';
import { healthRoutes } from './routes/health';

const REQUEST_ID_HEADER = 'x-request-id';
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{8,128}$/;

export type App = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  FastifyBaseLogger,
  ZodTypeProvider
>;

export interface BuildAppOptions {
  /** Hook for tests and later phases to register extra routes before the app is sealed. */
  register?: (app: App) => Promise<void> | void;
  /** Use an existing DB client instead of opening a pool from DATABASE_URL. */
  dbClient?: DbClient;
  /** Override access-token verification (tests sign tokens with a local key). */
  verifier?: TokenVerifier;
  /** Override how phone sign-in codes are delivered (tests capture them). */
  otpSender?: OtpSender;
}

export async function buildApp(config: Config, opts: BuildAppOptions = {}): Promise<App> {
  const logger: FastifyServerOptions['logger'] = {
    level: config.LOG_LEVEL,
    // Never log credentials or customer PII (TDD §7).
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        '*.phone',
        '*.email',
        '*.contact',
        '*.guests',
      ],
      censor: '[redacted]',
    },
    ...(config.NODE_ENV === 'development'
      ? { transport: { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss' } } }
      : {}),
  };

  const app = Fastify({
    logger,
    trustProxy: config.TRUST_PROXY,
    genReqId: (req) => {
      const incoming = req.headers[REQUEST_ID_HEADER];
      return typeof incoming === 'string' && SAFE_REQUEST_ID.test(incoming)
        ? incoming
        : randomUUID();
    },
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.addHook('onSend', async (request, reply) => {
    reply.header(REQUEST_ID_HEADER, request.id);
  });

  await app.register(errorHandler);
  await app.register(dbPlugin, {
    url: config.DATABASE_URL,
    poolMax: config.DB_POOL_MAX,
    ...(opts.dbClient ? { client: opts.dbClient } : {}),
  });
  await app.register(authPlugin, {
    // Our own email + password sessions, plus Supabase tokens (kept for a later switch back).
    verifier: createCompositeVerifier({
      sessionSecret: config.AUTH_JWT_SECRET,
      supabase: opts.verifier ?? createSupabaseVerifier(config.SUPABASE_URL),
    }),
    devLogin: config.AUTH_MODE === 'dev',
  });
  if (config.AUTH_MODE === 'dev') {
    app.log.warn('AUTH_MODE=dev: password-less x-dev-user login is ON (testing only)');
  }
  if (config.AUTH_JWT_SECRET && config.SMS_PROVIDER === 'log' && !opts.otpSender) {
    app.log.warn('SMS_PROVIDER=log: phone sign-in codes are written to this log, not sent');
  }
  await app.register(metricsPlugin, { token: config.METRICS_TOKEN });
  await app.register(rateLimitPlugin, {
    enabled: config.RATE_LIMIT_ENABLED,
    globalMax: config.RATE_LIMIT_GLOBAL_MAX,
  });
  await app.register(helmet);
  await app.register(cors, {
    origin: config.CORS_ORIGINS,
    credentials: true,
    // @fastify/cors defaults to GET/HEAD/POST only; browsers would block every edit otherwise.
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
    // Browsers hide non-safelisted response headers cross-origin unless listed here
    // (content-disposition carries the attendee CSV's file name).
    exposedHeaders: [
      REQUEST_ID_HEADER,
      'retry-after',
      'idempotent-replayed',
      'content-disposition',
    ],
  });

  // Photo uploads: one file per request, size-capped before it reaches our code.
  await app.register(multipart, {
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 5, fieldSize: 1000 },
  });

  await app.register(swagger, {
    openapi: {
      info: { title: 'Ohviana API', version: config.APP_VERSION },
      components: {
        securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
      },
    },
    transform: jsonSchemaTransform,
  });
  if (config.NODE_ENV !== 'production') {
    await app.register(swaggerUi, { routePrefix: '/docs' });
  }

  await app.register(healthRoutes, { prefix: '/v1', version: config.APP_VERSION });
  if (config.AUTH_JWT_SECRET) {
    await app.register(authRoutes, {
      prefix: '/v1',
      secret: config.AUTH_JWT_SECRET,
      otpSender: opts.otpSender ?? createLogOtpSender(app.log),
      otpDevCode: config.OTP_DEV_CODE,
    });
  }
  await app.register(meRoutes, { prefix: '/v1' });
  await app.register(adminRoutes, { prefix: '/v1/admin' });
  await app.register(organizerRegistrationRoutes, { prefix: '/v1' });
  await app.register(organizerRoutes, { prefix: '/v1/organizer' });
  await app.register(publicRoutes, { prefix: '/v1' });
  await app.register(mediaRoutes, { prefix: '/v1' });
  await app.register(bookingRoutes, { prefix: '/v1' });
  await app.register(organizerBookingRoutes, { prefix: '/v1/organizer' });
  await app.register(reviewRoutes, { prefix: '/v1' });
  await app.register(organizerReviewRoutes, { prefix: '/v1/organizer' });
  await app.register(adminReviewRoutes, { prefix: '/v1/admin' });

  await opts.register?.(app);

  return app;
}
