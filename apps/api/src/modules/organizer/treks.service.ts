import { and, asc, desc, eq, gt, inArray, or, sql } from 'drizzle-orm';
import {
  batches,
  catalogTrekRequests,
  catalogTreks,
  organizerTreks,
  pgConstraintName,
  pgErrorCode,
  PG_FOREIGN_KEY_VIOLATION,
  pickupPoints,
  type Database,
  type Tx,
} from '@ohviana/db';
import type {
  CreateCatalogRequestRequest,
  CreateOrganizerTrekRequest,
  CreatePickupPointRequest,
  OrganizerTrek,
  PickupPoint,
  UpdateOrganizerTrekRequest,
  UpdatePickupPointRequest,
} from '@ohviana/contracts';
import { slugify, type ContentStatus, type Difficulty } from '@ohviana/shared';
import type { z } from 'zod';
import { enqueueEvent } from '../../lib/audit';
import { loadTrekPhotos } from '../media/service';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { insertBatches, publishBatchTx, validateTimes } from './batches.service';

type Executor = Database | Tx;
type TrekRow = typeof organizerTreks.$inferSelect;

// ---------- Catalog requests ----------

export async function createCatalogRequest(
  db: Database,
  organizerId: string,
  userId: string,
  input: CreateCatalogRequestRequest,
) {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(catalogTrekRequests)
      .values({ ...input, organizerId, requestedBy: userId })
      .returning();
    await enqueueEvent(tx, 'catalog_request.created', {
      requestId: row!.id,
      organizerId,
      name: row!.name,
    });
    return toCatalogRequestDto(row!);
  });
}

export async function listCatalogRequests(db: Database, organizerId: string) {
  const rows = await db
    .select()
    .from(catalogTrekRequests)
    .where(eq(catalogTrekRequests.organizerId, organizerId))
    .orderBy(desc(catalogTrekRequests.createdAt));
  return rows.map(toCatalogRequestDto);
}

function toCatalogRequestDto(r: typeof catalogTrekRequests.$inferSelect) {
  return {
    id: r.id,
    name: r.name,
    state: r.state,
    region: r.region,
    district: r.district,
    notes: r.notes,
    status: r.status,
    catalogTrekId: r.catalogTrekId,
    reviewNote: r.reviewNote,
    createdAt: r.createdAt.toISOString(),
  };
}

// ---------- Trek templates ----------

async function loadPickups(db: Executor, trekIds: string[]): Promise<Map<string, PickupPoint[]>> {
  const map = new Map<string, PickupPoint[]>();
  if (trekIds.length === 0) return map;
  const rows = await db
    .select()
    .from(pickupPoints)
    .where(inArray(pickupPoints.organizerTrekId, trekIds))
    .orderBy(asc(pickupPoints.sortOrder), asc(pickupPoints.name));
  for (const r of rows) {
    const list = map.get(r.organizerTrekId) ?? [];
    list.push({
      id: r.id,
      name: r.name,
      address: r.address,
      landmark: r.landmark,
      mapsUrl: r.mapsUrl,
      sortOrder: r.sortOrder,
    });
    map.set(r.organizerTrekId, list);
  }
  return map;
}

