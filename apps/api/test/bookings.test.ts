import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  batchPickups,
  batches,
  bookingEvents,
  bookings,
  createDb,
  directLinks,
  organizers,
  organizerTreks,
  outboxEvents,
  pickupPoints,
  type DbClient,
} from '@ohviana/db';
import { createFixtures, createTestApp, createTestKeys, testConfig, type TestApp } from './helpers';

let app: TestApp;
let pool: DbClient;
let fx: ReturnType<typeof createFixtures>;
let keys: Awaited<ReturnType<typeof createTestKeys>>;
/** The signed-in customer making bookings (phone sign-in at checkout). */
let customerHeaders: Record<string, string>;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

beforeAll(async () => {
  keys = await createTestKeys();
  // A larger pool so concurrency tests really run in parallel against Postgres.
  pool = createDb(testConfig().DATABASE_URL, { max: 4, applicationName: 'ohviana-test-bookings' });
  app = await createTestApp({ verifier: keys.verifier, dbClient: pool });
  fx = createFixtures(app.db);
  customerHeaders = { authorization: `Bearer ${await keys.sign({ sub: await fx.user() })}` };
});

afterAll(async () => {
  await fx.cleanup();
  await app.close();
  await pool.close();
});

/** An approved organizer (7.5% commission) with a published trek. */
async function setup(opts: { commissionRateBps?: number; withPickup?: boolean } = {}) {
  const owner = await fx.user();
  const org = await fx.organizer();
  await fx.member(org, owner, 'owner');
  await app.db
    .update(organizers)
    .set({ commissionRateBps: opts.commissionRateBps ?? 750 })
    .where(eq(organizers.id, org));
  const catalog = await fx.catalogTrek();
  const [trek] = await app.db
    .insert(organizerTreks)
    .values({
      organizerId: org,
      catalogTrekId: catalog.id,
      title: 'Kudremukh Weekend',
      slug: `t-${randomUUID().slice(0, 8)}`,
      cancellationPolicy: 'Full refund up to 7 days before departure',
      inclusions: ['Meals'],
      status: 'published',
    })
    .returning();
  let pickupId: string | null = null;
  if (opts.withPickup) {
    const [p] = await app.db
      .insert(pickupPoints)
      .values({ organizerTrekId: trek!.id, organizerId: org, name: 'Majestic' })
      .returning();
    pickupId = p!.id;
  }
  return {
    org,
    owner,
    ownerHeaders: { authorization: `Bearer ${await keys.sign({ sub: owner })}` },
    trek: trek!,
    pickupId,
  };
}

async function makeBatch(
  s: Awaited<ReturnType<typeof setup>>,
  o: {
    capacity?: number;
    pricePaise?: number;
    maxSeats?: number;
    cutoffIn?: number;
    departIn?: number;
    status?: 'draft' | 'published';
  } = {},
) {
  const departureAt = new Date(Date.now() + (o.departIn ?? 10 * DAY));
  const [row] = await app.db
    .insert(batches)
    .values({
      name: `Test_Batch_${randomUUID()}`,
      organizerTrekId: s.trek.id,
      organizerId: s.org,
      departureAt,
      returnAt: new Date(departureAt.getTime() + 2 * DAY),
      bookingCutoffAt:
        o.cutoffIn !== undefined
          ? new Date(Date.now() + o.cutoffIn)
          : new Date(departureAt.getTime() - HOUR),
      pricePaise: o.pricePaise ?? 199_900,
      capacity: o.capacity ?? 10,
      maxSeatsPerBooking: o.maxSeats ?? 10,
      status: o.status ?? 'published',
    })
    .returning();
  if (s.pickupId) {
    await app.db.insert(batchPickups).values({
      batchId: row!.id,
      organizerTrekId: s.trek.id,
      pickupPointId: s.pickupId,
      pickupAt: departureAt,
    });
  }
  return row!;
}

function bookingBody(batchId: string, quantity = 2, extra: object = {}) {
  return {
    batchId,
    quantity,
    contact: { name: 'Asha Rao', phone: '+919876543210', email: 'Asha@Example.com' },
    guests: Array.from({ length: quantity }, (_, i) => ({
      fullName: `Guest ${i + 1}`,
      age: 25 + i,
    })),
    ...extra,
  };
}

