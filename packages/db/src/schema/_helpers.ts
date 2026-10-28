import { sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { timestamp, uuid } from 'drizzle-orm/pg-core';

export const id = () => uuid('id').primaryKey().defaultRandom();

export const createdAt = () =>
  timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow();

export const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

export const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/** `col IN ('a','b')` for CHECK constraints, built from the shared TypeScript enum arrays. */
export function inList(column: AnyColumn, values: readonly string[]): SQL {
  const list = values.map((v) => `'${v.replace(/'/g, "''")}'`).join(', ');
  return sql`${column} in (${sql.raw(list)})`;
}

/** Lowercase kebab-case slug, enforced in the database as well as in API validation. */
export function isSlug(column: AnyColumn): SQL {
  return sql`${column} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`;
}
