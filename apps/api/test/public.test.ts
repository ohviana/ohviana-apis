import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  batchPickups,
  batches,
  directLinks,
  organizers,
  organizerTreks,
  pickupPoints,
} from '@ohviana/db';
import { createFixtures, createTestApp, createTestKeys, type TestApp } from './helpers';

let app: TestApp;
let fx: ReturnType<typeof createFixtures>;
let keys: Awaited<ReturnType<typeof createTestKeys>>;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const at = (ms: number) => new Date(Date.now() + ms);
/** Calendar day of an instant in India time, e.g. 2026-11-07. */
const istDay = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

type World = Awaited<ReturnType<typeof buildWorld>>;
let w: World;

async function template(
  organizerId: string,
  catalogTrekId: string,
  status: 'draft' | 'published' = 'published',
) {
  const [row] = await app.db
    .insert(organizerTreks)
    .values({
      organizerId,
      catalogTrekId,
      title: `Template ${randomUUID().slice(0, 6)}`,
      slug: `t-${randomUUID().slice(0, 8)}`,
      inclusions: ['Meals'],
      cancellationPolicy: 'Full refund 7 days before',
      status,
    })
    .returning();
  return row!;
}

async function batch(
  trek: typeof organizerTreks.$inferSelect,
  o: {
    departIn: number;
    pricePaise?: number;
    capacity?: number;
    sold?: number;
    cutoffIn?: number;
    status?: 'draft' | 'published' | 'cancelled';
  },
) {
  const departureAt = at(o.departIn);
  const [row] = await app.db
    .insert(batches)
    .values({
      name: `Test_Batch_${randomUUID()}`,
      organizerTrekId: trek.id,
      organizerId: trek.organizerId,
      departureAt,
      returnAt: new Date(departureAt.getTime() + 2 * DAY),
      bookingCutoffAt:
        o.cutoffIn !== undefined ? at(o.cutoffIn) : new Date(departureAt.getTime() - HOUR),
      pricePaise: o.pricePaise ?? 300_000,
      capacity: o.capacity ?? 10,
      confirmedSeats: o.sold ?? 0,
      status: o.status ?? 'published',
    })
    .returning();
  return row!;
}

async function buildWorld() {
  const alpha = await fx.catalogTrek({ name: `Alpha Peak ${fx.tag}` });
  const bravo = await fx.catalogTrek({ name: `Bravo Ridge ${fx.tag}` });
  const draftCatalog = await fx.catalogTrek({ name: `Hidden Draft ${fx.tag}`, status: 'draft' });

  const org1 = await fx.organizer({ name: `Org One ${fx.tag}` });
  const org2 = await fx.organizer({ name: `Org Two ${fx.tag}` });
  const pending = await fx.organizer({ name: `Org Pending ${fx.tag}`, status: 'pending' });
  const suspended = await fx.organizer({ name: `Org Suspended ${fx.tag}`, status: 'suspended' });

  const t1a = await template(org1, alpha.id);
  const t2a = await template(org2, alpha.id);
  const t1b = await template(org1, bravo.id);
  const tPa = await template(pending, alpha.id);
  const tSa = await template(suspended, alpha.id);
  const t1aDraft = await template(org1, alpha.id, 'draft');

  const b = {
    org1Alpha: await batch(t1a, { departIn: 10 * DAY, pricePaise: 300_000 }),
    org2Alpha: await batch(t2a, { departIn: 5 * DAY, pricePaise: 250_000 }),
    soldOut: await batch(t1a, { departIn: 12 * DAY, capacity: 2, sold: 2 }),
    draft: await batch(t1a, { departIn: 8 * DAY, status: 'draft' }),
    pendingOrg: await batch(tPa, { departIn: 6 * DAY }),
    suspendedOrg: await batch(tSa, { departIn: 6 * DAY }),
    bravo: await batch(t1b, { departIn: 40 * DAY, pricePaise: 150_000 }),
    draftTemplate: await batch(t1aDraft, { departIn: 7 * DAY }),
    closed: await batch(t2a, { departIn: 1 * DAY, cutoffIn: -HOUR }),
    cancelled: await batch(t1a, { departIn: 9 * DAY, status: 'cancelled' }),
  };

  const [pickup] = await app.db
    .insert(pickupPoints)
    .values({
      organizerTrekId: t1a.id,
      organizerId: org1,
      name: 'Majestic',
      landmark: 'Platform 1',
    })
    .returning();
  await app.db.insert(batchPickups).values({
    batchId: b.org1Alpha.id,
    organizerTrekId: t1a.id,
    pickupPointId: pickup!.id,
    pickupAt: b.org1Alpha.departureAt,
  });

  const slugOf = async (id: string) =>
    (
      await app.db.select({ slug: organizers.slug }).from(organizers).where(eq(organizers.id, id))
    )[0]!.slug;

  return {
    alpha,
    bravo,
    draftCatalog,
    org1,
    org2,
    pending,
    org1Slug: await slugOf(org1),
    org2Slug: await slugOf(org2),
    pendingSlug: await slugOf(pending),
    b,
  };
}

