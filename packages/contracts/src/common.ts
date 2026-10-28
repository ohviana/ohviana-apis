import { z } from 'zod';
import { ERROR_CODES, type ErrorCode } from '@ohviana/shared';

/** Request/response schemas shared by API (validation + OpenAPI) and clients (typed SDK). */

export const Uuid = z.uuid();

/** ISO-8601 UTC timestamp string, e.g. 2026-10-14T12:15:00Z */
export const IsoDateTime = z.iso.datetime({ offset: false });

export const Paise = z.number().int().nonnegative();

export const Slug = z
  .string()
  .min(2)
  .max(120)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug must be lowercase kebab-case');

export const PaginationQuery = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type PaginationQuery = z.infer<typeof PaginationQuery>;

export function paginated<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
  });
}

const errorCodeValues = Object.keys(ERROR_CODES) as [ErrorCode, ...ErrorCode[]];

export const ErrorResponse = z.object({
  error: z.object({
    code: z.enum(errorCodeValues),
    message: z.string(),
    requestId: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ErrorResponse = z.infer<typeof ErrorResponse>;
