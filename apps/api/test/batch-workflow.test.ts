import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { batches, bookings, users } from '@ohviana/db';
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

/** Batch names capitalise each word. */
const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);

/** Fixed IST wall-clock times far enough ahead to stay in the future. */
const year = new Date().getUTCFullYear() + 1;
const ist = (monthDay: string, time = '06:00') => `${year}-${monthDay}T${time}:00+05:30`;

type Headers = Record<string, string>;
const call = (method: 'GET' | 'POST' | 'DELETE', url: string, headers: Headers, payload?: object) =>
  app.inject({ method, url: `/v1/organizer${url}`, headers, ...(payload ? { payload } : {}) });

async function orgWithOwner(status: OrganizerStatus = 'approved', role = 'owner' as const) {
  const owner = await fx.user();
  const tag = `${fx.tag}x${randomUUID().slice(0, 4)}`;
  const org = await fx.organizer({ status, name: `Peak Pals ${tag}` });
  await fx.member(org, owner, role);
  return {
    org,
    tag,
    headers: { authorization: `Bearer ${await keys.sign({ sub: owner })}` },
  };
}

interface Batch {
  id: string;
  name: string;
  status: string;
  pricePaise: number;
  capacity: number;
  confirmedSeats: number;
  seatsLeft: number;
  departureAt: string;
  bookingCutoffAt: string;
  bookingLinkToken: string | null;
  pickups: { pickupPointId: string; pickupAt: string }[];
}

async function trekBatches(headers: Headers, trekId: string) {
  const res = await call('GET', `/batches?trekId=${trekId}`, headers);
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { items: Batch[] }).items;
}

/** One-form create: trek + pickups + first batch. */
async function createTrekWithBatch(headers: Headers, place: string, publish: boolean) {
  const res = await call('POST', '/treks', headers, {
    title: `${place} Weekend`,
    catalogTrekName: place,
    summary: 'Sunrise trek',
    inclusions: ['Breakfast'],
    pickupPoints: [
      { name: 'Majestic', landmark: 'Platform 1', pickupAt: ist('09-24', '22:00') },
      { name: 'Silk Board' },
    ],
    firstBatch: {
      departureAt: ist('09-25'),
      returnAt: ist('09-26', '20:00'),
      pricePaise: 300_000,
      capacity: 20,
    },
    publish,
  });
  expect(res.statusCode, res.body).toBe(201);
  const trek = res.json() as { id: string; status: string; pickupPoints: { id: string }[] };
  return { trek, batches: await trekBatches(headers, trek.id) };
}