beforeAll(async () => {
  keys = await createTestKeys();
  app = await createTestApp({ verifier: keys.verifier });
  fx = createFixtures(app.db);
  w = await buildWorld();
});

afterAll(async () => {
  await fx.cleanup();
  await app.close();
});

const get = (url: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url, headers });
const ids = (body: { items: { id: string }[] }) => body.items.map((i) => i.id);

describe('comparing departures of a trek', () => {
  it('shows only bookable departures of approved organizers, soonest first', async () => {
    const res = await get(`/v1/treks/${w.alpha.slug}/batches`);
    expect(res.statusCode).toBe(200);
    expect(ids(res.json())).toEqual([w.b.org2Alpha.id, w.b.org1Alpha.id]);
  });

  it('can include sold-out and closed departures for comparison', async () => {
    const res = await get(`/v1/treks/${w.alpha.slug}/batches?includeUnavailable=true`);
    const items = res.json().items as { id: string; availability: string; seatsLeft: number }[];
    expect(items.map((i) => i.id)).toEqual([
      w.b.closed.id,
      w.b.org2Alpha.id,
      w.b.org1Alpha.id,
      w.b.soldOut.id,
    ]);
    expect(items.map((i) => i.availability)).toEqual([
      'booking_closed',
      'available',
      'available',
      'sold_out',
    ]);
    expect(items[3]!.seatsLeft).toBe(0);
  });

  it('sorts by price and paginates without gaps', async () => {
    const all = ids(
      (
        await get(`/v1/treks/${w.alpha.slug}/batches?sort=price_asc&includeUnavailable=true`)
      ).json(),
    );
    const paged: string[] = [];
    let cursor: string | null = null;
    do {
      const body: { items: { id: string }[]; nextCursor: string | null } = (
        await get(
          `/v1/treks/${w.alpha.slug}/batches?sort=price_asc&includeUnavailable=true&limit=1${cursor ? `&cursor=${cursor}` : ''}`,
        )
      ).json();
      paged.push(...ids(body));
      cursor = body.nextCursor;
    } while (cursor);
    expect(paged).toEqual(all);
    expect(all[0]).toBe(w.b.org2Alpha.id); // cheapest
  });

  it('returns everything needed to compare: organizer, inclusions, policy and pickups', async () => {
    const item = (await get(`/v1/treks/${w.alpha.slug}/batches`)).json().items[1];
    expect(item).toMatchObject({
      id: w.b.org1Alpha.id,
      pricePaise: 300_000,
      seatsLeft: 10,
      organizer: { id: w.org1, name: `Org One ${fx.tag}` },
      trek: { inclusions: ['Meals'], cancellationPolicy: 'Full refund 7 days before' },
      catalogTrek: { slug: w.alpha.slug },
      pickups: [{ name: 'Majestic', landmark: 'Platform 1' }],
    });
    expect(item.organizer).not.toHaveProperty('contactEmail');
  });
});

describe('departure search (Explore page)', () => {
  const search = (qs: string) => get(`/v1/batches?${qs}`);

  it('finds departures by trek name, organizer or day, soonest first', async () => {
    const byTrek = await search(`query=${encodeURIComponent(`Alpha Peak ${fx.tag}`)}`);
    expect(byTrek.statusCode, byTrek.body).toBe(200);
    expect(ids(byTrek.json())).toEqual([w.b.org2Alpha.id, w.b.org1Alpha.id]);

    const byOrg = ids((await search(`query=${encodeURIComponent(`Org One ${fx.tag}`)}`)).json());
    // Typo-tolerant, so similar names may also match; the organizer's own departures, in order.
    expect(byOrg.filter((id) => [w.b.org1Alpha.id, w.b.bravo.id].includes(id))).toEqual([
      w.b.org1Alpha.id,
      w.b.bravo.id,
    ]);

    const day = istDay(w.b.org1Alpha.departureAt);
    const oneDay = ids(
      (await search(`query=${encodeURIComponent(fx.tag)}&from=${day}&to=${day}`)).json(),
    );
    expect(oneDay).toEqual([w.b.org1Alpha.id]);
  });

  it('never shows hidden departures', async () => {
    const all = ids((await search(`query=${encodeURIComponent(fx.tag)}&limit=100`)).json());
    for (const hidden of [w.b.draft, w.b.pendingOrg, w.b.suspendedOrg, w.b.draftTemplate]) {
      expect(all).not.toContain(hidden.id);
    }
  });
});

