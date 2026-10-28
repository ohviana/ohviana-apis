import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  batches,
  organizerLeadRevocations,
  organizerMembers,
  users,
  type Database,
  type Tx,
} from '@ohviana/db';
import type { TrekLeadSummary } from '@ohviana/contracts';
import type { OrganizerContext } from '../../plugins/auth';
import { notFound } from '../../lib/errors';

type Executor = Database | Tx;

/** `leads @> [{"phone": …}]`: batches that list this mobile as a lead (uses the GIN index). */
export const ledBy = (phone: string) =>
  sql`${batches.leads} @> ${JSON.stringify([{ phone }])}::jsonb`;

/**
 * Trek leads see only the batches they lead; everyone else in the organizer sees all of them.
 * Returns the extra condition for batch queries, or undefined when there is none.
 */
export function batchScope(ctx: OrganizerContext) {
  if (ctx.role !== 'trek_lead') return undefined;
  // A lead without a mobile can't lead anything.
  return ctx.phone ? ledBy(ctx.phone) : sql`false`;
}

/** 404 unless the caller may see this batch (trek leads: only batches they lead). */
export async function assertBatchVisible(db: Executor, ctx: OrganizerContext, batchId: string) {
  const scope = batchScope(ctx);
  const [row] = await db
    .select({ id: batches.id })
    .from(batches)
    .where(
      and(
        eq(batches.id, batchId),
        eq(batches.organizerId, ctx.organizerId),
        ...(scope ? [scope] : []),
      ),
    );
  if (!row) throw notFound('Batch');
}

/**
 * On phone sign-in: every organizer that names this mobile as a batch lead (and hasn't revoked
 * it) gets the person as a trek lead. Existing memberships (e.g. a co-owner) are left alone.
 */
export async function grantLeadAccess(db: Executor, userId: string, phone: string) {
  await db.execute(sql`
    insert into ${organizerMembers} (organizer_id, user_id, role)
    select distinct b.organizer_id, ${userId}::uuid, 'trek_lead'
    from ${batches} b
    where b.leads @> ${JSON.stringify([{ phone }])}::jsonb
      and not exists (
        select 1 from ${organizerLeadRevocations} r
        where r.organizer_id = b.organizer_id and r.phone = ${phone}
      )
    on conflict do nothing`);
}

/**
 * After an organizer names leads on a batch. `restore` (an explicit choice, e.g. adding dates)
 * lifts an earlier revocation; copying a batch doesn't. Leads who already have an Ohviana
 * account get access straight away; the rest get it when they first sign in.
 */
export async function onLeadsSaved(
  tx: Executor,
  organizerId: string,
  phones: string[],
  opts: { restore: boolean },
) {
  const unique = [...new Set(phones)];
  if (unique.length === 0) return;
  if (opts.restore) {
    await tx
      .delete(organizerLeadRevocations)
      .where(
        and(
          eq(organizerLeadRevocations.organizerId, organizerId),
          inArray(organizerLeadRevocations.phone, unique),
        ),
      );
  }
  await tx.execute(sql`
    insert into ${organizerMembers} (organizer_id, user_id, role)
    select ${organizerId}::uuid, u.id, 'trek_lead'
    from ${users} u
    where u.phone in (${sql.join(
      unique.map((p) => sql`${p}`),
      sql`, `,
    )})
      and not exists (
        select 1 from ${organizerLeadRevocations} r
        where r.organizer_id = ${organizerId}::uuid and r.phone = u.phone
      )
    on conflict do nothing`);
}

/** Everyone named as a lead on this organizer's batches, with whether they can sign in. */
export async function listTrekLeads(db: Database, organizerId: string): Promise<TrekLeadSummary[]> {
  const rows = (await db.execute(sql`
    with named as (
      select l.phone, l.name, b.departure_at
      from ${batches} b, jsonb_to_recordset(b.leads) as l(name text, phone text)
      where b.organizer_id = ${organizerId}::uuid and b.status <> 'cancelled'
    ),
    by_phone as (
      select phone,
        (array_agg(name order by departure_at desc))[1] as name,
        count(*)::int as batch_count,
        min(departure_at) filter (where departure_at > now()) as next_departure_at
      from named group by phone
    )
    select p.phone, p.name, p.batch_count, p.next_departure_at,
      m.user_id,
      (r.phone is not null) as revoked
    from by_phone p
    left join ${users} u on u.phone = p.phone
    left join ${organizerMembers} m
      on m.user_id = u.id and m.organizer_id = ${organizerId}::uuid and m.role = 'trek_lead'
    left join ${organizerLeadRevocations} r
      on r.organizer_id = ${organizerId}::uuid and r.phone = p.phone
    order by p.next_departure_at nulls last, p.name`)) as unknown as {
    phone: string;
    name: string;
    batch_count: number;
    next_departure_at: Date | string | null;
    user_id: string | null;
    revoked: boolean;
  }[];
  return rows.map((r) => ({
    phone: r.phone,
    name: r.name,
    batchCount: r.batch_count,
    nextDepartureAt: r.next_departure_at ? new Date(r.next_departure_at).toISOString() : null,
    status: r.revoked ? 'revoked' : r.user_id ? 'active' : 'not_signed_in',
  }));
}

/** Takes a lead's access away (by mobile) and keeps it away until restored. */
export async function revokeLead(
  db: Database,
  organizerId: string,
  phone: string,
  actorId: string,
) {
  await db.transaction(async (tx) => {
    await tx
      .insert(organizerLeadRevocations)
      .values({ organizerId, phone, revokedBy: actorId })
      .onConflictDoNothing();
    await tx.execute(sql`
      delete from ${organizerMembers} m using ${users} u
      where m.user_id = u.id and m.organizer_id = ${organizerId}::uuid
        and m.role = 'trek_lead' and u.phone = ${phone}`);
  });
}

export async function restoreLead(db: Database, organizerId: string, phone: string) {
  await db.transaction((tx) => onLeadsSaved(tx, organizerId, [phone], { restore: true }));
}
