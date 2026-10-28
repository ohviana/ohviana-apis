/** Name of the violated constraint for a Postgres error (raw or wrapped by Drizzle), if any. */
export function pgConstraintName(err: unknown): string | undefined {
  const e = err as { constraint_name?: string; cause?: { constraint_name?: string } };
  return e.constraint_name ?? e.cause?.constraint_name;
}

/** SQLSTATE of a Postgres error (raw or wrapped by Drizzle), e.g. 23503 = foreign key violation. */
export function pgErrorCode(err: unknown): string | undefined {
  const e = err as { code?: unknown; cause?: { code?: unknown } };
  const code = e.cause?.code ?? e.code;
  return typeof code === 'string' ? code : undefined;
}

export const PG_FOREIGN_KEY_VIOLATION = '23503';
export const PG_UNIQUE_VIOLATION = '23505';
export const PG_CHECK_VIOLATION = '23514';