describe('date windows (IST calendar days)', () => {
  it('filters by departure day', async () => {
    const day = istDay(w.b.org2Alpha.departureAt);
    const res = await get(`/v1/treks/${w.alpha.slug}/batches?from=${day}&to=${day}`);
    expect(ids(res.json())).toEqual([w.b.org2Alpha.id]);
  });

  it('treats 00:30 IST as the IST day, not the previous UTC day', async () => {
    // Isolated trek + organizer so this extra departure doesn't affect other tests' counts.
    const catalog = await fx.catalogTrek({ name: `Boundary ${fx.tag}` });
    const org = await fx.organizer({ name: `Boundary Org ${fx.tag}` });
    const t = await template(org, catalog.id);
    const day = istDay(at(20 * DAY));
    const departureAt = new Date(`${day}T00:30:00+05:30`); // 19:00 UTC on the previous day
    const [early] = await app.db
      .insert(batches)
      .values({
        name: `Test_Batch_${randomUUID()}`,
        organizerTrekId: t.id,
        organizerId: org,
        departureAt,
        returnAt: new Date(departureAt.getTime() + DAY),
        bookingCutoffAt: new Date(departureAt.getTime() - HOUR),
        pricePaise: 100,
        capacity: 5,
        status: 'published',
      })
      .returning();

    const prevDay = istDay(new Date(departureAt.getTime() - DAY));
    const url = (d: string) => `/v1/treks/${catalog.slug}/batches?from=${d}&to=${d}`;
    expect(ids((await get(url(day))).json())).toEqual([early!.id]);
    expect(ids((await get(url(prevDay))).json())).toEqual([]);
  });

  it.each([
    ['to before from', 'from=2026-12-10&to=2026-12-01'],
    ['more than a year', 'from=2026-12-01&to=2028-01-01'],
    ['not a date', 'from=next-friday'],
  ])('rejects %s', async (_label, qs) => {
    expect((await get(`/v1/treks/${w.alpha.slug}/batches?${qs}`)).statusCode).toBe(400);
  });
});

describe('trek search', () => {
  it('summarises availability across organizers', async () => {
    const res = await get(`/v1/treks?query=${encodeURIComponent(`Alpha Peak ${fx.tag}`)}`);
    expect(res.json().items).toEqual([
      expect.objectContaining({
        id: w.alpha.id,
        availability: {
          batchCount: 2,
          organizerCount: 2,
          minPricePaise: 250_000,
          nextDepartureAt: w.b.org2Alpha.departureAt.toISOString(),
        },
      }),
    ]);
  });

  it('tolerates typos', async () => {
    const res = await get(`/v1/treks?query=${encodeURIComponent(`alpa peek ${fx.tag}`)}`);
    expect(ids(res.json())).toContain(w.alpha.id);
  });

  it('with dates, returns only treks that have departures then', async () => {
    const day = istDay(w.b.bravo.departureAt);
    const res = await get(`/v1/treks?query=${fx.tag}&from=${day}&to=${day}`);
    expect(ids(res.json())).toEqual([w.bravo.id]);
  });

  it('without dates, lists published treks even with no departures, never drafts', async () => {
    const res = await get(`/v1/treks?query=${fx.tag}&limit=50`);
    const found = ids(res.json());
    expect(found).toEqual(expect.arrayContaining([w.alpha.id, w.bravo.id]));
    expect(found).not.toContain(w.draftCatalog.id);
    expect((await get(`/v1/treks/${w.draftCatalog.slug}`)).statusCode).toBe(404);
  });

  it('serves the trek page', async () => {
    const res = await get(`/v1/treks/${w.alpha.slug}`);
    expect(res.json()).toMatchObject({ id: w.alpha.id, availability: { batchCount: 2 } });
  });
});

