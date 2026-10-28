import { AppError } from './errors';

/**
 * Opaque keyset cursors. A cursor holds the sort key of the last item returned; the next page
 * continues strictly after it, so pages stay stable while rows are being inserted.
 */
export function encodeCursor(parts: readonly string[]): string {
  return Buffer.from(JSON.stringify(parts)).toString('base64url');
}

export function decodeCursor(cursor: string, expectedParts: number): string[] {
  try {
    const parts: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      Array.isArray(parts) &&
      parts.length === expectedParts &&
      parts.every((p) => typeof p === 'string')
    ) {
      return parts as string[];
    }
  } catch {
    // fall through
  }
  throw new AppError('VALIDATION_ERROR', 'Invalid cursor');
}

/** Callers fetch `limit + 1` rows; the extra row only signals that another page exists. */
export function toPage<T>(rows: T[], limit: number, cursorOf: (last: T) => readonly string[]) {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);
  return { items, nextCursor: hasMore && last ? encodeCursor(cursorOf(last)) : null };
}
