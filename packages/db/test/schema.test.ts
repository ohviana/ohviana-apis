import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import type { Tx } from '../src/client';
import {
  batchPickups,
  batches,
  bookings,
  catalogTreks,
  directLinks,
  organizers,
  organizerTreks,
  pickupPoints,
} from '../src/schema/index';
import { seed } from '../src/seed';
import { expectViolation, testDb, withRollback } from './db-helpers';

const client = testDb();
afterAll(() => client.close());

const DAY = 86_400_000;

/** Two organizers, each with a template, a batch and a pickup point. */
async function fixture(tx: Tx) {
  const suffix = randomUUID().slice(0, 8);
  const [catalog] = await tx
    .insert(catalogTreks)
    .values({ name: 'Test Peak', slug: `test-peak-${suffix}`, status: 'published' })
    .returning();

  const make = async (label: string) => {
    const [org] = await tx
      .insert(organizers)
      .values({ name: `Org ${label}`, slug: `org-${label}-${suffix}`, status: 'approved' })
      .returning();
    const [trek] = await tx
      .insert(organizerTreks)
      .values({
        organizerId: org!.id,
        catalogTrekId: catalog!.id,
        title: `Trek ${label}`,
        slug: `trek-${label}`,
        status: 'published',
      })
      .returning();
    const departureAt = new Date(Date.now() + 10 * DAY);
    const [batch] = await tx
      .insert(batches)
      .values({
        name: `Test_Batch_${randomUUID()}`,
        organizerTrekId: trek!.id,
        organizerId: org!.id,
        departureAt,
        returnAt: new Date(departureAt.getTime() + 2 * DAY),
        bookingCutoffAt: new Date(departureAt.getTime() - DAY),
        pricePaise: 199_900,
        capacity: 10,
        status: 'published',
      })
      .returning();
    const [pickup] = await tx
      .insert(pickupPoints)
      .values({ organizerTrekId: trek!.id, organizerId: org!.id, name: 'Majestic' })
      .returning();
    return { org: org!, trek: trek!, batch: batch!, pickup: pickup! };
  };

  return { catalog: catalog!, a: await make('a'), b: await make('b') };
}

function bookingRow(
  batch: typeof batches.$inferSelect,
  overrides: Partial<typeof bookings.$inferInsert> = {},
) {
  return {
    bookingReference: `OHV-${randomUUID().slice(0, 8).toUpperCase()}`,
    batchId: batch.id,
    organizerId: batch.organizerId,
    source: 'MARKETPLACE' as const,
    quantity: 2,
    unitPricePaise: batch.pricePaise,
    totalPaise: batch.pricePaise * 2,
    commissionRateBps: 750,
    commissionPaise: 29_985,
    commissionSnapshot: {
      basis: 'MARKETPLACE_AGREED_RATE' as const,
      rateBps: 750,
      computedOnPaise: batch.pricePaise * 2,
    },
    policySnapshot: {
      trekTitle: 'Trek',
      organizerName: 'Org',
      departureAt: batch.departureAt.toISOString(),
      returnAt: batch.returnAt.toISOString(),
      cancellationPolicy: null,
      inclusions: [],
      exclusions: [],
    },
    contactName: 'Test Customer',
    contactPhone: '+919999999999',
    ...overrides,
  };
}

describe('schema safety', () => {
  it('enables row level security on every public table', async () => {
    const rows = await client.db.execute<{ relname: string }>(sql`
      select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
        and c.relname not like '__drizzle%'`);
    expect(rows.map((r) => r.relname)).toEqual([]);
  });
});

describe('inventory and batch constraints', () => {
  it('never allows confirmed seats above capacity', () =>
    withRollback(client, async (tx) => {
      const { a } = await fixture(tx);
      await expectViolation(tx, 'batches_seats_ck', (sp) =>
        sp
          .update(batches)
          .set({ confirmedSeats: 11 })
          .where(sql`${batches.id} = ${a.batch.id}`),
      );
    }));

  it('requires booking cutoff on or before departure', () =>
    withRollback(client, async (tx) => {
      const { a } = await fixture(tx);
      await expectViolation(tx, 'batches_cutoff_ck', (sp) =>
        sp
          .update(batches)
          .set({ bookingCutoffAt: new Date(a.batch.departureAt.getTime() + 1000) })
          .where(sql`${batches.id} = ${a.batch.id}`),
      );
    }));

  it('lets many batches share one template without sharing seats', () =>
    withRollback(client, async (tx) => {
      const { a } = await fixture(tx);
      const [second] = await tx
        .insert(batches)
        .values({ ...a.batch, id: undefined, name: `${a.batch.name}_copy`, confirmedSeats: 0 })
        .returning();
      await tx
        .update(batches)
        .set({ confirmedSeats: 10 })
        .where(sql`${batches.id} = ${a.batch.id}`);
      const [reloaded] = await tx
        .select()
        .from(batches)
        .where(sql`${batches.id} = ${second!.id}`);
      expect(reloaded!.confirmedSeats).toBe(0);
    }));

  it('refuses publishing a template without a catalog trek', () =>
    withRollback(client, async (tx) => {
      const { a } = await fixture(tx);
      await expectViolation(tx, 'organizer_treks_catalog_required_ck', (sp) =>
        sp.insert(organizerTreks).values({
          organizerId: a.org.id,
          title: 'Orphan',
          slug: 'orphan',
          status: 'published',
        }),
      );
    }));

  it('enforces lowercase kebab-case slugs', () =>
    withRollback(client, async (tx) => {
      await expectViolation(tx, 'organizers_slug_ck', (sp) =>
        sp.insert(organizers).values({ name: 'Bad', slug: 'Bad Slug' }),
      );
    }));
});