describe('organizers', () => {
  it('lists approved organizers only, with their bookable departure count', async () => {
    const res = await get(`/v1/organizers?query=${encodeURIComponent(`Org ${fx.tag}`)}&limit=50`);
    const items = res.json().items as { id: string; upcomingBatchCount: number }[];
    const found = items.map((i) => i.id);
    expect(found).toEqual(expect.arrayContaining([w.org1, w.org2]));
    expect(found).not.toContain(w.pending);
    expect(items.find((i) => i.id === w.org1)?.upcomingBatchCount).toBe(2);
  });

  it("shows an approved organizer's profile and departures across treks", async () => {
    expect((await get(`/v1/organizers/${w.org1Slug}`)).json()).not.toHaveProperty('gstin');
    const res = await get(`/v1/organizers/${w.org1Slug}/batches`);
    expect(ids(res.json())).toEqual([w.b.org1Alpha.id, w.b.bravo.id]);
  });

  it('shows a track record: past departures that went ahead, trekkers and treks', async () => {
    // A finished departure with 4 trekkers, and a cancelled one that must not count.
    const t = await template(w.org2, w.alpha.id);
    await batch(t, { departIn: -10 * DAY, cutoffIn: -11 * DAY, sold: 4 });
    await batch(t, { departIn: -20 * DAY, cutoffIn: -21 * DAY, status: 'cancelled' });
    const res = await get(`/v1/organizers/${w.org2Slug}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().stats).toEqual({
      completedBatches: 1,
      trekkersHosted: 4,
      treksOffered: 1,
      memberSince: new Date().getUTCFullYear(),
    });
  });

  it('hides unapproved organizers', async () => {
    expect((await get(`/v1/organizers/${w.pendingSlug}`)).statusCode).toBe(404);
    expect((await get(`/v1/organizers/${w.pendingSlug}/batches`)).statusCode).toBe(404);
  });
});

describe('single batch', () => {
  it('shows a published batch, including when sold out', async () => {
    expect((await get(`/v1/batches/${w.b.org1Alpha.id}`)).json()).toMatchObject({
      availability: 'available',
    });
    expect((await get(`/v1/batches/${w.b.soldOut.id}`)).json()).toMatchObject({
      availability: 'sold_out',
    });
  });

  it.each(['draft', 'pendingOrg', 'suspendedOrg', 'draftTemplate', 'cancelled'] as const)(
    'hides a %s batch',
    async (key) => {
      expect((await get(`/v1/batches/${w.b[key].id}`)).statusCode).toBe(404);
    },
  );
});

describe('direct links', () => {
  const link = async (o: {
    organizerId: string;
    batchId?: string;
    active?: boolean;
    expiresAt?: Date;
  }) => {
    const token = randomUUID().replace(/-/g, '');
    await app.db.insert(directLinks).values({
      organizerId: o.organizerId,
      batchId: o.batchId ?? null,
      token,
      active: o.active ?? true,
      expiresAt: o.expiresAt ?? null,
    });
    return token;
  };

  it("resolves an organizer-wide link to that organizer's bookable departures", async () => {
    const res = await get(`/v1/direct/${await link({ organizerId: w.org1 })}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ organizer: { id: w.org1 }, batch: null });
    expect(ids({ items: res.json().batches })).toEqual([w.b.org1Alpha.id, w.b.bravo.id]);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
  });

  it('resolves a batch link', async () => {
    const res = await get(
      `/v1/direct/${await link({ organizerId: w.org1, batchId: w.b.org1Alpha.id })}`,
    );
    expect(res.json()).toMatchObject({ batch: { id: w.b.org1Alpha.id }, batches: [] });
  });

  it('treats inactive, expired, unknown and unapproved-organizer links identically', async () => {
    const tokens = [
      await link({ organizerId: w.org1, active: false }),
      await link({ organizerId: w.org1, expiresAt: at(-HOUR) }),
      await link({ organizerId: w.pending }),
      await link({ organizerId: w.org1, batchId: w.b.draft.id }),
      randomUUID().replace(/-/g, ''),
    ];
    for (const token of tokens) {
      const res = await get(`/v1/direct/${token}`);
      expect(res.statusCode).toBe(404);
      expect(res.json().error.message).toBe('This booking link is no longer valid');
    }
  });
});

describe('caching', () => {
  it('lets shared caches hold anonymous responses briefly, but never personalised ones', async () => {
    expect((await get(`/v1/treks/${w.alpha.slug}`)).headers['cache-control']).toContain(
      's-maxage=30',
    );
    const token = await keys.sign({ sub: await fx.user() });
    const authed = await get(`/v1/treks/${w.alpha.slug}`, { authorization: `Bearer ${token}` });
    expect(authed.headers['cache-control']).toBe('private, no-store');
  });
});

describe('suspension', () => {
  it("removes a suspended organizer's departures from the marketplace immediately", async () => {
    await app.db.update(organizers).set({ status: 'suspended' }).where(eq(organizers.id, w.org2));
    expect(ids((await get(`/v1/treks/${w.alpha.slug}/batches`)).json())).toEqual([
      w.b.org1Alpha.id,
    ]);
    expect((await get(`/v1/batches/${w.b.org2Alpha.id}`)).statusCode).toBe(404);
  });
});