async function toTrekDtos(db: Executor, rows: TrekRow[]): Promise<OrganizerTrek[]> {
  const catalogIds = [...new Set(rows.map((r) => r.catalogTrekId).filter((x): x is string => !!x))];
  const names = new Map(
    catalogIds.length
      ? (
          await db
            .select({ id: catalogTreks.id, name: catalogTreks.name })
            .from(catalogTreks)
            .where(inArray(catalogTreks.id, catalogIds))
        ).map((c) => [c.id, c.name])
      : [],
  );
  const ids = rows.map((r) => r.id);
  const [pickups, photos] = await Promise.all([loadPickups(db, ids), loadTrekPhotos(db, ids)]);
  return rows.map((r) => ({
    id: r.id,
    catalogTrekId: r.catalogTrekId,
    catalogTrekName: r.catalogTrekId ? (names.get(r.catalogTrekId) ?? null) : null,
    catalogTrekRequestId: r.catalogTrekRequestId,
    title: r.title,
    slug: r.slug,
    summary: r.summary,
    durationDays: r.durationDays,
    difficulty: r.difficulty,
    maxAltitudeM: r.maxAltitudeM,
    startPoint: r.startPoint,
    itinerary: r.itinerary,
    inclusions: r.inclusions,
    exclusions: r.exclusions,
    thingsToCarry: r.thingsToCarry,
    cancellationPolicy: r.cancellationPolicy,
    status: r.status,
    pickupPoints: pickups.get(r.id) ?? [],
    photos: photos.get(r.id) ?? [],
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));
}

/** Every organizer-scoped read filters by organizer id, so other tenants' rows are just "not found". */
export async function getTrekRow(
  db: Executor,
  organizerId: string,
  trekId: string,
): Promise<TrekRow> {
  const [row] = await db
    .select()
    .from(organizerTreks)
    .where(and(eq(organizerTreks.id, trekId), eq(organizerTreks.organizerId, organizerId)));
  if (!row) throw notFound('Trek');
  return row;
}

export async function getTrek(db: Database, organizerId: string, trekId: string) {
  return (await toTrekDtos(db, [await getTrekRow(db, organizerId, trekId)]))[0]!;
}

export async function listTreks(db: Database, organizerId: string, status?: ContentStatus) {
  const rows = await db
    .select()
    .from(organizerTreks)
    .where(
      and(
        eq(organizerTreks.organizerId, organizerId),
        status ? eq(organizerTreks.status, status) : undefined,
      ),
    )
    .orderBy(asc(organizerTreks.title));
  return toTrekDtos(db, rows);
}

/**
 * Validates catalog links: a catalog trek must be published; a catalog request must belong to
 * this organizer, and if already approved its catalog trek is linked automatically.
 */
async function resolveCatalogLink(
  tx: Executor,
  organizerId: string,
  input: {
    catalogTrekId?: string | null;
    catalogTrekRequestId?: string | null;
    catalogTrekName?: string | undefined;
    catalogDistrict?: string | undefined;
  },
) {
  const out: { catalogTrekId?: string | null; catalogTrekRequestId?: string | null } = {};

  if (input.catalogTrekName) {
    out.catalogTrekId = await findOrCreateCatalogTrek(
      tx,
      organizerId,
      input.catalogTrekName,
      input.catalogDistrict,
    );
    out.catalogTrekRequestId = null;
    return out;
  }

  if (input.catalogTrekId) {
    const [trek] = await tx
      .select({ status: catalogTreks.status })
      .from(catalogTreks)
      .where(eq(catalogTreks.id, input.catalogTrekId));
    if (!trek || trek.status !== 'published') {
      throw badRequest('catalogTrekId must reference a published catalog trek');
    }
    out.catalogTrekId = input.catalogTrekId;
  } else if (input.catalogTrekId === null) {
    out.catalogTrekId = null;
  }

  if (input.catalogTrekRequestId) {
    const [request] = await tx
      .select()
      .from(catalogTrekRequests)
      .where(
        and(
          eq(catalogTrekRequests.id, input.catalogTrekRequestId),
          eq(catalogTrekRequests.organizerId, organizerId),
        ),
      );
    if (!request)
      throw badRequest('catalogTrekRequestId must reference one of your catalog requests');
    if (request.status === 'rejected') throw badRequest('That catalog request was rejected');
    out.catalogTrekRequestId = request.id;
    if (request.status === 'approved' && !out.catalogTrekId)
      out.catalogTrekId = request.catalogTrekId;
  } else if (input.catalogTrekRequestId === null) {
    out.catalogTrekRequestId = null;
  }
  return out;
}

/**
 * Organizers name their destination freely: an existing catalog trek with the same slug is
 * reused, otherwise one is added (published) on the spot. Admins are notified and can tidy or
 * merge entries later in Admin → Catalog. Race-safe via the unique slug.
 */
async function findOrCreateCatalogTrek(
  tx: Executor,
  organizerId: string,
  rawName: string,
  district?: string,
): Promise<string> {
  const name = rawName.trim().replace(/\s+/g, ' ');
  const slug = slugify(name);
  if (slug.length < 2) throw badRequest('Enter the trek or destination name');

  // Same destination if the name matches (case-insensitively) or it maps to the same slug.
  const existing = async () =>
    (
      await tx
        .select()
        .from(catalogTreks)
        .where(or(eq(catalogTreks.slug, slug), sql`lower(${catalogTreks.name}) = lower(${name})`))
        .orderBy(sql`${catalogTreks.status} = 'archived'`)
        .limit(1)
    )[0];

  let trek = await existing();
  if (!trek) {
    const inserted = await tx
      .insert(catalogTreks)
      .values({ name, slug, district: district ?? null, status: 'published' })
      .onConflictDoNothing()
      .returning();
    trek = inserted[0] ?? (await existing());
    if (inserted[0]) {
      await enqueueEvent(tx, 'catalog_trek.auto_created', {
        catalogTrekId: inserted[0].id,
        name,
        organizerId,
      });
    }
  }
  if (!trek) throw conflict('Could not save the destination; please retry');
  if (trek.status === 'archived') {
    throw badRequest(`"${trek.name}" is no longer listed on Ohviana; choose another destination`);
  }
  if (trek.status === 'draft') {
    await tx.update(catalogTreks).set({ status: 'published' }).where(eq(catalogTreks.id, trek.id));
  }
  return trek.id;
}

/**
 * A destination's difficulty and altitude (shown on its public page) come from the first organizer
 * who gives them; later organizers never overwrite them (admins can edit the catalog).
 */
async function fillCatalogBlanks(
  tx: Executor,
  catalogTrekId: string,
  fields: { difficulty?: Difficulty | null | undefined; maxAltitudeM?: number | null | undefined },
) {
  if (!fields.difficulty && !fields.maxAltitudeM) return;
  await tx
    .update(catalogTreks)
    .set({
      difficulty: sql`coalesce(${catalogTreks.difficulty}, ${fields.difficulty ?? null})`,
      maxAltitudeM: sql`coalesce(${catalogTreks.maxAltitudeM}, ${fields.maxAltitudeM ?? null}::int)`,
    })
    .where(eq(catalogTreks.id, catalogTrekId));
}

function rethrowTrekWriteError(err: unknown, slug?: string): never {
  const constraint = pgConstraintName(err);
  if (constraint === 'organizer_treks_org_slug_uq') {
    throw conflict(`You already list a trek called "${slug}". Edit that one, or use another name.`);
  }
  if (constraint === 'organizer_treks_catalog_required_ck') {
    throw conflict('Link a published catalog trek before publishing this trek');
  }
  throw err;
}

/**
 * One form, one transaction: the trek, its pickup points and (optionally) its first batch.
 * With `publish`, the batch goes live at once (which also publishes the trek); without a batch,
 * `publish` publishes just the trek. Any failure saves nothing.
 */
export async function createTrek(
  db: Database,
  organizerId: string,
  input: CreateOrganizerTrekRequest,
) {
  const slug = input.slug ?? slugify(input.title);
  if (slug.length < 2) throw badRequest('Could not derive a slug from the title; provide one');
  const { pickupPoints: pickups = [], firstBatch, publish = false, ...fields } = input;
  if (publish && !fields.catalogTrekId && !fields.catalogTrekName) {
    throw badRequest('Add the destination (e.g. Kudremukh) to publish');
  }
  const batch = firstBatch && {
    departureAt: new Date(firstBatch.departureAt),
    returnAt: new Date(firstBatch.returnAt),
    bookingCutoffAt: new Date(firstBatch.bookingCutoffAt ?? firstBatch.departureAt),
  };
  if (batch) validateTimes(batch, new Date(), 'first batch');

  const row = await db.transaction(async (tx) => {
    const link = await resolveCatalogLink(tx, organizerId, fields);
    if (link.catalogTrekId) {
      await fillCatalogBlanks(tx, link.catalogTrekId, fields);
    }
    let created: TrekRow;
    try {
      [created] = (await tx
        .insert(organizerTreks)
        .values({
          ...trekColumns(fields),
          ...link,
          organizerId,
          slug,
          // No drafts: with a destination the trek is live (customers still only see it once
          // the organizer is approved and it has a published batch).
          status: link.catalogTrekId ? 'published' : 'draft',
        })
        .returning()) as [TrekRow];
    } catch (err) {
      rethrowTrekWriteError(err, slug);
    }

    const points = pickups.length
      ? await tx
          .insert(pickupPoints)
          .values(
            pickups.map((p, i) => ({
              organizerTrekId: created.id,
              organizerId,
              name: p.name,
              landmark: p.landmark ?? null,
              address: p.address ?? null,
              mapsUrl: p.mapsUrl ?? null,
              sortOrder: i,
            })),
          )
          .returning({ id: pickupPoints.id })
      : [];

    if (firstBatch && batch) {
      const [b] = await insertBatches(tx, organizerId, created.id, firstBatch, [
        {
          ...batch,
          pickups: points.map((pt, i) => ({
            pickupPointId: pt.id,
            pickupAt: pickups[i]!.pickupAt ? new Date(pickups[i]!.pickupAt!) : batch.departureAt,
          })),
        },
      ]);
      if (publish) await publishBatchTx(tx, organizerId, b!.id);
    }
    return created;
  });
  return getTrek(db, organizerId, row.id);
}

export async function updateTrek(
  db: Database,
  organizerId: string,
  trekId: string,
  input: UpdateOrganizerTrekRequest,
) {
  const row = await db.transaction(async (tx) => {
    const current = await getTrekRow(tx, organizerId, trekId);

    if (input.status === 'archived' && current.status !== 'archived') {
      const [live] = await tx
        .select({ id: batches.id })
        .from(batches)
        .where(
          and(
            eq(batches.organizerTrekId, trekId),
            eq(batches.status, 'published'),
            gt(batches.departureAt, new Date()),
          ),
        )
        .limit(1);
      if (live)
        throw conflict('Cancel or complete its upcoming published batches before archiving');
    }

    const link = await resolveCatalogLink(tx, organizerId, input);
    // A trek that was waiting for its destination goes live once it has one.
    const becomesLive =
      !input.status &&
      current.status === 'draft' &&
      ('catalogTrekId' in link ? link.catalogTrekId : current.catalogTrekId);
    try {
      const [updated] = await tx
        .update(organizerTreks)
        .set({ ...trekColumns(input), ...link, ...(becomesLive ? { status: 'published' } : {}) })
        .where(and(eq(organizerTreks.id, trekId), eq(organizerTreks.organizerId, organizerId)))
        .returning();
      return updated!;
    } catch (err) {
      rethrowTrekWriteError(err, input.slug);
    }
  });
  return (await toTrekDtos(db, [row]))[0]!;
}

/** Drops request-only fields that aren't columns. */
function trekColumns<T extends { catalogTrekName?: unknown; catalogDistrict?: unknown }>(input: T) {
  const columns = { ...input };
  delete columns.catalogTrekName;
  delete columns.catalogDistrict;
  return columns as Omit<T, 'catalogTrekName' | 'catalogDistrict'>;
}

// ---------- Pickup points ----------

export async function addPickup(
  db: Database,
  organizerId: string,
  trekId: string,
  input: z.infer<typeof CreatePickupPointRequest>,
) {
  await getTrekRow(db, organizerId, trekId);
  await db.insert(pickupPoints).values({ ...input, organizerTrekId: trekId, organizerId });
  return getTrek(db, organizerId, trekId);
}

export async function updatePickup(
  db: Database,
  organizerId: string,
  trekId: string,
  pickupId: string,
  input: z.infer<typeof UpdatePickupPointRequest>,
) {
  const updated = await db
    .update(pickupPoints)
    .set(input)
    .where(
      and(
        eq(pickupPoints.id, pickupId),
        eq(pickupPoints.organizerTrekId, trekId),
        eq(pickupPoints.organizerId, organizerId),
      ),
    )
    .returning({ id: pickupPoints.id });
  if (updated.length === 0) throw notFound('Pickup point');
  return getTrek(db, organizerId, trekId);
}

/** Removing a pickup also removes it from batches, unless a booking already chose it. */
export async function deletePickup(
  db: Database,
  organizerId: string,
  trekId: string,
  pickupId: string,
) {
  try {
    const deleted = await db
      .delete(pickupPoints)
      .where(
        and(
          eq(pickupPoints.id, pickupId),
          eq(pickupPoints.organizerTrekId, trekId),
          eq(pickupPoints.organizerId, organizerId),
        ),
      )
      .returning({ id: pickupPoints.id });
    if (deleted.length === 0) throw notFound('Pickup point');
  } catch (err) {
    if (pgErrorCode(err) === PG_FOREIGN_KEY_VIOLATION) {
      throw conflict('Customers have booked this pickup point; it cannot be removed');
    }
    throw err;
  }
  return getTrek(db, organizerId, trekId);
}
