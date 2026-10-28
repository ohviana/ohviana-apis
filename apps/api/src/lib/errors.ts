import { httpStatusFor, type ErrorCode } from '@ohviana/shared';

/**
 * Domain error carrying a stable client-facing code. Throw this from services/routes;
 * the error-handler plugin renders it as `{ error: { code, message, requestId } }`.
 */
export class AppError extends Error {
  readonly statusCode: number;

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
    this.statusCode = httpStatusFor(code);
  }
}

export const notFound = (what: string) => new AppError('NOT_FOUND', `${what} not found`);
export const forbidden = (message = 'You do not have access to this resource') =>
  new AppError('FORBIDDEN', message);
export const conflict = (message: string) => new AppError('STATE_CONFLICT', message);
export const badRequest = (message: string, details?: unknown) =>
  new AppError('VALIDATION_ERROR', message, details);
