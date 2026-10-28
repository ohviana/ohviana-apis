import { and, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import {
  catalogTrekRequests,
  catalogTreks,
  organizers,
  organizerTreks,
  type Database,
} from '@ohviana/db';
import type {
  ApproveCatalogRequest,
  CatalogRequest,
  CatalogRequestListQuery,
} from '@ohviana/contracts';
import { enqueueEvent, recordAdminAction } from '../../lib/audit';
import { conflict, notFound } from '../../lib/errors';
import { decodeCursor, toPage } from '../../lib/pagination';
import { createCatalogTrek } from '../catalog/service';

const columns = {
  id: catalogTrekRequests.id,
  organizerId: catalogTrekRequests.organizerId,
  organizerName: organizers.name,
  name: catalogTrekRequests.name,
  state: catalogTrekRequests.state,
  region: catalogTrekRequests.region,
  district: catalogTrekRequests.district,
  notes: catalogTrekRequests.notes,
  status: catalogTrekRequests.status,
  catalogTrekId: catalogTrekRequests.catalogTrekId,
  reviewNote: catalogTrekRequests.reviewNote,
  reviewedAt: catalogTrekRequests.reviewedAt,
  createdAt: catalogTrekRequests.createdAt,
};

const baseQuery = (db: Database) =>
  db
    .select(columns)
    .from(catalogTrekRequests)
    .innerJoin(organizers, eq(organizers.id, catalogTrekRequests.organizerId));
type Row = Awaited<ReturnType<typeof baseQuery>>[number];

function toDto(r: Row): CatalogRequest {
  return {
    ...r,
    reviewedAt: r.reviewedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  };
}

export async function listCatalogRequests(db: Database, q: CatalogRequestListQuery) {
  const filters: SQL[] = [];
  if (q.status) filters.push(eq(catalogTrekRequests.status, q.status));
  if (q.cursor) {
    const [createdAt, id] = decodeCursor(q.cursor, 2);
    filters.push(
      sql`(date_trunc('milliseconds', ${catalogTrekRequests.createdAt}), ${catalogTrekRequests.id}) < (${createdAt}::timestamptz, ${id}::uuid)`,
    );
  }
  const rows = await baseQuery(db)
    .where(and(...filters))
    .orderBy(
      desc(sql`date_trunc('milliseconds', ${catalogTrekRequests.createdAt})`),
      desc(catalogTrekRequests.id),
    )
    .limit(q.limit + 1);

  const page = toPage(rows, q.limit, (r) => [r.createdAt.toISOString(), r.id]);
  return { items: page.items.map(toDto), nextCursor: page.nextCursor };
}

async function getCatalogRequest(db: Database, id: string): Promise<CatalogRequest> {
  const [row] = await baseQuery(db).where(eq(catalogTrekRequests.id, id));
  if (!row) throw notFound('Catalog request');
  return toDto(row);
}

/**
 * Approves a pending request by linking an existing catalog trek or creating a new one, then
 * attaches every draft organizer trek that was waiting on this request.
 */
export async function approveCatalogRequest(
  db: Database,
  actorId: string,
  requestId: string,
  body: ApproveCatalogRequest,
) {
  const linkedOrganizerTreks = await db.transaction(async (tx) => {
    const [request] = await tx
      .select()
      .from(catalogTrekRequests)
      .where(eq(catalogTrekRequests.id, requestId))
      .for('update');
    if (!request) throw notFound('Catalog request');
    if (request.status !== 'pending') {
      throw conflict(`Catalog request is already ${request.status}`);
    }

    let catalogTrekId: string;
    let created = false;
    if ('catalogTrekId' in body) {
      const [existing] = await tx
        .select({ id: catalogTreks.id, status: catalogTreks.status })
        .from(catalogTreks)
        .where(eq(catalogTreks.id, body.catalogTrekId));
      if (!existing) throw notFound('Catalog trek');
      if (existing.status === 'archived') {
        throw conflict('Cannot link an archived catalog trek');
      }
      catalogTrekId = existing.id;
    } else {
      catalogTrekId = (await createCatalogTrek(tx, body.create)).id;
      created = true;
    }

    await tx
      .update(catalogTrekRequests)
      .set({
        status: 'approved',
        catalogTrekId,
        reviewNote: body.note ?? null,
        reviewedBy: actorId,
        reviewedAt: new Date(),
      })
      .where(eq(catalogTrekRequests.id, requestId));

    const linked = await tx
      .update(organizerTreks)
      // Treks have no drafts: one waiting for this destination goes live with it.
      .set({
        catalogTrekId,
        status: sql`case when ${organizerTreks.status} = 'draft' then 'published' else ${organizerTreks.status} end`,
      })
      .where(
        and(
          eq(organizerTreks.catalogTrekRequestId, requestId),
          eq(organizerTreks.organizerId, request.organizerId),
          isNull(organizerTreks.catalogTrekId),
        ),
      )
      .returning({ id: organizerTreks.id });

    const payload = {
      requestId,
      organizerId: request.organizerId,
      catalogTrekId,
      createdCatalogTrek: created,
      linkedOrganizerTreks: linked.length,
      note: body.note ?? null,
    };
    await recordAdminAction(tx, {
      actorId,
      action: 'catalog_request.approve',
      entityType: 'catalog_request',
      entityId: requestId,
      payload,
    });
    await enqueueEvent(tx, 'catalog_request.approved', payload);
    return linked.length;
  });

  return { request: await getCatalogRequest(db, requestId), linkedOrganizerTreks };
}

export async function rejectCatalogRequest(
  db: Database,
  actorId: string,
  requestId: string,
  note: string,
): Promise<CatalogRequest> {
  await db.transaction(async (tx) => {
    const updated = await tx
      .update(catalogTrekRequests)
      .set({ status: 'rejected', reviewNote: note, reviewedBy: actorId, reviewedAt: new Date() })
      .where(and(eq(catalogTrekRequests.id, requestId), eq(catalogTrekRequests.status, 'pending')))
      .returning({ organizerId: catalogTrekRequests.organizerId });

    if (updated.length === 0) {
      const [current] = await tx
        .select({ status: catalogTrekRequests.status })
        .from(catalogTrekRequests)
        .where(eq(catalogTrekRequests.id, requestId));
      if (!current) throw notFound('Catalog request');
      throw conflict(`Catalog request is already ${current.status}`);
    }

    const payload = { requestId, organizerId: updated[0]!.organizerId, note };
    await recordAdminAction(tx, {
      actorId,
      action: 'catalog_request.reject',
      entityType: 'catalog_request',
      entityId: requestId,
      payload,
    });
    await enqueueEvent(tx, 'catalog_request.rejected', payload);
  });
  return getCatalogRequest(db, requestId);
}