describe('one-form trek creation', () => {
  it('saves the trek live and its first batch as a draft', async () => {
    const { headers, tag } = await orgWithOwner();
    const place = `Kudremukh ${tag}`;
    const { trek, batches: list } = await createTrekWithBatch(headers, place, false);

    expect(trek.status).toBe('published'); // treks have no drafts; the batch does
    expect(trek.pickupPoints).toHaveLength(2);
    expect(list).toHaveLength(1);
    const [b] = list;
    expect(b!.status).toBe('draft');
    expect(b!.name).toBe(`Peak_Pals_${cap(tag)}_Kudremukh_${cap(tag)}_25th_Sept_Batch_1`);
    expect(b!.pickups.map((p) => p.pickupAt).sort()).toEqual(
      [new Date(ist('09-24', '22:00')).toISOString(), b!.departureAt].sort(),
    );
  });

  it('publishes trek and batch in one go', async () => {
    const { headers, tag } = await orgWithOwner();
    const { trek, batches: list } = await createTrekWithBatch(headers, `Netravati ${tag}`, true);
    expect(trek.status).toBe('published');
    expect(list[0]!.status).toBe('published');
  });

  it('gives every batch its own booking link that opens that batch', async () => {
    const { headers, tag } = await orgWithOwner();
    const { batches: list } = await createTrekWithBatch(headers, `Linked ${tag}`, true);
    const batch = list[0]!;
    expect(batch.bookingLinkToken).toMatch(/^[A-Za-z0-9_-]{32}$/);

    const landing = await app.inject({
      method: 'GET',
      url: `/v1/direct/${batch.bookingLinkToken}`,
    });
    expect(landing.statusCode, landing.body).toBe(200);
    expect((landing.json() as { batch: { id: string } }).batch.id).toBe(batch.id);

    const copy = await call('POST', `/batches/${batch.id}/repeat`, headers, {
      departureAt: ist('10-02'),
      returnAt: ist('10-03'),
    });
    const token = (copy.json() as Batch).bookingLinkToken;
    expect(token).toBeTruthy();
    expect(token).not.toBe(batch.bookingLinkToken);
  });

  it('saves nothing when any part is invalid', async () => {
    const { headers, tag } = await orgWithOwner();
    const res = await call('POST', '/treks', headers, {
      title: `Broken ${tag}`,
      catalogTrekName: `Broken ${tag}`,
      pickupPoints: [{ name: 'Majestic' }],
      firstBatch: {
        departureAt: ist('09-25'),
        returnAt: ist('09-24'), // before departure
        pricePaise: 100,
        capacity: 5,
      },
      publish: true,
    });
    expect(res.statusCode).toBe(400);
    const list = await call('GET', '/treks', headers);
    expect((list.json() as { items: unknown[] }).items).toHaveLength(0);
  });

  it('lets a pending organizer save drafts but not publish', async () => {
    const { headers, tag } = await orgWithOwner('pending');
    const res = await call('POST', '/treks', headers, {
      title: `Pending ${tag}`,
      catalogTrekName: `Pending ${tag}`,
      publish: true,
    });
    expect(res.statusCode).toBe(403);
    await createTrekWithBatch(headers, `Pending ${tag}`, false);
  });
});