const book = (body: object, o: { key?: string; headers?: Record<string, string> } = {}) =>
  app.inject({
    method: 'POST',
    url: '/v1/bookings',
    headers: { 'idempotency-key': o.key ?? fx.idemKey(), ...(o.headers ?? customerHeaders) },
    payload: body,
  });

const seatsOf = async (batchId: string) =>
  (await app.db.select().from(batches).where(eq(batches.id, batchId)))[0]!.confirmedSeats;

// ---------------------------------------------------------------------------

describe('booking seats', () => {
  it('confirms a marketplace booking with server-side price and commission', async () => {
    const s = await setup({ commissionRateBps: 750 });
    const batch = await makeBatch(s, { pricePaise: 199_900 });

    const res = await book(bookingBody(batch.id, 2));
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({
      status: 'confirmed',
      source: 'MARKETPLACE',
      quantity: 2,
      unitPricePaise: 199_900,
      totalPaise: 399_800,
      contact: { email: 'asha@example.com' },
      cancellationPolicy: 'Full refund up to 7 days before departure',
      batch: { id: batch.id, trekTitle: 'Kudremukh Weekend' },
    });
    expect(body.bookingReference).toMatch(/^OHV-[A-HJKMNP-Z2-9]{8}$/);
    expect(body.accessToken).toMatch(/^[A-Za-z0-9_-]{32}$/);
    // Customers never see commission.
    expect(body).not.toHaveProperty('commissionPaise');
    expect(await seatsOf(batch.id)).toBe(2);

    const [row] = await app.db
      .select()
      .from(bookings)
      .where(eq(bookings.bookingReference, body.bookingReference));
    expect(row).toMatchObject({ commissionRateBps: 750, commissionPaise: 29_985 });
    expect(row!.accessTokenHash).not.toBe(body.accessToken);
    const events = await app.db
      .select()
      .from(bookingEvents)
      .where(eq(bookingEvents.bookingId, row!.id));
    expect(events.map((e) => e.eventType)).toEqual(['confirmed']);
    const outbox = await app.db
      .select()
      .from(outboxEvents)
      .where(sql`${outboxEvents.payload}->>'bookingId' = ${row!.id}`);
    expect(outbox.map((e) => e.topic)).toEqual(['booking.confirmed']);
  });

  it('ignores any price or source the client tries to send', async () => {
    const s = await setup();
    const batch = await makeBatch(s, { pricePaise: 500_000 });
    const res = await book({
      ...bookingBody(batch.id, 1),
      pricePaise: 1,
      source: 'ORGANIZER_DIRECT',
    });
    expect(res.json()).toMatchObject({ totalPaise: 500_000, source: 'MARKETPLACE' });
  });

  it.each([
    ['more seats than allowed per booking', { maxSeats: 2 }, 3, 400, 'VALIDATION_ERROR'],
    ['more seats than are left', { capacity: 2 }, 3, 409, 'SOLD_OUT'],
    ['a closed booking cutoff', { cutoffIn: -HOUR }, 1, 422, 'BOOKING_CUTOFF'],
    ['a draft departure', { status: 'draft' as const }, 1, 404, 'NOT_FOUND'],
  ])('refuses %s', async (_label, batchOpts, quantity, status, code) => {
    const s = await setup();
    const batch = await makeBatch(s, batchOpts);
    const res = await book(bookingBody(batch.id, quantity));
    expect(res.statusCode).toBe(status);
    expect(res.json().error.code).toBe(code);
    expect(await seatsOf(batch.id)).toBe(0);
  });

  it('refuses departures of organizers that are not approved', async () => {
    const s = await setup();
    const batch = await makeBatch(s);
    await app.db.update(organizers).set({ status: 'suspended' }).where(eq(organizers.id, s.org));
    expect((await book(bookingBody(batch.id, 1))).statusCode).toBe(404);
  });

  it('requires one guest per seat', async () => {
    const s = await setup();
    const batch = await makeBatch(s);
    const res = await book({ ...bookingBody(batch.id, 2), guests: [{ fullName: 'Only One' }] });
    expect(res.statusCode).toBe(400);
  });

  it('requires an Idempotency-Key', async () => {
    const s = await setup();
    const batch = await makeBatch(s);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/bookings',
      headers: customerHeaders,
      payload: bookingBody(batch.id),
    });
    expect(res.statusCode).toBe(400);
  });

  it('requires signing in (phone code at checkout) before booking', async () => {
    const s = await setup();
    const batch = await makeBatch(s);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/bookings',
      headers: { 'idempotency-key': fx.idemKey() },
      payload: bookingBody(batch.id),
    });
    expect(res.statusCode).toBe(401);
    expect(await seatsOf(batch.id)).toBe(0);
  });

  it('requires choosing one of the offered pickup points', async () => {
    const s = await setup({ withPickup: true });
    const batch = await makeBatch(s);
    expect((await book(bookingBody(batch.id, 1))).statusCode).toBe(400);
    expect((await book(bookingBody(batch.id, 1, { pickupPointId: randomUUID() }))).statusCode).toBe(
      400,
    );
    const ok = await book(bookingBody(batch.id, 1, { pickupPointId: s.pickupId }));
    expect(ok.json().pickup).toMatchObject({ name: 'Majestic' });
  });
});

