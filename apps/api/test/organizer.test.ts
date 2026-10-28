import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { batches, bookingEvents, bookings, outboxEvents, users } from '@ohviana/db';
import type { OrganizerStatus } from '@ohviana/shared';
import { createFixtures, createTestApp, createTestKeys, type TestApp } from './helpers';

let app: TestApp;
let fx: ReturnType<typeof createFixtures>;
let keys: Awaited<ReturnType<typeof createTestKeys>>;

beforeAll(async () => {
  keys = await createTestKeys();
  app = await createTestApp({ verifier: keys.verifier });
  fx = createFixtures(app.db);
});

afterAll(async () => {
  await fx.cleanup();
  await app.close();
});

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const inDays = (n: number, hours = 0) =>
  new Date(Date.now() + n * DAY + hours * HOUR).toISOString();

async function headersFor(userId: string) {
  return { authorization: `Bearer ${await keys.sign({ sub: userId })}` };
}

/** An organizer with an owner, ready to call /v1/organizer as that owner. */
async function orgWithOwner(status: OrganizerStatus = 'approved') {
  const owner = await fx.user();
  const org = await fx.organizer({ status });
  await fx.member(org, owner, 'owner');
  return { org, owner, headers: await headersFor(owner) };
}

type Headers = Record<string, string>;
const call = (
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  headers: Headers,
  payload?: object,
) => app.inject({ method, url: `/v1/organizer${url}`, headers, ...(payload ? { payload } : {}) });

async function publishedTrek(headers: Headers) {
  const catalog = await fx.catalogTrek();
  const res = await call('POST', '/treks', headers, {
    title: `Trek ${randomUUID().slice(0, 6)}`,
    catalogTrekId: catalog.id,
    status: 'published',
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; slug: string };
}

async function draftBatch(headers: Headers, trekId: string, overrides: object = {}) {
  const res = await call('POST', `/treks/${trekId}/batches`, headers, {
    departureAt: inDays(10),
    returnAt: inDays(12),
    bookingCutoffAt: inDays(9),
    pricePaise: 249_900,
    capacity: 10,
    ...overrides,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; status: string; view: string };
}

async function publishedBatch(headers: Headers, trekId: string, overrides: object = {}) {
  const batch = await draftBatch(headers, trekId, overrides);
  const res = await call('POST', `/batches/${batch.id}/publish`, headers);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { id: string; status: string; view: string };
}

const batchRow = async (id: string) =>
  (await app.db.select().from(batches).where(eq(batches.id, id)))[0]!;

// ---------------------------------------------------------------------------

describe('registration', () => {
  it('creates a pending organizer owned by the caller and notifies admins', async () => {
    const user = await fx.user();
    const headers = await headersFor(user);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/organizers',
      headers,
      payload: {
        name: `Western Ghats Explorers ${fx.tag}`,
        contactEmail: 'Team@Example.com',
        contactPhone: '+919812345678',
        gstin: '29abcde1234f1z5',
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const org = res.json();
    fx.trackOrganizer(org.id);
    expect(org).toMatchObject({
      status: 'pending',
      slug: `western-ghats-explorers-${fx.tag}`,
      contactEmail: 'team@example.com',
      gstin: '29ABCDE1234F1Z5',
      commissionRateBps: 0,
    });

    const me = await app.inject({ method: 'GET', url: '/v1/me', headers });
    expect(me.json().memberships).toEqual([
      expect.objectContaining({ organizerId: org.id, role: 'owner' }),
    ]);

    const events = await app.db
      .select()
      .from(outboxEvents)
      .where(sql`${outboxEvents.payload}->>'organizerId' = ${org.id}`);
    expect(events.map((e) => e.topic)).toEqual(['organizer.registered']);
  });

  it('rejects duplicate slugs, bad contact details and anonymous callers', async () => {
    const headers = await headersFor(await fx.user());
    const base = {
      name: 'Dup Org',
      slug: fx.slug('dup-org'),
      contactEmail: 'a@example.com',
      contactPhone: '+919812345678',
    };
    const first = await app.inject({
      method: 'POST',
      url: '/v1/organizers',
      headers,
      payload: base,
    });
    fx.trackOrganizer(first.json().id);
    expect(
      (await app.inject({ method: 'POST', url: '/v1/organizers', headers, payload: base }))
        .statusCode,
    ).toBe(409);

    for (const bad of [
      { contactPhone: '98123' },
      { gstin: 'NOT-A-GSTIN' },
      { contactEmail: 'nope' },
    ]) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/organizers',
        headers,
        payload: { ...base, slug: undefined, ...bad },
      });
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect(
      (await app.inject({ method: 'POST', url: '/v1/organizers', payload: base })).statusCode,
    ).toBe(401);
  });

  it('caps how many organizers one account can own', async () => {
    const headers = await headersFor(await fx.user());
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/organizers',
        headers,
        payload: {
          name: `Cap Org ${fx.tag} ${i}`,
          contactEmail: 'a@example.com',
          contactPhone: '+919812345678',
        },
      });
      if (res.statusCode === 201) fx.trackOrganizer(res.json().id);
      statuses.push(res.statusCode);
    }
    expect(statuses).toEqual([201, 201, 201, 201, 201, 409]);
  });
});

