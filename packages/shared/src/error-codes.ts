/**
 * Stable, client-facing error codes (TDD §5). Clients branch on `code`, never on `message`.
 */
export const ERROR_CODES = {
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  SOLD_OUT: 409,
  STATE_CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  BOOKING_CUTOFF: 422,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export function httpStatusFor(code: ErrorCode): number {
  return ERROR_CODES[code];
}
