import fp from 'fastify-plugin';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import type { ErrorCode } from '@ohviana/shared';
import type { ErrorResponse } from '@ohviana/contracts';
import { AppError } from '../lib/errors';

function send(
  reply: FastifyReply,
  request: FastifyRequest,
  status: number,
  code: ErrorCode,
  message: string,
  details?: unknown,
) {
  const body: ErrorResponse = {
    error: { code, message, requestId: request.id, ...(details === undefined ? {} : { details }) },
  };
  return reply.status(status).send(body);
}

function codeForStatus(status: number): ErrorCode {
  switch (status) {
    case 401:
      return 'UNAUTHENTICATED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'STATE_CONFLICT';
    case 429:
      return 'RATE_LIMITED';
    default:
      return 'VALIDATION_ERROR';
  }
}

/** Uniform error envelope for every failure path (TDD §5 "Standard errors"). */
export default fp(
  async (app) => {
    app.setNotFoundHandler((request, reply) =>
      send(reply, request, 404, 'NOT_FOUND', `Route ${request.method} ${request.url} not found`),
    );

    app.setErrorHandler((error: FastifyError, request, reply) => {
      if (error instanceof AppError) {
        return send(reply, request, error.statusCode, error.code, error.message, error.details);
      }

      if (hasZodFastifySchemaValidationErrors(error)) {
        return send(reply, request, 400, 'VALIDATION_ERROR', 'Request validation failed', {
          issues: error.validation.map((v) => ({
            path: v.instancePath,
            message: v.message,
          })),
          context: error.validationContext,
        });
      }

      const status = error.statusCode ?? 500;
      if (status >= 400 && status < 500) {
        return send(reply, request, status, codeForStatus(status), error.message);
      }

      request.log.error({ err: error }, 'Unhandled error');
      return send(reply, request, 500, 'INTERNAL_ERROR', 'Something went wrong');
    });
  },
  { name: 'error-handler' },
);