describe('profile', () => {
  it('lets a pending organizer edit its profile and slug', async () => {
    const { headers } = await orgWithOwner('pending');
    const res = await call('PATCH', '/profile', headers, {
      tagline: 'Weekend treks',
      slug: fx.slug('renamed'),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      tagline: 'Weekend treks',
      slug: `renamed-${fx.tag}`,
      status: 'pending',
    });
  });

  it('freezes the slug after approval', async () => {
    const { headers } = await orgWithOwner('approved');
    expect(
      (await call('PATCH', '/profile', headers, { slug: fx.slug('late-rename') })).statusCode,
    ).toBe(409);
  });

  it('shows the rejection reason to a rejected organizer but blocks edits', async () => {
    const { org, headers } = await orgWithOwner('pending');
    const admin = await fx.user({ admin: true });
    await app.inject({
      method: 'POST',
      url: `/v1/admin/organizers/${org}/reject`,
      headers: await headersFor(admin),
      payload: { note: 'Please upload your operator permit' },
    });
    const profile = await call('GET', '/profile', headers);
    expect(profile.json()).toMatchObject({
      status: 'rejected',
      reviewNote: 'Please upload your operator permit',
    });
    expect((await call('PATCH', '/profile', headers, { tagline: 'x' })).statusCode).toBe(403);
  });
});

