import { and, asc, eq, gt, ilike, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import {
  batches,
  catalogTreks,
  directLinks,
  organizers,
  organizerTreks,
  type Database,
} from '@ohviana/db';
import type {
  DirectLinkLanding,
  OrganizerSearchQuery,
  PublicBatch,
  PublicBatchQuery,
  PublicOrganizerDetail,
  PublicTrekDetail,
  PublicTrekSummary,
  BatchSearchQuery,
  TrekSearchQuery,
} from '@ohviana/contracts';
import { escapeLike } from '@ohviana/shared';
import { AppError, notFound } from '../../lib/errors';
import { mediaPaths } from '../media/service';
import { decodeCursor, toPage } from '../../lib/pagination';
import {
  batchCursorCondition,
  batchCursorParts,
  batchOrder,
  istWindow,
  toPublicBatches,
  visibleBatchConditions,
  visibleBatchesQuery,
  type Window,
} from './visibility';

/** Substring match, plus trigram word similarity so small typos ("kudremuk") still match. */
function fuzzyName(column: typeof catalogTreks.name | typeof organizers.name, q: string): SQL {
  return or(
    ilike(column, `%${escapeLike(q)}%`),
    sql`extensions.word_similarity(${q}, ${column}) > 0.5`,
  )!;
}

// ---------- Treks ----------

/** Per-catalog-trek availability over bookable batches in the window. */
function availabilityStats(db: Database, window: Window) {
  return db
    .select({
      catalogTrekId: organizerTreks.catalogTrekId,
      batchCount: sql<number>`count(*)::int`.as('batch_count'),
      organizerCount: sql<number>`count(distinct ${batches.organizerId})::int`.as(
        'organizer_count',
      ),
      minPricePaise: sql<number | null>`min(${batches.pricePaise})::int`.as('min_price_paise'),
      nextDepartureAt: sql<string | null>`min(${batches.departureAt})`.as('next_departure_at'),
    })
    .from(batches)
    .innerJoin(organizerTreks, eq(organizerTreks.id, batches.organizerTrekId))
    .innerJoin(organizers, eq(organizers.id, batches.organizerId))
    .innerJoin(catalogTreks, eq(catalogTreks.id, organizerTreks.catalogTrekId))
    .where(and(...visibleBatchConditions(window, true)))
    .groupBy(organizerTreks.catalogTrekId)
    .as('stats');
}

/**
 * Cover image for a catalog trek: a photo from an approved organizer's published offering,
 * preferring destination shots. Explicit aliases: correlated subquery inside a multi-join.
 */
function coverPhotoSql() {
  return sql<string | null>`(
    select tp.media_id from trek_photos tp
    join organizer_treks ot on ot.id = tp.organizer_trek_id
    join organizers o on o.id = ot.organizer_id
    where ot.catalog_trek_id = "catalog_treks"."id"
      and ot.status = 'published'
      and o.status = 'approved'
    order by (tp.category = 'destination') desc, tp.sort_order, tp.created_at
    limit 1
  )`;
}

async function queryTreks(db: Database, window: Window, filters: SQL[], limit: number) {
  const stats = availabilityStats(db, window);
  return db
    .select({
      trek: catalogTreks,
      batchCount: stats.batchCount,
      organizerCount: stats.organizerCount,
      minPricePaise: stats.minPricePaise,
      nextDepartureAt: stats.nextDepartureAt,
      coverMediaId: coverPhotoSql(),
    })
    .from(catalogTreks)
    .leftJoin(stats, eq(stats.catalogTrekId, catalogTreks.id))
    .where(and(eq(catalogTreks.status, 'published'), ...filters))
    .orderBy(asc(catalogTreks.name), asc(catalogTreks.id))
    .limit(limit);
}

type TrekRow = Awaited<ReturnType<typeof queryTreks>>[number];

function toTrekSummary(r: TrekRow): PublicTrekSummary {
  const t = r.trek;
  return {
    id: t.id,
    name: t.name,
    slug: t.slug,
    state: t.state,
    region: t.region,
    district: t.district,
    difficulty: t.difficulty,
    summary: t.summary,
    maxAltitudeM: t.maxAltitudeM,
    heroImageUrl: t.heroImageUrl,
    coverPhoto: r.coverMediaId ? mediaPaths(r.coverMediaId) : null,
    availability: {
      batchCount: r.batchCount ?? 0,
      organizerCount: r.organizerCount ?? 0,
      minPricePaise: r.minPricePaise ?? null,
      nextDepartureAt: r.nextDepartureAt ? new Date(r.nextDepartureAt).toISOString() : null,
    },
  };
}

/**
 * Trek search. Without dates every published trek is listed (with availability from now);
 * with dates only treks that have bookable departures in the window are returned.
 */
export async function searchTreks(db: Database, q: TrekSearchQuery) {
  const window = istWindow(q.from, q.to);
  const filters: SQL[] = [];
  if (q.query) filters.push(fuzzyName(catalogTreks.name, q.query));
  if (q.district) filters.push(ilike(catalogTreks.district, escapeLike(q.district)));
  if (q.difficulty) filters.push(eq(catalogTreks.difficulty, q.difficulty));
  if (q.from || q.to) filters.push(sql`stats.batch_count > 0`);
  if (q.cursor) {
    const [name, id] = decodeCursor(q.cursor, 2);
    filters.push(sql`(${catalogTreks.name}, ${catalogTreks.id}) > (${name}, ${id}::uuid)`);
  }
  const rows = await queryTreks(db, window, filters, q.limit + 1);
  const page = toPage(rows, q.limit, (r) => [r.trek.name, r.trek.id]);
  return { items: page.items.map(toTrekSummary), nextCursor: page.nextCursor };
}

export async function getTrek(db: Database, slug: string): Promise<PublicTrekDetail> {
  const [row] = await queryTreks(
    db,
    istWindow(undefined, undefined),
    [eq(catalogTreks.slug, slug)],
    1,
  );
  if (!row) throw notFound('Trek');
  return { ...toTrekSummary(row), description: row.trek.description };
}

// ---------- Batches ----------

async function listVisibleBatches(db: Database, q: PublicBatchQuery, scope: SQL) {
  const now = new Date();
  const window = istWindow(q.from, q.to, now);
  const filters = [...visibleBatchConditions(window, !q.includeUnavailable, now), scope];
  if (q.cursor) {
    filters.push(
      batchCursorCondition(q.sort, decodeCursor(q.cursor, q.sort === 'price_asc' ? 3 : 2)),
    );
  }
  const rows = await visibleBatchesQuery(db)
    .where(and(...filters))
    .orderBy(...batchOrder(q.sort))
    .limit(q.limit + 1);
  const page = toPage(rows, q.limit, (r) => batchCursorParts(q.sort, r));
  return { items: await toPublicBatches(db, page.items, now), nextCursor: page.nextCursor };
}

async function publishedTrekId(db: Database, slug: string): Promise<string> {
  const [trek] = await db
    .select({ id: catalogTreks.id })
    .from(catalogTreks)
    .where(and(eq(catalogTreks.slug, slug), eq(catalogTreks.status, 'published')));
  if (!trek) throw notFound('Trek');
  return trek.id;
}

/** Departures across every trek: the Explore page, grouped by day on the client. */
export async function searchBatches(db: Database, q: BatchSearchQuery) {
  const filters: SQL[] = [];
  if (q.query) {
    filters.push(
      or(
        fuzzyName(catalogTreks.name, q.query),
        fuzzyName(organizers.name, q.query),
        ilike(catalogTreks.district, `%${escapeLike(q.query)}%`),
        ilike(organizerTreks.title, `%${escapeLike(q.query)}%`),
      )!,
    );
  }
  if (q.district) filters.push(ilike(catalogTreks.district, escapeLike(q.district)));
  if (q.difficulty) filters.push(eq(catalogTreks.difficulty, q.difficulty));
  return listVisibleBatches(db, q, filters.length ? and(...filters)! : sql`true`);
}

/** Compare departures of one canonical trek across approved organizers. */
export async function trekBatches(db: Database, slug: string, q: PublicBatchQuery) {
  return listVisibleBatches(db, q, eq(catalogTreks.id, await publishedTrekId(db, slug)));
}

export async function getPublicBatch(db: Database, id: string): Promise<PublicBatch> {
  const now = new Date();
  const rows = await visibleBatchesQuery(db).where(
    and(...visibleBatchConditions({ start: now, end: null }, false, now), eq(batches.id, id)),
  );
  if (rows.length === 0) throw notFound('Batch');
  return (await toPublicBatches(db, rows, now))[0]!;
}

// ---------- Organizers ----------

/**
 * Correlated count of an organizer's bookable departures. Written with explicit aliases: in a
 * single-table select Drizzle emits unqualified column names, which would be ambiguous here.
 */
function upcomingBatchCount() {
  const now = new Date().toISOString();
  return sql<number>`(
    select count(*)::int from batches b
    join organizer_treks ot on ot.id = b.organizer_trek_id
    join catalog_treks ct on ct.id = ot.catalog_trek_id
    where b.organizer_id = "organizers"."id"
      and b.status = 'published'
      and ot.status = 'published'
      and ct.status = 'published'
      and b.departure_at >= ${now}::timestamptz
      and b.booking_cutoff_at > ${now}::timestamptz
      and b.confirmed_seats < b.capacity
  )`;
}

const organizerColumns = () => ({
  id: organizers.id,
  name: organizers.name,
  slug: organizers.slug,
  city: organizers.city,
  logoUrl: organizers.logoUrl,
  tagline: organizers.tagline,
  description: organizers.description,
  upcomingBatchCount: upcomingBatchCount(),
});

export async function searchOrganizers(db: Database, q: OrganizerSearchQuery) {
  const filters: SQL[] = [eq(organizers.status, 'approved')];
  if (q.query) filters.push(fuzzyName(organizers.name, q.query));
  if (q.cursor) {
    const [name, id] = decodeCursor(q.cursor, 2);
    filters.push(sql`(${organizers.name}, ${organizers.id}) > (${name}, ${id}::uuid)`);
  }
  const rows = await db
    .select(organizerColumns())
    .from(organizers)
    .where(and(...filters))
    .orderBy(asc(organizers.name), asc(organizers.id))
    .limit(q.limit + 1);
  return toPage(rows, q.limit, (r) => [r.name, r.id]);
}

export async function getOrganizer(db: Database, slug: string): Promise<PublicOrganizerDetail> {
  const [row] = await db
    .select({ ...organizerColumns(), createdAt: organizers.createdAt })
    .from(organizers)
    .where(and(eq(organizers.slug, slug), eq(organizers.status, 'approved')));
  if (!row) throw notFound('Organizer');
  const { createdAt, ...organizer } = row;

  // A departure counts once it went ahead (published or completed, not cancelled) and is over.
  const done = and(
    eq(batches.organizerId, row.id),
    inArray(batches.status, ['published', 'completed']),
    lt(batches.returnAt, new Date()),
  );
  const [[track], [offered]] = await Promise.all([
    db
      .select({
        completedBatches: sql<number>`count(*)::int`,
        trekkersHosted: sql<number>`coalesce(sum(${batches.confirmedSeats}), 0)::int`,
      })
      .from(batches)
      .where(done),
    db
      .select({ n: sql<number>`count(distinct ${organizerTreks.catalogTrekId})::int` })
      .from(organizerTreks)
      .where(and(eq(organizerTreks.organizerId, row.id), eq(organizerTreks.status, 'published'))),
  ]);
  return {
    ...organizer,
    stats: {
      completedBatches: track?.completedBatches ?? 0,
      trekkersHosted: track?.trekkersHosted ?? 0,
      treksOffered: offered?.n ?? 0,
      memberSince: createdAt.getUTCFullYear(),
    },
  };
}

export async function organizerBatches(db: Database, slug: string, q: PublicBatchQuery) {
  const organizer = await getOrganizer(db, slug);
  return listVisibleBatches(db, q, eq(organizers.id, organizer.id));
}

// ---------- Direct links ----------

const invalidLink = () => new AppError('NOT_FOUND', 'This booking link is no longer valid');

/**
 * Resolves a shared organizer link. Inactive, expired or unknown tokens, unapproved organizers
 * and unbookable batches all look the same (404) so tokens can't be probed.
 */
export async function directLanding(db: Database, token: string): Promise<DirectLinkLanding> {
  const now = new Date();
  const [link] = await db
    .select({
      organizerId: directLinks.organizerId,
      batchId: directLinks.batchId,
      slug: organizers.slug,
    })
    .from(directLinks)
    .innerJoin(organizers, eq(organizers.id, directLinks.organizerId))
    .where(
      and(
        eq(directLinks.token, token),
        eq(directLinks.active, true),
        or(isNull(directLinks.expiresAt), gt(directLinks.expiresAt, now)),
        eq(organizers.status, 'approved'),
      ),
    );
  if (!link) throw invalidLink();

  const organizer = await getOrganizer(db, link.slug);
  if (link.batchId) {
    const rows = await visibleBatchesQuery(db).where(
      and(
        ...visibleBatchConditions({ start: now, end: null }, false, now),
        eq(batches.id, link.batchId),
        eq(batches.organizerId, link.organizerId),
      ),
    );
    if (rows.length === 0) throw invalidLink();
    return { organizer, batch: (await toPublicBatches(db, rows, now))[0]!, batches: [] };
  }

  const list = await listVisibleBatches(
    db,
    { limit: 50, sort: 'departure_asc', includeUnavailable: false },
    eq(organizers.id, link.organizerId),
  );
  return { organizer, batch: null, batches: list.items };
}