describe('cross-tenant integrity', () => {
  it("rejects a batch whose organizer doesn't own the template", () =>
    withRollback(client, async (tx) => {
      const { a, b } = await fixture(tx);
      await expectViolation(tx, 'batches_trek_fk', (sp) =>
        sp.insert(batches).values({ ...a.batch, id: undefined, organizerId: b.org.id }),
      );
    }));

  it("rejects a direct link to another organizer's batch", () =>
    withRollback(client, async (tx) => {
      const { a, b } = await fixture(tx);
      await expectViolation(tx, 'direct_links_batch_fk', (sp) =>
        sp.insert(directLinks).values({
          organizerId: b.org.id,
          batchId: a.batch.id,
          token: randomUUID().replace(/-/g, ''),
        }),
      );
    }));

  it("rejects attaching another template's pickup point to a batch", () =>
    withRollback(client, async (tx) => {
      const { a, b } = await fixture(tx);
      await expectViolation(tx, 'batch_pickups_point_fk', (sp) =>
        sp.insert(batchPickups).values({
          batchId: a.batch.id,
          organizerTrekId: a.trek.id,
          pickupPointId: b.pickup.id,
          pickupAt: a.batch.departureAt,
        }),
      );
    }));
});

describe('booking constraints', () => {
  it('accepts a valid marketplace booking', () =>
    withRollback(client, async (tx) => {
      const { a } = await fixture(tx);
      const [row] = await tx.insert(bookings).values(bookingRow(a.batch)).returning();
      expect(row!.status).toBe('confirmed');
    }));

  it('forces zero commission on organizer-direct bookings', () =>
    withRollback(client, async (tx) => {
      const { a } = await fixture(tx);
      const [link] = await tx
        .insert(directLinks)
        .values({ organizerId: a.org.id, token: randomUUID().replace(/-/g, '') })
        .returning();
      await expectViolation(tx, 'bookings_direct_zero_commission_ck', (sp) =>
        sp
          .insert(bookings)
          .values(bookingRow(a.batch, { source: 'ORGANIZER_DIRECT', directLinkId: link!.id })),
      );
    }));

  it('requires a direct link exactly when the source is ORGANIZER_DIRECT', () =>
    withRollback(client, async (tx) => {
      const { a } = await fixture(tx);
      await expectViolation(tx, 'bookings_direct_link_ck', (sp) =>
        sp.insert(bookings).values(
          bookingRow(a.batch, {
            source: 'ORGANIZER_DIRECT',
            commissionPaise: 0,
            commissionRateBps: 0,
          }),
        ),
      );
    }));

  it('requires total = unit price x quantity', () =>
    withRollback(client, async (tx) => {
      const { a } = await fixture(tx);
      await expectViolation(tx, 'bookings_total_ck', (sp) =>
        sp
          .insert(bookings)
          .values(bookingRow(a.batch, { totalPaise: a.batch.pricePaise * 2 + 100 })),
      );
    }));

  it("rejects a booking on another organizer's batch", () =>
    withRollback(client, async (tx) => {
      const { a, b } = await fixture(tx);
      await expectViolation(tx, 'bookings_batch_fk', (sp) =>
        sp.insert(bookings).values(bookingRow(a.batch, { organizerId: b.org.id })),
      );
    }));

  it("rejects a pickup point that the batch doesn't offer", () =>
    withRollback(client, async (tx) => {
      const { a } = await fixture(tx);
      await expectViolation(tx, 'bookings_pickup_fk', (sp) =>
        sp.insert(bookings).values(bookingRow(a.batch, { pickupPointId: a.pickup.id })),
      );
    }));
});

describe('seed', () => {
  it('is idempotent', () =>
    withRollback(client, async (tx) => {
      const count = async () =>
        (await tx.execute<{ n: number }>(sql`select count(*)::int as n from batches`))[0]!.n;
      await seed(tx);
      const first = await count();
      await seed(tx);
      expect(await count()).toBe(first);
    }));
});