describe('concurrency: the last seat', () => {
  it('never oversells when many customers race for the final seats', async () => {
    const s = await setup();
    const batch = await makeBatch(s, { capacity: 3 });

    const results = await Promise.all(
      Array.from({ length: 10 }, () => book(bookingBody(batch.id, 1))),
    );
    const codes = results.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 201)).toHaveLength(3);
    expect(codes.filter((c) => c === 409)).toHaveLength(7);
    expect(
      results.filter((r) => r.statusCode === 409).every((r) => r.json().error.code === 'SOLD_OUT'),
    ).toBe(true);

    expect(await seatsOf(batch.id)).toBe(3);
    const rows = await app.db.select().from(bookings).where(eq(bookings.batchId, batch.id));
    expect(rows).toHaveLength(3);
  });
});

describe('idempotency', () => {
  it('replays the same booking for a retried request', async () => {
    const s = await setup();
    const batch = await makeBatch(s);
    const key = fx.idemKey();
    const first = await book(bookingBody(batch.id, 2), { key });
    const retry = await book(bookingBody(batch.id, 2), { key });

    expect(retry.statusCode).toBe(201);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.json().bookingReference).toBe(first.json().bookingReference);
    expect(await seatsOf(batch.id)).toBe(2);
    // The replay hands out a fresh access token (the original isn't stored in plain text).
    const view = await app.inject({
      method: 'GET',
      url: `/v1/bookings/${retry.json().bookingReference}`,
      headers: { 'x-booking-token': retry.json().accessToken },
    });
    expect(view.statusCode).toBe(200);
  });

  it('creates exactly one booking when duplicates arrive at the same moment', async () => {
    const s = await setup();
    const batch = await makeBatch(s);
    const key = fx.idemKey();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => book(bookingBody(batch.id, 1), { key })),
    );
    expect(results.map((r) => r.statusCode)).toEqual([201, 201, 201, 201, 201]);
    expect(new Set(results.map((r) => r.json().bookingReference)).size).toBe(1);
    expect(await seatsOf(batch.id)).toBe(1);
  });

  it('rejects reusing a key for a different request', async () => {
    const s = await setup();
    const batch = await makeBatch(s);
    const key = fx.idemKey();
    await book(bookingBody(batch.id, 1), { key });
    const reuse = await book(bookingBody(batch.id, 2), { key });
    expect(reuse.statusCode).toBe(409);
    expect(reuse.json().error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('does not remember failures: a retry after sold-out is evaluated again', async () => {
    const s = await setup();
    const batch = await makeBatch(s, { capacity: 1 });
    await book(bookingBody(batch.id, 1));
    const key = fx.idemKey();
    expect((await book(bookingBody(batch.id, 1), { key })).statusCode).toBe(409);
    await app.db.update(batches).set({ capacity: 2 }).where(eq(batches.id, batch.id));
    expect((await book(bookingBody(batch.id, 1), { key })).statusCode).toBe(201);
  });
});

describe('direct-link attribution', () => {
  async function link(organizerId: string, o: { batchId?: string; active?: boolean } = {}) {
    const token = randomUUID().replace(/-/g, '');
    await app.db.insert(directLinks).values({
      organizerId,
      batchId: o.batchId ?? null,
      token,
      active: o.active ?? true,
    });
    return token;
  }

  it('marks bookings through a valid link ORGANIZER_DIRECT with zero commission', async () => {
    const s = await setup({ commissionRateBps: 1000 });
    const batch = await makeBatch(s);
    const res = await book(bookingBody(batch.id, 2, { entryToken: await link(s.org) }));
    expect(res.json().source).toBe('ORGANIZER_DIRECT');
    const [row] = await app.db
      .select()
      .from(bookings)
      .where(eq(bookings.bookingReference, res.json().bookingReference));
    expect(row).toMatchObject({ commissionRateBps: 0, commissionPaise: 0 });
    expect(row!.commissionSnapshot.basis).toBe('ORGANIZER_DIRECT_ZERO');
  });

  it("refuses another organizer's link, a link for a different batch, or a deactivated link", async () => {
    const s = await setup();
    const other = await setup();
    const batch = await makeBatch(s);
    const sibling = await makeBatch(s);
    for (const token of [
      await link(other.org),
      await link(s.org, { batchId: sibling.id }),
      await link(s.org, { active: false }),
    ]) {
      const res = await book(bookingBody(batch.id, 1, { entryToken: token }));
      expect(res.statusCode).toBe(400);
    }
    expect(await seatsOf(batch.id)).toBe(0);
  });
});

describe('viewing and cancelling', () => {
  it('lets whoever holds the access token view and cancel, releasing seats', async () => {
    const s = await setup();
    const batch = await makeBatch(s);
    const created = (await book(bookingBody(batch.id, 3))).json();
    const url = `/v1/bookings/${created.bookingReference}`;

    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: 'GET', url, headers: { 'x-booking-token': 'x'.repeat(32) } }))
        .statusCode,
    ).toBe(404);
    const view = await app.inject({
      method: 'GET',
      url,
      headers: { 'x-booking-token': created.accessToken },
    });
    expect(view.json()).toMatchObject({ status: 'confirmed', guests: expect.any(Array) });
    expect(view.headers['cache-control']).toBe('private, no-store');

    const cancel = await app.inject({
      method: 'POST',
      url: `${url}/cancel`,
      headers: { 'x-booking-token': created.accessToken },
      payload: { reason: 'Change of plans' },
    });
    expect(cancel.json()).toMatchObject({ status: 'cancelled', cancelReason: 'Change of plans' });
    expect(await seatsOf(batch.id)).toBe(0);

    const again = await app.inject({
      method: 'POST',
      url: `${url}/cancel`,
      headers: { 'x-booking-token': created.accessToken },
      payload: {},
    });
    expect(again.statusCode).toBe(409);
  });

  it('attaches bookings to the signed-in user and hides them from others', async () => {
    const s = await setup();
    const batch = await makeBatch(s);
    const me = await fx.user();
    const meHeaders = { authorization: `Bearer ${await keys.sign({ sub: me })}` };
    const created = (await book(bookingBody(batch.id, 1), { headers: meHeaders })).json();

    // A nameless account takes the contact name; a later booking never overwrites it.
    const profile = async () =>
      (await app.inject({ method: 'GET', url: '/v1/me', headers: meHeaders })).json().user;
    expect((await profile()).fullName).toBe('Asha Rao');
    await book(
      bookingBody(batch.id, 1, { contact: { name: 'Someone Else', phone: '+919876543210' } }),
      { headers: meHeaders },
    );
    expect((await profile()).fullName).toBe('Asha Rao');

    const mine = await app.inject({ method: 'GET', url: '/v1/me/bookings', headers: meHeaders });
    expect(
      mine.json().items.map((b: { bookingReference: string }) => b.bookingReference),
    ).toContain(created.bookingReference);

    const stranger = { authorization: `Bearer ${await keys.sign({ sub: await fx.user() })}` };
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/v1/bookings/${created.bookingReference}`,
          headers: stranger,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/v1/bookings/${created.bookingReference}`,
          headers: meHeaders,
        })
      ).statusCode,
    ).toBe(200);
  });

  it('refuses cancellation after departure', async () => {
    const s = await setup();
    const batch = await makeBatch(s);
    const created = (await book(bookingBody(batch.id, 1))).json();
    const past = new Date(Date.now() - HOUR);
    await app.db
      .update(batches)
      .set({ departureAt: past, bookingCutoffAt: past, returnAt: new Date(Date.now() + DAY) })
      .where(eq(batches.id, batch.id));
    const res = await app.inject({
      method: 'POST',
      url: `/v1/bookings/${created.bookingReference}/cancel`,
      headers: { 'x-booking-token': created.accessToken },
      payload: {},
    });
    expect(res.statusCode).toBe(409);
  });

  it('frees seats that others can then book', async () => {
    const s = await setup();
    const batch = await makeBatch(s, { capacity: 1 });
    const first = (await book(bookingBody(batch.id, 1))).json();
    expect((await book(bookingBody(batch.id, 1))).statusCode).toBe(409);
    await app.inject({
      method: 'POST',
      url: `/v1/bookings/${first.bookingReference}/cancel`,
      headers: { 'x-booking-token': first.accessToken },
      payload: {},
    });
    expect((await book(bookingBody(batch.id, 1))).statusCode).toBe(201);
  });
});