describe('trek basics: difficulty, altitude, start point, day-0 itinerary', () => {
  it('saves them, publishes without a batch, and fills blanks on the destination', async () => {
    const { headers, tag } = await orgWithOwner();
    const place = `Kodachadri ${tag}`;
    const res = await call('POST', '/treks', headers, {
      title: place,
      catalogTrekName: place,
      durationDays: 2,
      difficulty: 'moderate',
      maxAltitudeM: 1343,
      startPoint: 'Bengaluru',
      itinerary: [
        { day: 0, title: 'Overnight bus from Bengaluru' },
        { day: 1, title: 'Trek to the peak', details: 'Start 6 am from the base village' },
        { day: 2, title: 'Sunrise and descend' },
      ],
      publish: true,
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({
      status: 'published',
      difficulty: 'moderate',
      maxAltitudeM: 1343,
      startPoint: 'Bengaluru',
      itinerary: [{ day: 0 }, { day: 1, details: 'Start 6 am from the base village' }, { day: 2 }],
    });

    const destination = async () =>
      (
        await app.inject({
          method: 'GET',
          url: `/v1/treks/${res.json().catalogTrekName.toLowerCase().replace(/\s+/g, '-')}`,
        })
      ).json();
    expect(await destination()).toMatchObject({ difficulty: 'moderate', maxAltitudeM: 1343 });

    // A second organizer's values don't overwrite the destination's.
    const other = await orgWithOwner();
    const second = await call('POST', '/treks', other.headers, {
      title: place,
      catalogTrekName: place,
      difficulty: 'difficult',
      maxAltitudeM: 1500,
    });
    expect(second.statusCode, second.body).toBe(201);
    expect(second.json()).toMatchObject({ difficulty: 'difficult', maxAltitudeM: 1500 });
    expect(await destination()).toMatchObject({ difficulty: 'moderate', maxAltitudeM: 1343 });
  });

  it('rejects an unknown difficulty', async () => {
    const { headers, tag } = await orgWithOwner();
    const res = await call('POST', '/treks', headers, {
      title: `Odd ${tag}`,
      catalogTrekName: `Odd ${tag}`,
      difficulty: 'extreme',
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('add dates: pickups by name, trek leads, draft or publish', () => {
  async function trekOf(headers: Headers, tag: string) {
    const res = await call('POST', '/treks', headers, {
      title: `Leadpeak ${tag}`,
      catalogTrekName: `Leadpeak ${tag}`,
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as { id: string };
  }
  const body = (extra: object) => ({
    pricePaise: 249_900,
    capacity: 20,
    departures: [
      { departureAt: ist('11-06', '21:30'), returnAt: ist('11-08', '06:00') },
      { departureAt: ist('11-13', '21:30'), returnAt: ist('11-15', '06:00') },
    ],
    ...extra,
  });

  it('adds new pickup points by name, saves leads, and publishes in one go', async () => {
    const { headers, tag } = await orgWithOwner();
    const trek = await trekOf(headers, tag);
    const res = await call(
      'POST',
      `/treks/${trek.id}/batches/bulk`,
      headers,
      body({
        pickups: [
          { name: 'Majestic', minutesFromDeparture: -30 },
          { name: 'Silk Board', minutesFromDeparture: 0 },
        ],
        leads: [{ name: 'Ravi Kumar', phone: '+919845012345' }],
        publish: true,
      }),
    );
    expect(res.statusCode, res.body).toBe(201);
    const items = res.json().items as (Batch & { leads: unknown[] })[];
    expect(items.map((b) => b.status)).toEqual(['published', 'published']);
    expect(items[0]!.leads).toEqual([{ name: 'Ravi Kumar', phone: '+919845012345' }]);
    expect(items[0]!.pickups).toHaveLength(2);
    expect(items[0]!.pickups[0]!.pickupAt).toBe(
      new Date(Date.parse(items[0]!.departureAt) - 30 * 60_000).toISOString(),
    );

    // The names became trek pickup points; using one again reuses it instead of duplicating.
    const again = await call(
      'POST',
      `/treks/${trek.id}/batches/bulk`,
      headers,
      body({
        departures: [{ departureAt: ist('11-20', '21:30'), returnAt: ist('11-22', '06:00') }],
        pickups: [{ name: 'majestic', minutesFromDeparture: -30 }],
      }),
    );
    expect(again.statusCode, again.body).toBe(201);
    expect(again.json().items[0].status).toBe('draft');
    const t = (await call('GET', `/treks/${trek.id}`, headers)).json() as {
      pickupPoints: { name: string }[];
    };
    expect(t.pickupPoints.map((p) => p.name)).toEqual(['Majestic', 'Silk Board']);
  });

  it('rejects a bad lead phone and saves nothing', async () => {
    const { headers, tag } = await orgWithOwner();
    const trek = await trekOf(headers, tag);
    const res = await call(
      'POST',
      `/treks/${trek.id}/batches/bulk`,
      headers,
      body({ leads: [{ name: 'Ravi', phone: '98450' }] }),
    );
    expect(res.statusCode).toBe(400);
    expect(await trekBatches(headers, trek.id)).toHaveLength(0);
  });

  it('lets a pending organizer save drafts but not publish', async () => {
    const { headers, tag } = await orgWithOwner('pending');
    const trek = await trekOf(headers, tag);
    const url = `/treks/${trek.id}/batches/bulk`;
    expect((await call('POST', url, headers, body({ publish: true }))).statusCode).toBe(403);
    expect((await call('POST', url, headers, body({}))).statusCode).toBe(201);
  });
});

describe('batch names', () => {
  it('numbers batches of the same trek on the same day, and starts again on a new day', async () => {
    const { headers, tag } = await orgWithOwner();
    const { trek } = await createTrekWithBatch(headers, `Tadiandamol ${tag}`, false);
    const add = async (departureAt: string, returnAt: string) => {
      const res = await call('POST', `/treks/${trek.id}/batches`, headers, {
        departureAt,
        returnAt,
        pricePaise: 300_000,
        capacity: 20,
      });
      expect(res.statusCode, res.body).toBe(201);
      return (res.json() as Batch).name;
    };
    expect(await add(ist('09-25', '14:00'), ist('09-26', '20:00'))).toMatch(/_25th_Sept_Batch_2$/);
    expect(await add(ist('10-01'), ist('10-02'))).toMatch(/_1st_Oct_Batch_1$/);
  });
});

describe('repeat a batch', () => {
  it('copies price, seats and pickup times onto new dates with a new name', async () => {
    const { headers, tag } = await orgWithOwner();
    const { batches: list } = await createTrekWithBatch(headers, `Kodachadri ${tag}`, true);
    const source = list[0]!;

    const res = await call('POST', `/batches/${source.id}/repeat`, headers, {
      departureAt: ist('10-02'),
      returnAt: ist('10-03', '20:00'),
    });
    expect(res.statusCode, res.body).toBe(201);
    const copy = res.json() as Batch;
    expect(copy.id).not.toBe(source.id);
    expect(copy.status).toBe('draft');
    expect(copy.name).toMatch(new RegExp(`_Kodachadri_${cap(tag)}_2nd_Oct_Batch_1$`));
    expect(copy.pricePaise).toBe(source.pricePaise);
    expect(copy.capacity).toBe(source.capacity);
    expect(copy.confirmedSeats).toBe(0);
    // The 22:00 pickup the evening before keeps its 8-hour lead.
    expect(copy.pickups.map((p) => p.pickupAt)).toContain(
      new Date(ist('10-01', '22:00')).toISOString(),
    );

    const published = await call('POST', `/batches/${source.id}/repeat`, headers, {
      departureAt: ist('10-09'),
      returnAt: ist('10-10', '20:00'),
      publish: true,
    });
    expect((published.json() as Batch).status).toBe('published');
  });

  it("can't repeat another organizer's batch", async () => {
    const a = await orgWithOwner();
    const b = await orgWithOwner();
    const { batches: list } = await createTrekWithBatch(a.headers, `Mine ${a.tag}`, false);
    const res = await call('POST', `/batches/${list[0]!.id}/repeat`, b.headers, {
      departureAt: ist('10-02'),
      returnAt: ist('10-03'),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('organizer-added members', () => {
  it('adds offline members to a draft batch with zero commission and counts their seats', async () => {
    const { headers, tag } = await orgWithOwner();
    const { trek, batches: list } = await createTrekWithBatch(headers, `Skandagiri ${tag}`, false);
    const batch = list[0]!;

    const res = await call('POST', `/batches/${batch.id}/members`, headers, {
      contact: { name: 'Ravi Kumar', phone: '+919876543210' },
      guests: [{ fullName: 'Ravi Kumar' }, { fullName: 'Asha Rao', age: 28 }],
      pickupPointId: trek.pickupPoints[0]!.id,
      unitPricePaise: 250_000,
    });
    expect(res.statusCode, res.body).toBe(201);
    const booking = res.json() as {
      bookingReference: string;
      source: string;
      quantity: number;
      totalPaise: number;
      commissionPaise: number;
    };
    expect(booking).toMatchObject({
      source: 'ORGANIZER_OFFLINE',
      quantity: 2,
      totalPaise: 500_000,
      commissionPaise: 0,
    });
    const [row] = await app.db.select().from(batches).where(eq(batches.id, batch.id));
    expect(row!.confirmedSeats).toBe(2);

    const roster = await call('GET', `/batches/${batch.id}/bookings`, headers);
    expect((roster.json() as { totals: { confirmedSeats: number } }).totals.confirmedSeats).toBe(2);

    // Cancelling releases the seats like any booking.
    const cancel = await call('POST', `/bookings/${booking.bookingReference}/cancel`, headers, {
      reason: 'Changed plans',
    });
    expect(cancel.statusCode, cancel.body).toBe(200);
    const [after] = await app.db.select().from(batches).where(eq(batches.id, batch.id));
    expect(after!.confirmedSeats).toBe(0);
  });

  it("keeps each traveller's own phone and pickup, in the roster and the CSV", async () => {
    const { headers, tag } = await orgWithOwner();
    const { trek, batches: list } = await createTrekWithBatch(headers, `Mullayana ${tag}`, false);
    const batch = list[0]!;
    const [majestic, silkBoard] = trek.pickupPoints as [{ id: string }, { id: string }];

    const res = await call('POST', `/batches/${batch.id}/members`, headers, {
      contact: { name: 'Krishna', phone: '+919876543210' },
      guests: [
        { fullName: 'Krishna', pickupPointId: majestic.id },
        { fullName: 'Rakesh', phone: '+919812345678', pickupPointId: silkBoard.id },
      ],
    });
    expect(res.statusCode, res.body).toBe(201);

    const roster = await call('GET', `/batches/${batch.id}/bookings`, headers);
    const [booking] = (
      roster.json() as {
        items: { guests: { fullName: string; phone: string | null; pickup: { name: string } }[] }[];
      }
    ).items;
    expect(booking!.guests.map((g) => [g.fullName, g.phone, g.pickup.name])).toEqual([
      ['Krishna', '+919876543210', 'Majestic'], // the contact: reached on the contact's number
      ['Rakesh', '+919812345678', 'Silk Board'],
    ]);

    const csv = await app.inject({
      method: 'GET',
      url: `/v1/organizer/batches/${batch.id}/attendees.csv`,
      headers,
    });
    const rows = csv.body.slice(1).trim().split(String.fromCharCode(13, 10));
    expect(rows[1]).toMatch(/^"1","Krishna","\+919876543210","","","Majestic",/);
    expect(rows[2]).toMatch(/^"2","Rakesh","\+919812345678","","","Silk Board",/);

    const wrongStop = await call('POST', `/batches/${batch.id}/members`, headers, {
      contact: { name: 'Solo', phone: '+919876543210' },
      guests: [{ fullName: 'Solo', pickupPointId: randomUUID() }],
    });
    expect(wrongStop.statusCode).toBe(400);
  });

  it('refuses more people than seats left, and pickups from elsewhere', async () => {
    const { headers, tag } = await orgWithOwner();
    const { batches: list } = await createTrekWithBatch(headers, `Ramadevara ${tag}`, false);
    const batch = list[0]!;
    const guests = Array.from({ length: 21 }, (_, i) => ({ fullName: `Guest ${i + 1}` }));
    const full = await call('POST', `/batches/${batch.id}/members`, headers, {
      contact: { name: 'Big Group', phone: '+919876543210' },
      guests,
    });
    expect(full.statusCode).toBe(409);
    expect(full.json()).toMatchObject({ error: { code: 'SOLD_OUT' } });

    const badPickup = await call('POST', `/batches/${batch.id}/members`, headers, {
      contact: { name: 'Solo', phone: '+919876543210' },
      guests: [{ fullName: 'Solo' }],
      pickupPointId: randomUUID(),
    });
    expect(badPickup.statusCode).toBe(400);
    const count = await app.db.select().from(bookings).where(eq(bookings.batchId, batch.id));
    expect(count).toHaveLength(0);
  });

  it("doesn't let a trek lead add members", async () => {
    const { org, headers, tag } = await orgWithOwner();
    const { batches: list } = await createTrekWithBatch(headers, `Staffed ${tag}`, false);
    const lead = await fx.user();
    await fx.member(org, lead, 'trek_lead');
    const res = await call(
      'POST',
      `/batches/${list[0]!.id}/members`,
      { authorization: `Bearer ${await keys.sign({ sub: lead })}` },
      { contact: { name: 'Solo', phone: '+919876543210' }, guests: [{ fullName: 'Solo' }] },
    );
    expect(res.statusCode).toBe(403);
  });
});

describe('trek leads: access to the batches they lead, by mobile', () => {
  it('grants on naming, scopes to led batches, and revokes / restores', async () => {
    const { headers, tag } = await orgWithOwner();
    const phone = `+9170${String(Date.now()).slice(-8)}`;
    const lead = await fx.user();
    await app.db.update(users).set({ phone }).where(eq(users.id, lead));
    const leadHeaders = { authorization: `Bearer ${await keys.sign({ sub: lead })}` };

    const trek = (
      await call('POST', '/treks', headers, { title: `Led ${tag}`, catalogTrekName: `Led ${tag}` })
    ).json() as { id: string };
    const bulk = (leads: object[], monthDay: string) =>
      call('POST', `/treks/${trek.id}/batches/bulk`, headers, {
        pricePaise: 100_000,
        capacity: 10,
        departures: [{ departureAt: ist(monthDay), returnAt: ist(monthDay, '20:00') }],
        leads,
      });
    const led = (await bulk([{ name: 'Lead', phone }], '12-04')).json().items[0] as Batch;
    const other = (await bulk([], '12-11')).json().items[0] as Batch;

    // Named on a batch while already having an account: access straight away.
    const team = (await call('GET', '/members', headers)).json() as {
      items: { userId: string; role: string }[];
    };
    expect(team.items).toContainEqual(expect.objectContaining({ userId: lead, role: 'trek_lead' }));

    const list = await call('GET', '/batches', leadHeaders);
    expect(list.statusCode, list.body).toBe(200);
    expect((list.json().items as Batch[]).map((b) => b.id)).toEqual([led.id]);
    expect((await call('GET', `/batches/${led.id}`, leadHeaders)).statusCode).toBe(200);
    expect((await call('GET', `/batches/${other.id}`, leadHeaders)).statusCode).toBe(404);
    expect((await call('GET', `/batches/${led.id}/bookings`, leadHeaders)).statusCode).toBe(200);
    expect((await call('GET', `/batches/${other.id}/bookings`, leadHeaders)).statusCode).toBe(404);
    // Nothing beyond their batches: no money, treks or team.
    for (const url of ['/dashboard/summary', '/treks', '/members', '/trek-leads']) {
      expect((await call('GET', url, leadHeaders)).statusCode, url).toBe(403);
    }

    const leads = (await call('GET', '/trek-leads', headers)).json().items;
    expect(leads).toEqual([expect.objectContaining({ phone, status: 'active', batchCount: 1 })]);

    const revoked = await call('POST', '/trek-leads/revoke', headers, { phone });
    expect(revoked.json().items[0].status).toBe('revoked');
    expect((await call('GET', '/batches', leadHeaders)).statusCode).toBe(403);
    // Copying a batch doesn't bring a revoked lead back…
    await call('POST', `/batches/${led.id}/repeat`, headers, {
      departureAt: ist('12-18'),
      returnAt: ist('12-18', '20:00'),
    });
    expect((await call('GET', '/batches', leadHeaders)).statusCode).toBe(403);
    // …restoring does.
    const restored = await call('POST', '/trek-leads/restore', headers, { phone });
    expect(restored.json().items[0].status).toBe('active');
    expect((await call('GET', '/batches', leadHeaders)).json().items).toHaveLength(2);
  });

  it('keeps the owner fixed and lets co-owners in by email or mobile', async () => {
    const { org, headers } = await orgWithOwner();
    const team = async () =>
      (await call('GET', '/members', headers)).json().items as { userId: string; role: string }[];
    const owner = (await team())[0]!;
    expect(owner.role).toBe('owner');
    expect((await call('DELETE', `/members/${owner.userId}`, headers)).statusCode).toBe(403);

    const phone = `+9171${String(Date.now()).slice(-8)}`;
    const co = await fx.user();
    await app.db.update(users).set({ phone }).where(eq(users.id, co));
    const added = await call('POST', '/members', headers, { phone });
    expect(added.statusCode, added.body).toBe(201);
    expect(await team()).toContainEqual(expect.objectContaining({ userId: co, role: 'co_owner' }));

    // A co-owner can do what the owner does, except change the owner.
    const coHeaders = { authorization: `Bearer ${await keys.sign({ sub: co })}` };
    expect((await call('GET', '/trek-leads', coHeaders)).statusCode).toBe(200);
    expect((await call('DELETE', `/members/${owner.userId}`, coHeaders)).statusCode).toBe(403);
    expect(org).toBeTruthy();
  });
});