describe('members', () => {
  it('adds an existing user as co-owner by email and lists the team', async () => {
    const { headers } = await orgWithOwner();
    const newbie = await fx.user({ email: `newbie-${fx.tag}@test.ohviana.dev` });

    const res = await call('POST', '/members', headers, {
      email: `NEWBIE-${fx.tag}@test.ohviana.dev`,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().items).toEqual(
      expect.arrayContaining([expect.objectContaining({ userId: newbie, role: 'co_owner' })]),
    );
    expect(
      (await call('POST', '/members', headers, { email: `newbie-${fx.tag}@test.ohviana.dev` }))
        .statusCode,
    ).toBe(409);
    expect(
      (await call('POST', '/members', headers, { email: 'nobody@example.com' })).statusCode,
    ).toBe(404);
  });

  it("doesn't let trek leads manage members", async () => {
    const { org } = await orgWithOwner();
    const lead = await fx.user();
    await fx.member(org, lead, 'trek_lead');
    const res = await call('POST', '/members', await headersFor(lead), {
      email: 'x@example.com',
    });
    expect(res.statusCode).toBe(403);
  });

  it('never changes or removes the owner', async () => {
    const { owner, headers } = await orgWithOwner();
    expect((await call('DELETE', `/members/${owner}`, headers)).statusCode).toBe(403);
    expect(
      (await call('PATCH', `/members/${owner}`, headers, { role: 'co_owner' })).statusCode,
    ).toBe(403);
  });

  it('allows only one owner per organizer', async () => {
    const { org } = await orgWithOwner();
    await expect(fx.member(org, await fx.user(), 'owner')).rejects.toThrow();
  });
});

describe('trek templates', () => {
  it('creates a template linked to a published catalog trek', async () => {
    const { headers } = await orgWithOwner();
    const catalog = await fx.catalogTrek({ name: `Kudremukh ${fx.tag}` });
    const res = await call('POST', '/treks', headers, {
      title: 'Kudremukh Weekend',
      catalogTrekId: catalog.id,
      inclusions: ['Transport', 'Meals'],
      itinerary: [{ day: 1, title: 'Summit' }],
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({
      slug: 'kudremukh-weekend',
      // No drafts: saved with a destination means live.
      status: 'published',
      catalogTrekName: `Kudremukh ${fx.tag}`,
      inclusions: ['Transport', 'Meals'],
      pickupPoints: [],
    });
  });

  it('refuses unpublished catalog treks and drafts', async () => {
    const { headers } = await orgWithOwner();
    const draft = await fx.catalogTrek({ status: 'draft' });
    expect(
      (await call('POST', '/treks', headers, { title: 'X', catalogTrekId: draft.id })).statusCode,
    ).toBe(400);
    const trek = await publishedTrek(headers);
    expect(
      (await call('PATCH', `/treks/${trek.id}`, headers, { status: 'draft' })).statusCode,
    ).toBe(400);
  });

  it('archives and restores a trek', async () => {
    const { headers } = await orgWithOwner();
    const trek = await publishedTrek(headers);
    const archived = await call('PATCH', `/treks/${trek.id}`, headers, { status: 'archived' });
    expect(archived.json().status).toBe('archived');
    const restored = await call('PATCH', `/treks/${trek.id}`, headers, { status: 'published' });
    expect(restored.json().status).toBe('published');
  });

  it('puts a trek waiting for its destination live once it gets one', async () => {
    const { headers } = await orgWithOwner();
    const waiting = (await call('POST', '/treks', headers, { title: `Waiting ${fx.tag}` })).json();
    expect(waiting.status).toBe('draft');
    const linked = await call('PATCH', `/treks/${waiting.id}`, headers, {
      catalogTrekName: `Linked Peak ${fx.tag}`,
    });
    expect(linked.json()).toMatchObject({ status: 'published', catalogTrekId: expect.any(String) });
  });

  it("links a draft to the organizer's own catalog request, not another organizer's", async () => {
    const { org, owner, headers } = await orgWithOwner();
    const mine = await fx.catalogRequest(org, owner);
    const res = await call('POST', '/treks', headers, {
      title: 'Waiting',
      catalogTrekRequestId: mine.id,
    });
    expect(res.json()).toMatchObject({ catalogTrekRequestId: mine.id, catalogTrekId: null });

    const other = await orgWithOwner();
    const theirs = await fx.catalogRequest(other.org, other.owner);
    expect(
      (await call('POST', '/treks', headers, { title: 'Sneaky', catalogTrekRequestId: theirs.id }))
        .statusCode,
    ).toBe(400);
  });

  it('submits catalog requests that reach the admin queue', async () => {
    const { headers } = await orgWithOwner('pending');
    const res = await call('POST', '/catalog-requests', headers, {
      name: `Ombattu Gudda ${fx.tag}`,
      district: 'Hassan',
    });
    expect(res.statusCode).toBe(201);
    const list = await call('GET', '/catalog-requests', headers);
    expect(list.json().items).toEqual([
      expect.objectContaining({ name: `Ombattu Gudda ${fx.tag}`, status: 'pending' }),
    ]);
  });

  it('adds a new destination to the catalog instantly when named, without approval', async () => {
    const { headers } = await orgWithOwner();
    const name = `Devarayanadurga ${fx.tag}`;
    const res = await call('POST', '/treks', headers, {
      title: 'DD Hills Sunrise',
      catalogTrekName: name,
      catalogDistrict: 'Tumakuru',
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ catalogTrekName: name, catalogTrekId: expect.any(String) });

    // It is a published catalog trek straight away (public page works).
    const slug = name.toLowerCase().replace(/ /g, '-');
    const page = await app.inject({ method: 'GET', url: `/v1/treks/${slug}` });
    expect(page.json()).toMatchObject({ name, district: 'Tumakuru' });

    // Naming it again (any case/spacing) reuses the same entry instead of duplicating.
    const again = await call('POST', '/treks', headers, {
      title: 'DD Hills Night',
      catalogTrekName: `  devarayanadurga   ${fx.tag.toUpperCase()} `,
    });
    expect(again.json().catalogTrekId).toBe(res.json().catalogTrekId);

    // Admins hear about new destinations.
    const events = await app.db
      .select()
      .from(outboxEvents)
      .where(
        sql`${outboxEvents.topic} = 'catalog_trek.auto_created' and ${outboxEvents.payload}->>'name' = ${name}`,
      );
    expect(events).toHaveLength(1);
  });

  it('refuses destinations that admins have archived', async () => {
    const { headers } = await orgWithOwner();
    const archived = await fx.catalogTrek({ status: 'archived', name: `Closed Peak ${fx.tag}` });
    const res = await call('POST', '/treks', headers, {
      title: 'X trek',
      catalogTrekName: archived.name,
    });
    expect(res.statusCode).toBe(400);
  });

  it("hides other organizers' templates (cross-tenant)", async () => {
    const a = await orgWithOwner();
    const b = await orgWithOwner();
    const trek = await publishedTrek(a.headers);
    expect((await call('GET', `/treks/${trek.id}`, b.headers)).statusCode).toBe(404);
    expect(
      (await call('PATCH', `/treks/${trek.id}`, b.headers, { title: 'Hijack' })).statusCode,
    ).toBe(404);
  });

  it('manages pickup points', async () => {
    const { headers } = await orgWithOwner();
    const trek = await publishedTrek(headers);
    const added = await call('POST', `/treks/${trek.id}/pickups`, headers, {
      name: 'Majestic',
      landmark: 'Platform 1',
    });
    expect(added.statusCode).toBe(201);
    const pickupId = added.json().pickupPoints[0].id;

    const updated = await call('PATCH', `/treks/${trek.id}/pickups/${pickupId}`, headers, {
      name: 'Majestic Bus Stand',
    });
    expect(updated.json().pickupPoints[0].name).toBe('Majestic Bus Stand');
    const removed = await call('DELETE', `/treks/${trek.id}/pickups/${pickupId}`, headers);
    expect(removed.json().pickupPoints).toEqual([]);
  });

  it('blocks archiving a template with upcoming published batches', async () => {
    const { headers } = await orgWithOwner();
    const trek = await publishedTrek(headers);
    await publishedBatch(headers, trek.id);
    expect(
      (await call('PATCH', `/treks/${trek.id}`, headers, { status: 'archived' })).statusCode,
    ).toBe(409);
  });
});

describe('batches', () => {
  it('creates a draft batch with pickups from its own template only', async () => {
    const { headers } = await orgWithOwner();
    const trek = await publishedTrek(headers);
    const other = await publishedTrek(headers);
    const pickup = (
      await call('POST', `/treks/${trek.id}/pickups`, headers, { name: 'Silk Board' })
    ).json().pickupPoints[0];
    const foreign = (
      await call('POST', `/treks/${other.id}/pickups`, headers, { name: 'Elsewhere' })
    ).json().pickupPoints[0];

    const batch = await draftBatch(headers, trek.id, {
      pickups: [{ pickupPointId: pickup.id, pickupAt: inDays(10) }],
    });
    expect(batch).toMatchObject({ status: 'draft', view: 'draft' });

    const bad = await call('POST', `/treks/${trek.id}/batches`, headers, {
      departureAt: inDays(10),
      returnAt: inDays(12),
      pricePaise: 1000,
      capacity: 5,
      pickups: [{ pickupPointId: foreign.id, pickupAt: inDays(10) }],
    });
    expect(bad.statusCode).toBe(400);
  });

  it.each([
    ['departure in the past', { departureAt: inDays(-1) }],
    ['return before departure', { returnAt: inDays(9) }],
    ['cutoff after departure', { bookingCutoffAt: inDays(11) }],
    ['zero capacity', { capacity: 0 }],
    ['negative price', { pricePaise: -1 }],
  ])('rejects %s', async (_label, override) => {
    const { headers } = await orgWithOwner();
    const trek = await publishedTrek(headers);
    const res = await call('POST', `/treks/${trek.id}/batches`, headers, {
      departureAt: inDays(10),
      returnAt: inDays(12),
      pricePaise: 1000,
      capacity: 5,
      ...override,
    });
    expect(res.statusCode).toBe(400);
  });

  it('bulk-creates weekly departures that do not share seats, all-or-nothing', async () => {
    const { headers } = await orgWithOwner();
    const trek = await publishedTrek(headers);
    const pickup = (
      await call('POST', `/treks/${trek.id}/pickups`, headers, { name: 'Majestic' })
    ).json().pickupPoints[0];
    const weekly = [0, 1, 2, 3].map((w) => ({
      departureAt: inDays(7 + w * 7),
      returnAt: inDays(9 + w * 7),
    }));

    const res = await call('POST', `/treks/${trek.id}/batches/bulk`, headers, {
      pricePaise: 199_900,
      capacity: 15,
      departures: weekly,
      pickups: [{ pickupPointId: pickup.id, minutesFromDeparture: -30 }],
    });
    expect(res.statusCode, res.body).toBe(201);
    const created = res.json().items;
    expect(created).toHaveLength(4);
    expect(new Set(created.map((b: { id: string }) => b.id)).size).toBe(4);
    expect(created[0].pickups[0].pickupAt).toBe(
      new Date(Date.parse(weekly[0]!.departureAt) - 30 * 60_000).toISOString(),
    );

    const before = (await call('GET', `/batches?trekId=${trek.id}&limit=100`, headers)).json().items
      .length;
    const invalid = await call('POST', `/treks/${trek.id}/batches/bulk`, headers, {
      pricePaise: 199_900,
      capacity: 15,
      departures: [
        { departureAt: inDays(60), returnAt: inDays(61) },
        { departureAt: inDays(-3), returnAt: inDays(-2) },
      ],
    });
    expect(invalid.statusCode).toBe(400);
    expect(
      (await call('GET', `/batches?trekId=${trek.id}&limit=100`, headers)).json().items.length,
    ).toBe(before);
  });

  it('requires an approved organizer, and publishing a batch publishes its trek', async () => {
    const pending = await orgWithOwner('pending');
    const pendingTrek = (
      await call('POST', '/treks', pending.headers, {
        title: 'Prep',
        catalogTrekId: (await fx.catalogTrek()).id,
      })
    ).json();
    const prepared = await draftBatch(pending.headers, pendingTrek.id);
    expect(
      (await call('POST', `/batches/${prepared.id}/publish`, pending.headers)).statusCode,
    ).toBe(403);

    const { headers } = await orgWithOwner();
    const draftTrek = (
      await call('POST', '/treks', headers, {
        title: 'Unpublished',
        catalogTrekId: (await fx.catalogTrek()).id,
      })
    ).json();
    const batch = await draftBatch(headers, draftTrek.id);
    const published = await call('POST', `/batches/${batch.id}/publish`, headers);
    expect(published.json()).toMatchObject({ status: 'published', view: 'upcoming' });
    expect((await call('GET', `/treks/${draftTrek.id}`, headers)).json().status).toBe('published');
    expect((await call('POST', `/batches/${batch.id}/publish`, headers)).statusCode).toBe(409);
  });

  it('publishing a departure also publishes a draft destination so customers can see it', async () => {
    const { headers } = await orgWithOwner();
    const draftDestination = await fx.catalogTrek({
      status: 'draft',
      name: `Draft Peak ${fx.tag}`,
    });
    const trek = (
      await call('POST', '/treks', headers, {
        title: 'Peak trek',
        catalogTrekName: draftDestination.name,
      })
    ).json();
    const batch = await draftBatch(headers, trek.id);
    expect((await call('POST', `/batches/${batch.id}/publish`, headers)).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/v1/batches/${batch.id}` })).statusCode).toBe(
      200,
    );
  });

  it('refuses to publish a batch whose trek has no destination yet', async () => {
    const { headers } = await orgWithOwner();
    const trek = (await call('POST', '/treks', headers, { title: 'No destination' })).json();
    const batch = await draftBatch(headers, trek.id);
    const res = await call('POST', `/batches/${batch.id}/publish`, headers);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toContain('destination');
  });

  it('filters by dashboard view', async () => {
    const { headers } = await orgWithOwner();
    const trek = await publishedTrek(headers);
    const draft = await draftBatch(headers, trek.id);
    const upcoming = await publishedBatch(headers, trek.id);
    const full = await publishedBatch(headers, trek.id, { capacity: 2 });
    await fx.booking(await batchRow(full.id), 2);
    const closed = await publishedBatch(headers, trek.id, {
      bookingCutoffAt: new Date(Date.now() + 2000).toISOString(),
      departureAt: inDays(3),
      returnAt: inDays(4),
    });
    await new Promise((r) => setTimeout(r, 2500));

    const ids = async (view: string) =>
      (await call('GET', `/batches?view=${view}&trekId=${trek.id}`, headers))
        .json()
        .items.map((b: { id: string }) => b.id);
    expect(await ids('draft')).toEqual([draft.id]);
    expect(await ids('upcoming')).toEqual([upcoming.id]);
    expect(await ids('sold_out')).toEqual([full.id]);
    expect(await ids('booking_closed')).toEqual([closed.id]);
  });

  it('enforces edit rules once seats are sold', async () => {
    const { headers } = await orgWithOwner();
    const trek = await publishedTrek(headers);
    const batch = await publishedBatch(headers, trek.id, { capacity: 10 });

    expect(
      (
        await call('PATCH', `/batches/${batch.id}`, headers, {
          departureAt: inDays(11),
          returnAt: inDays(13),
        })
      ).statusCode,
    ).toBe(200);
    await fx.booking(await batchRow(batch.id), 4);

    expect(
      (await call('PATCH', `/batches/${batch.id}`, headers, { departureAt: inDays(15) }))
        .statusCode,
    ).toBe(409);
    expect((await call('PATCH', `/batches/${batch.id}`, headers, { capacity: 3 })).statusCode).toBe(
      409,
    );
    const ok = await call('PATCH', `/batches/${batch.id}`, headers, {
      pricePaise: 299_900,
      capacity: 4,
    });
    expect(ok.json()).toMatchObject({
      pricePaise: 299_900,
      capacity: 4,
      seatsLeft: 0,
      view: 'sold_out',
    });
  });

  it('cancels a batch and all its bookings atomically, with audit events and a notification', async () => {
    const { org, headers } = await orgWithOwner();
    const trek = await publishedTrek(headers);
    const batch = await publishedBatch(headers, trek.id);
    const b1 = await fx.booking(await batchRow(batch.id), 2);
    const b2 = await fx.booking(await batchRow(batch.id), 1);

    const res = await call('POST', `/batches/${batch.id}/cancel`, headers, {
      reason: 'Heavy rain warning',
    });
    expect(res.json()).toMatchObject({
      status: 'cancelled',
      view: 'cancelled',
      confirmedSeats: 0,
      cancelReason: 'Heavy rain warning',
    });

    const rows = await app.db.select().from(bookings).where(eq(bookings.batchId, batch.id));
    expect(rows.every((b) => b.status === 'cancelled' && b.cancelledAt)).toBe(true);
    const events = await app.db
      .select()
      .from(bookingEvents)
      .where(eq(bookingEvents.bookingId, b1.id));
    expect(events.map((e) => e.eventType)).toEqual(['cancelled_by_organizer']);
    const [notice] = await app.db
      .select()
      .from(outboxEvents)
      .where(
        sql`${outboxEvents.topic} = 'batch.cancelled' and ${outboxEvents.payload}->>'organizerId' = ${org}`,
      );
    expect((notice?.payload.bookingIds as string[]).sort()).toEqual([b1.id, b2.id].sort());

    expect(
      (await call('POST', `/batches/${batch.id}/cancel`, headers, { reason: 'again' })).statusCode,
    ).toBe(409);
    expect(
      (await call('PATCH', `/batches/${batch.id}`, headers, { pricePaise: 1 })).statusCode,
    ).toBe(409);
  });

  it('deletes drafts only', async () => {
    const { headers } = await orgWithOwner();
    const trek = await publishedTrek(headers);
    const draft = await draftBatch(headers, trek.id);
    const live = await publishedBatch(headers, trek.id);
    expect((await call('DELETE', `/batches/${draft.id}`, headers)).statusCode).toBe(204);
    expect((await call('GET', `/batches/${draft.id}`, headers)).statusCode).toBe(404);
    expect((await call('DELETE', `/batches/${live.id}`, headers)).statusCode).toBe(409);
    expect(
      (await call('POST', `/batches/${live.id}/cancel`, headers, { reason: 'x'.repeat(5) }))
        .statusCode,
    ).toBe(200);
  });

  it('replaces batch pickups', async () => {
    const { headers } = await orgWithOwner();
    const trek = await publishedTrek(headers);
    const p1 = (await call('POST', `/treks/${trek.id}/pickups`, headers, { name: 'A' })).json()
      .pickupPoints[0];
    const p2 = (
      await call('POST', `/treks/${trek.id}/pickups`, headers, { name: 'B', sortOrder: 1 })
    ).json().pickupPoints[1];
    const batch = await draftBatch(headers, trek.id, {
      pickups: [{ pickupPointId: p1.id, pickupAt: inDays(10) }],
    });

    const res = await call('PUT', `/batches/${batch.id}/pickups`, headers, {
      pickups: [{ pickupPointId: p2.id, pickupAt: inDays(10, 1) }],
    });
    expect(res.json().pickups).toEqual([
      expect.objectContaining({ pickupPointId: p2.id, name: 'B' }),
    ]);
  });

  it("can't touch another organizer's batches (cross-tenant)", async () => {
    const a = await orgWithOwner();
    const b = await orgWithOwner();
    const batch = await publishedBatch(a.headers, (await publishedTrek(a.headers)).id);
    expect((await call('GET', `/batches/${batch.id}`, b.headers)).statusCode).toBe(404);
    expect(
      (await call('PATCH', `/batches/${batch.id}`, b.headers, { pricePaise: 1 })).statusCode,
    ).toBe(404);
    expect(
      (await call('POST', `/batches/${batch.id}/cancel`, b.headers, { reason: 'sabotage' }))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await call('POST', `/treks/${(await publishedTrek(a.headers)).id}/batches`, b.headers, {
          departureAt: inDays(5),
          returnAt: inDays(6),
          pricePaise: 1,
          capacity: 1,
        })
      ).statusCode,
    ).toBe(404);
  });

  it('lets a trek lead read the batch they lead but not change it', async () => {
    const { org, headers } = await orgWithOwner();
    const trek = await publishedTrek(headers);
    const phone = `+9172${String(Date.now()).slice(-8)}`;
    const batch = await draftBatch(headers, trek.id, { leads: [{ name: 'Lead', phone }] });
    const staff = await fx.user();
    await app.db.update(users).set({ phone }).where(eq(users.id, staff));
    await fx.member(org, staff, 'trek_lead');
    const staffHeaders = await headersFor(staff);
    expect((await call('GET', `/batches/${batch.id}`, staffHeaders)).statusCode).toBe(200);
    expect(
      (await call('PATCH', `/batches/${batch.id}`, staffHeaders, { pricePaise: 1 })).statusCode,
    ).toBe(403);
  });

  it('paginates batches in departure order', async () => {
    const { headers } = await orgWithOwner();
    const trek = await publishedTrek(headers);
    await call('POST', `/treks/${trek.id}/batches/bulk`, headers, {
      pricePaise: 100,
      capacity: 5,
      departures: [5, 3, 4, 1, 2].map((d) => ({ departureAt: inDays(d), returnAt: inDays(d, 12) })),
    });
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res: { json: () => { items: { departureAt: string }[]; nextCursor: string | null } } =
        await call(
          'GET',
          `/batches?trekId=${trek.id}&limit=2${cursor ? `&cursor=${cursor}` : ''}`,
          headers,
        );
      const body = res.json();
      seen.push(...body.items.map((b) => b.departureAt));
      cursor = body.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(5);
    expect([...seen].sort()).toEqual(seen);
  });
});

describe('direct links', () => {
  it('needs an approved organizer', async () => {
    const { headers } = await orgWithOwner('pending');
    expect((await call('POST', '/direct-links', headers, { label: 'Instagram' })).statusCode).toBe(
      403,
    );
  });

  it('creates organizer-wide and batch links with unguessable tokens, and deactivates them', async () => {
    const { headers } = await orgWithOwner();
    const batch = await publishedBatch(headers, (await publishedTrek(headers)).id);

    const wide = await call('POST', '/direct-links', headers, { label: 'Instagram bio' });
    const single = await call('POST', '/direct-links', headers, {
      batchId: batch.id,
      label: 'WhatsApp group',
    });
    expect(wide.json()).toMatchObject({ batchId: null, active: true });
    expect(single.json()).toMatchObject({ batchId: batch.id });
    expect(wide.json().token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(wide.json().token).not.toBe(single.json().token);

    const off = await call('POST', `/direct-links/${wide.json().id}/deactivate`, headers);
    expect(off.json().active).toBe(false);
    // Two made here plus the one every batch gets on create.
    expect((await call('GET', '/direct-links', headers)).json().items).toHaveLength(3);
  });

  it("won't link another organizer's batch", async () => {
    const a = await orgWithOwner();
    const b = await orgWithOwner();
    const batch = await publishedBatch(a.headers, (await publishedTrek(a.headers)).id);
    expect((await call('POST', '/direct-links', b.headers, { batchId: batch.id })).statusCode).toBe(
      404,
    );
  });
});

describe('dashboard', () => {
  it('counts batches per view and sums confirmed bookings', async () => {
    const { headers } = await orgWithOwner();
    const trek = await publishedTrek(headers);
    await draftBatch(headers, trek.id);
    const live = await publishedBatch(headers, trek.id, { pricePaise: 100_000 });
    await fx.booking(await batchRow(live.id), 3);
    const added = await call('POST', `/batches/${live.id}/members`, headers, {
      contact: { name: 'Asha Rao', phone: '+919886011223' },
      guests: [{ fullName: 'Asha Rao' }],
      unitPricePaise: 90_000,
    });
    expect(added.statusCode, added.body).toBe(201);

    const res = await call('GET', '/dashboard/summary', headers);
    expect(res.json()).toMatchObject({
      batches: { draft: 1, upcoming: 1, sold_out: 0, cancelled: 0 },
      bookings: {
        confirmed: 2,
        seatsSold: 4,
        grossPaise: 390_000,
        channels: {
          marketplace: { confirmed: 1, seatsSold: 3, grossPaise: 300_000 },
          directLink: { confirmed: 0, seatsSold: 0, grossPaise: 0, commissionPaise: 0 },
          addedByYou: { confirmed: 1, seatsSold: 1, grossPaise: 90_000, commissionPaise: 0 },
        },
      },
    });
  });
});