describe('organizer view', () => {
  it('lists bookings with source and commission, and totals', async () => {
    const s = await setup({ commissionRateBps: 500 });
    const batch = await makeBatch(s, { pricePaise: 100_000 });
    await book(
      bookingBody(batch.id, 2, { emergencyContact: { name: 'Ravi', phone: '+919811111111' } }),
    );

    const res = await app.inject({
      method: 'GET',
      url: `/v1/organizer/batches/${batch.id}/bookings`,
      headers: s.ownerHeaders,
    });
    expect(res.json()).toMatchObject({
      totals: { confirmedBookings: 1, confirmedSeats: 2, cancelledBookings: 0 },
      items: [
        {
          source: 'MARKETPLACE',
          commissionRateBps: 500,
          commissionPaise: 10_000,
          emergencyContact: { name: 'Ravi' },
          guests: [{ fullName: 'Guest 1' }, { fullName: 'Guest 2' }],
        },
      ],
    });
  });

  it('exports a spreadsheet-safe attendee CSV', async () => {
    const s = await setup();
    const batch = await makeBatch(s);
    await book({
      ...bookingBody(batch.id, 2),
      guests: [{ fullName: 'Asha "Ash" Rao' }, { fullName: '=HYPERLINK("evil")' }],
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/organizer/batches/${batch.id}/attendees.csv`,
      headers: s.ownerHeaders,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="Test_Batch_[0-9a-f-]+_attendees\.csv"$/,
    );
    expect(res.body.charCodeAt(0)).toBe(0xfeff); // BOM for Excel
    const CRLF = String.fromCharCode(13, 10);
    const lines = res.body.slice(1).trim().split(CRLF);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('"#","Traveller","Traveller phone"');
    expect(res.body).toContain('"Asha ""Ash"" Rao"');
    expect(res.body).toContain(`"'=HYPERLINK(""evil"")"`);
  });

  it('cancels a booking (owners yes, trek leads no) and hides other organizers bookings', async () => {
    const s = await setup();
    const batch = await makeBatch(s);
    const created = (await book(bookingBody(batch.id, 2))).json();
    const url = `/v1/organizer/bookings/${created.bookingReference}`;

    const lead = await fx.user();
    await fx.member(s.org, lead, 'trek_lead');
    const staffHeaders = { authorization: `Bearer ${await keys.sign({ sub: lead })}` };
    expect((await app.inject({ method: 'GET', url, headers: staffHeaders })).statusCode).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `${url}/cancel`,
          headers: staffHeaders,
          payload: { reason: 'nope' },
        })
      ).statusCode,
    ).toBe(403);

    const other = await setup();
    expect((await app.inject({ method: 'GET', url, headers: other.ownerHeaders })).statusCode).toBe(
      404,
    );
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/v1/organizer/batches/${batch.id}/bookings`,
          headers: other.ownerHeaders,
        })
      ).statusCode,
    ).toBe(404);

    const res = await app.inject({
      method: 'POST',
      url: `${url}/cancel`,
      headers: s.ownerHeaders,
      payload: { reason: 'Medical advice' },
    });
    expect(res.json()).toMatchObject({ status: 'cancelled', cancelReason: 'Medical advice' });
    expect(await seatsOf(batch.id)).toBe(0);
  });
});
