import { and, asc, eq, ilike, sql, type SQL } from 'drizzle-orm';
import { catalogTreks, pgConstraintName, type Database, type Tx } from '@ohviana/db';
import type {
  AdminCatalogTrekListQuery,
  CatalogTrek,
  CreateCatalogTrekRequest,
  UpdateCatalogTrekRequest,
} from '@ohviana/contracts';
import { escapeLike, slugify } from '@ohviana/shared';
import { AppError, conflict, notFound } from '../../lib/errors';
import { decodeCursor, toPage } from '../../lib/pagination';

type Executor = Database | Tx;
type Row = typeof catalogTreks.$inferSelect;

export function toCatalogTrekDto(row: Row): CatalogTrek {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    state: row.state,
    region: row.region,
    district: row.district,
    difficulty: row.difficulty,
    summary: row.summary,
    description: row.description,
    maxAltitudeM: row.maxAltitudeM,
    heroImageUrl: row.heroImageUrl,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function rethrowSlugConflict(err: unknown, slug: string | undefined): never {
  if (pgConstraintName(err) === 'catalog_treks_slug_uq') {
    throw conflict(`A catalog trek with slug "${slug}" already exists`);
  }
  throw err;
}

export async function createCatalogTrek(
  db: Executor,
  input: CreateCatalogTrekRequest,
): Promise<Row> {
  const slug = input.slug ?? slugify(input.name);
  if (slug.length < 2) {
    throw new AppError('VALIDATION_ERROR', 'Could not derive a slug from the name; provide one');
  }
  try {
    const [row] = await db
      .insert(catalogTreks)
      .values({ ...input, slug, status: input.status ?? 'draft' })
      .returning();
    return row!;
  } catch (err) {
    rethrowSlugConflict(err, slug);
  }
}

export async function updateCatalogTrek(
  db: Executor,
  id: string,
  input: UpdateCatalogTrekRequest,
): Promise<{ before: Row; after: Row }> {
  const before = await getCatalogTrekRow(db, id);
  try {
    const [after] = await db
      .update(catalogTreks)
      .set(input)
      .where(eq(catalogTreks.id, id))
      .returning();
    return { before, after: after! };
  } catch (err) {
    rethrowSlugConflict(err, input.slug);
  }
}

export async function getCatalogTrekRow(db: Executor, id: string): Promise<Row> {
  const [row] = await db.select().from(catalogTreks).where(eq(catalogTreks.id, id));
  if (!row) throw notFound('Catalog trek');
  return row;
}

/** Ordered by name, then id, with keyset pagination on that pair. */
export async function listCatalogTreks(db: Executor, q: AdminCatalogTrekListQuery) {
  const filters: SQL[] = [];
  if (q.status) filters.push(eq(catalogTreks.status, q.status));
  if (q.query) filters.push(ilike(catalogTreks.name, `%${escapeLike(q.query)}%`));
  if (q.cursor) {
    const [name, id] = decodeCursor(q.cursor, 2);
    filters.push(sql`(${catalogTreks.name}, ${catalogTreks.id}) > (${name}, ${id}::uuid)`);
  }

  const rows = await db
    .select()
    .from(catalogTreks)
    .where(and(...filters))
    .orderBy(asc(catalogTreks.name), asc(catalogTreks.id))
    .limit(q.limit + 1);

  const page = toPage(rows, q.limit, (r) => [r.name, r.id]);
  return { items: page.items.map(toCatalogTrekDto), nextCursor: page.nextCursor };
}

/** Fields that changed between two rows, for audit payloads. */
export function changedFields<T extends Record<string, unknown>>(
  before: T,
  after: T,
  keys: readonly (keyof T)[],
) {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of keys) {
    const a = before[k];
    const b = after[k];
    const same = a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b;
    if (!same) changes[String(k)] = { from: a, to: b };
  }
  return changes;
}
