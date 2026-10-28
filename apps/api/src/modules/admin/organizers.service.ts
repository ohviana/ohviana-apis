import { and, desc, eq, ilike, inArray, sql, type SQL } from 'drizzle-orm';
import { organizerMembers, organizers, type Database } from '@ohviana/db';
import type { AdminOrganizer, AdminOrganizerListQuery } from '@ohviana/contracts';
import { escapeLike, type OrganizerStatus } from '@ohviana/shared';
import { enqueueEvent, recordAdminAction } from '../../lib/audit';
import { conflict, notFound } from '../../lib/errors';
import { decodeCursor, toPage } from '../../lib/pagination';

const memberCount = sql<number>`(select count(*)::int from ${organizerMembers} where ${organizerMembers.organizerId} = ${organizers.id})`;

const columns = {
  id: organizers.id,
  name: organizers.name,
  slug: organizers.slug,
  status: organizers.status,
  tagline: organizers.tagline,
  city: organizers.city,
  contactEmail: organizers.contactEmail,
  contactPhone: organizers.contactPhone,
  gstin: organizers.gstin,
  commissionRateBps: organizers.commissionRateBps,
  reviewNote: organizers.reviewNote,
  reviewedAt: organizers.reviewedAt,
  createdAt: organizers.createdAt,
  memberCount,
};

const baseQuery = (db: Database) => db.select(columns).from(organizers);
type Row = Awaited<ReturnType<typeof baseQuery>>[number];

function toDto(r: Row): AdminOrganizer {
  return {
    ...r,
    reviewedAt: r.reviewedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  };
}

/** Newest first, keyset-paginated on (created_at, id). */
export async function listOrganizers(db: Database, q: AdminOrganizerListQuery) {
  const filters: SQL[] = [];
  if (q.status) filters.push(eq(organizers.status, q.status));
  if (q.query) filters.push(ilike(organizers.name, `%${escapeLike(q.query)}%`));
  if (q.cursor) {
    const [createdAt, id] = decodeCursor(q.cursor, 2);
    filters.push(
      sql`(date_trunc('milliseconds', ${organizers.createdAt}), ${organizers.id}) < (${createdAt}::timestamptz, ${id}::uuid)`,
    );
  }
  const rows = await baseQuery(db)
    .where(and(...filters))
    .orderBy(desc(sql`date_trunc('milliseconds', ${organizers.createdAt})`), desc(organizers.id))
    .limit(q.limit + 1);

  const page = toPage(rows, q.limit, (r) => [r.createdAt.toISOString(), r.id]);
  return { items: page.items.map(toDto), nextCursor: page.nextCursor };
}

export async function getOrganizer(db: Database, id: string): Promise<AdminOrganizer> {
  const [row] = await baseQuery(db).where(eq(organizers.id, id));
  if (!row) throw notFound('Organizer');
  return toDto(row);
}

export type OrganizerReviewAction = 'approve' | 'reject' | 'suspend' | 'reinstate';

const TRANSITIONS: Record<OrganizerReviewAction, { from: OrganizerStatus[]; to: OrganizerStatus }> =
  {
    approve: { from: ['pending', 'rejected'], to: 'approved' },
    reject: { from: ['pending'], to: 'rejected' },
    suspend: { from: ['approved'], to: 'suspended' },
    reinstate: { from: ['suspended'], to: 'approved' },
  };

export interface ReviewInput {
  actorId: string;
  organizerId: string;
  action: OrganizerReviewAction;
  note?: string | undefined;
  commissionRateBps?: number | undefined;
}

/**
 * Moves an organizer through its review lifecycle. The UPDATE is conditional on the current
 * status, so concurrent reviews cannot both succeed; the loser gets 409.
 */
export async function reviewOrganizer(db: Database, input: ReviewInput): Promise<AdminOrganizer> {
  const { from, to } = TRANSITIONS[input.action];

  await db.transaction(async (tx) => {
    const updated = await tx
      .update(organizers)
      .set({
        status: to,
        reviewNote: input.note ?? null,
        reviewedBy: input.actorId,
        reviewedAt: new Date(),
        ...(input.commissionRateBps !== undefined
          ? { commissionRateBps: input.commissionRateBps }
          : {}),
      })
      .where(and(eq(organizers.id, input.organizerId), inArray(organizers.status, from)))
      .returning({ id: organizers.id });

    if (updated.length === 0) {
      const [current] = await tx
        .select({ status: organizers.status })
        .from(organizers)
        .where(eq(organizers.id, input.organizerId));
      if (!current) throw notFound('Organizer');
      throw conflict(`Cannot ${input.action} an organizer that is ${current.status}`);
    }

    const payload = {
      organizerId: input.organizerId,
      to,
      note: input.note ?? null,
      ...(input.commissionRateBps !== undefined
        ? { commissionRateBps: input.commissionRateBps }
        : {}),
    };
    await recordAdminAction(tx, {
      actorId: input.actorId,
      action: `organizer.${input.action}`,
      entityType: 'organizer',
      entityId: input.organizerId,
      payload,
    });
    await enqueueEvent(tx, `organizer.${to}`, payload);
  });

  return getOrganizer(db, input.organizerId);
}

export async function updateCommission(
  db: Database,
  input: { actorId: string; organizerId: string; commissionRateBps: number; note: string },
): Promise<AdminOrganizer> {
  await db.transaction(async (tx) => {
    const [before] = await tx
      .select({ commissionRateBps: organizers.commissionRateBps })
      .from(organizers)
      .where(eq(organizers.id, input.organizerId))
      .for('update');
    if (!before) throw notFound('Organizer');

    await tx
      .update(organizers)
      .set({ commissionRateBps: input.commissionRateBps })
      .where(eq(organizers.id, input.organizerId));

    // Existing bookings keep their own commission snapshot; this affects new bookings only.
    await recordAdminAction(tx, {
      actorId: input.actorId,
      action: 'organizer.commission_changed',
      entityType: 'organizer',
      entityId: input.organizerId,
      payload: {
        from: before.commissionRateBps,
        to: input.commissionRateBps,
        note: input.note,
      },
    });
  });
  return getOrganizer(db, input.organizerId);
}
