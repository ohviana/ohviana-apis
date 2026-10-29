import { randomInt, randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminAuditLog,
  batches,
  bookingGuests,
  bookings,
  organizers,
  organizerTreks,
  phoneOtps,
} from '@ohviana/db';
import { buildApp } from '../src/app';
import { createFixtures, createTestKeys, testConfig } from './helpers';

const SECRET = 'test-session-secret-0123456789abcdef-xyz';
const DAY = 86_400_000;

let app: Awaited<ReturnType<typeof buildApp>>;
let fx: ReturnType<typeof createFixtures>;
let keys: Awaited<ReturnType<typeof createTestKeys>>;
const inbox = new Map<string, string>();
const phones: string[] = [];

beforeAll(async () => {
  keys = await createTestKeys();
  app = await buildApp(testConfig({ AUTH_JWT_SECRET: SECRET }), {
    verifier: keys.verifier,
    otpSender: {
      async send(phone, code) {
        inbox.set(phone, code);
      },
    },
  });
  await app.ready();
  fx = createFixtures(app.db);
});

afterAll(async () => {
  if (phones.length) await app.db.delete(phoneOtps).where(inArray(phoneOtps.phone, phones));
  await fx.cleanup();
  await app.close();
});

function newPhone(): string {
  const phone = `+9191${String(randomInt(0, 1e8)).padStart(8, '0')}`;
  phones.push(phone);
  return phone;
}

/** Signs in with an SMS code, as a traveller does: the session proves this mobile. */
async function phoneSignIn(phone: string) {
  await app.inject({ method: 'POST', url: '/v1/auth/otp/send', payload: { phone } });
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/otp/verify',
    payload: { phone, code: inbox.get(phone) },
  });
  expect(res.statusCode, res.body).toBe(200);
  fx.trackUser(res.json().user.id);
  return { authorization: `Bearer ${res.json().accessToken}` };
}

/** An approved organizer with one trek. */
async function organizer() {
  const owner = await fx.user();
  const org = await fx.organizer();
  await fx.member(org, owner, 'owner');
  const catalog = await fx.catalogTrek({ name: `Kodachadri ${fx.tag}` });
  const [trek] = await app.db
    .insert(organizerTreks)
    .values({
      organizerId: org,
      catalogTrekId: catalog.id,
      title: 'Kodachadri Weekend',
      slug: `t-${randomUUID().slice(0, 8)}`,
      status: 'published',
    })
    .returning();
  const [row] = await app.db.select().from(organizers).where(eq(organizers.id, org));
  return {
    org,
    slug: row!.slug,
    trek: trek!,
    ownerHeaders: { authorization: `Bearer ${await keys.sign({ sub: owner })}` },
  };
}

/** A batch that departed `departedDaysAgo` days ago (negative: in the future), 2 days long. */
async function batch(o: Awaited<ReturnType<typeof organizer>>, departedDaysAgo: number) {
  const departureAt = new Date(Date.now() - departedDaysAgo * DAY);
  const [row] = await app.db
    .insert(batches)
    .values({
      name: `Test_Batch_${randomUUID()}`,
      organizerTrekId: o.trek.id,
      organizerId: o.org,
      departureAt,
      returnAt: new Date(departureAt.getTime() + 2 * DAY),
      bookingCutoffAt: new Date(departureAt.getTime() - DAY),
      pricePaise: 250_000,
      capacity: 10,
      maxSeatsPerBooking: 10,
      status: 'published',
    })
    .returning();
  return row!;
}

/** A confirmed booking with these travellers (name + mobile). */
async function booking(
  b: Awaited<ReturnType<typeof batch>>,
  travellers: { name: string; phone: string | null }[],
) {
  const row = await fx.booking(b, travellers.length);
  const guests = await app.db
    .insert(bookingGuests)
    .values(
      travellers.map((t, position) => ({
        bookingId: row.id,
        fullName: t.name,
        phone: t.phone,
        position,
      })),
    )
    .returning();
  return { booking: row, guests };
}

const trips = (headers: Record<string, string>) =>
  app.inject({ method: 'GET', url: '/v1/me/review-trips', headers });

const review = (headers: Record<string, string>, payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/v1/me/reviews', headers, payload });

describe('travellers review finished trips', () => {
  it('lets each traveller review once, only after the trip is over', async () => {
    const o = await organizer();
    const done = await batch(o, 4);
    const upcoming = await batch(o, -10);
    const rahul = newPhone();
    const priya = newPhone();
    const past = await booking(done, [
      { name: 'Rahul Kumar', phone: rahul },
      { name: 'Priya S', phone: priya },
      { name: 'Sneha', phone: null },
    ]);
    const future = await booking(upcoming, [{ name: 'Rahul Kumar', phone: rahul }]);

    const rahulHeaders = await phoneSignIn(rahul);
    const list = await trips(rahulHeaders);
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().phoneVerified).toBe(true);
    const mine = list.json().items as { bookingGuestId: string; canReview: boolean }[];
    expect(mine).toHaveLength(2);
    expect(mine.find((t) => t.bookingGuestId === past.guests[0]!.id)?.canReview).toBe(true);
    expect(mine.find((t) => t.bookingGuestId === future.guests[0]!.id)?.canReview).toBe(false);

    // Not before the trip has returned.
    const early = await review(rahulHeaders, {
      bookingGuestId: future.guests[0]!.id,
      overall: 5,
    });
    expect(early.statusCode).toBe(409);

    // Not as another traveller on the same booking.
    const asPriya = await review(rahulHeaders, { bookingGuestId: past.guests[1]!.id, overall: 1 });
    expect(asPriya.statusCode).toBe(404);

    const ok = await review(rahulHeaders, {
      bookingGuestId: past.guests[0]!.id,
      overall: 4,
      aspects: { bus: 3, food: 4, leader: 5, safety: 5 },
      comment: '  Great sunrise, the bus was late.  ',
    });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json()).toMatchObject({
      overall: 4,
      aspects: { stay: null, bus: 3, food: 4, leader: 5, safety: 5 },
      comment: 'Great sunrise, the bus was late.',
    });

    const again = await review(rahulHeaders, { bookingGuestId: past.guests[0]!.id, overall: 1 });
    expect(again.statusCode).toBe(409);

    // The friend reviews with their own number; the comment is optional.
    const priyaHeaders = await phoneSignIn(priya);
    const friend = await review(priyaHeaders, { bookingGuestId: past.guests[1]!.id, overall: 5 });
    expect(friend.statusCode, friend.body).toBe(201);
    expect(friend.json().comment).toBeNull();

    const after = (await trips(rahulHeaders)).json().items as {
      bookingGuestId: string;
      canReview: boolean;
      review: { overall: number } | null;
    }[];
    const reviewed = after.find((t) => t.bookingGuestId === past.guests[0]!.id)!;
    expect(reviewed).toMatchObject({ canReview: false, review: { overall: 4 } });

    // Public: first names only, newest first, and the organizer's score.
    const pub = await app.inject({ method: 'GET', url: `/v1/organizers/${o.slug}/reviews` });
    expect(pub.statusCode, pub.body).toBe(200);
    expect(pub.json().items.map((r: { authorName: string }) => r.authorName)).toEqual([
      'Priya',
      'Rahul',
    ]);
    expect(pub.json().items[1]).toMatchObject({
      trekName: `Kodachadri ${fx.tag}`,
      tripDate: done.departureAt.toISOString(),
      reply: null,
    });
    expect(pub.json().summary).toEqual({
      average: 4.5,
      count: 2,
      aspects: { stay: null, bus: 3, food: 4, leader: 5, safety: 5 },
    });

    const profile = await app.inject({ method: 'GET', url: `/v1/organizers/${o.slug}` });
    expect(profile.json().rating).toEqual({ average: 4.5, count: 2 });
    const departures = await app.inject({
      method: 'GET',
      url: `/v1/organizers/${o.slug}/batches`,
    });
    expect(departures.statusCode, departures.body).toBe(200);
    expect(departures.json().items[0].organizer.rating).toEqual({ average: 4.5, count: 2 });
  });

  it('needs a phone sign-in: a password or email session cannot review', async () => {
    const headers = { authorization: `Bearer ${await keys.sign({ sub: await fx.user() })}` };
    const list = await trips(headers);
    expect(list.json()).toEqual({ phoneVerified: false, items: [] });
    const res = await review(headers, { bookingGuestId: randomUUID(), overall: 5 });
    expect(res.statusCode).toBe(403);
    expect((await trips({})).statusCode).toBe(401);
  });

  it('refuses cancelled bookings and bad ratings', async () => {
    const o = await organizer();
    const b = await batch(o, 5);
    const phone = newPhone();
    const { booking: row, guests } = await booking(b, [{ name: 'Arjun', phone }]);
    const headers = await phoneSignIn(phone);

    const bad = await review(headers, {
      bookingGuestId: guests[0]!.id,
      overall: 6,
      aspects: { food: 0 },
    });
    expect(bad.statusCode).toBe(400);

    await app.db
      .update(bookings)
      .set({ status: 'cancelled', cancelledAt: new Date() })
      .where(eq(bookings.id, row.id));
    expect((await trips(headers)).json().items).toHaveLength(0);
    const res = await review(headers, { bookingGuestId: guests[0]!.id, overall: 3 });
    expect(res.statusCode).toBe(409);
  });
});

describe('organizers reply and admins hide', () => {
  it('lets the organizer reply once and an admin hide a review from the score', async () => {
    const o = await organizer();
    const other = await organizer();
    const b = await batch(o, 3);
    const a = newPhone();
    const k = newPhone();
    const { guests } = await booking(b, [
      { name: 'Arjun', phone: a },
      { name: 'Karthik', phone: k },
    ]);
    const low = await review(await phoneSignIn(a), {
      bookingGuestId: guests[0]!.id,
      overall: 1,
      comment: 'Bus came 2 hours late',
    });
    await review(await phoneSignIn(k), { bookingGuestId: guests[1]!.id, overall: 5 });
    const id = low.json().id as string;

    const own = await app.inject({
      method: 'GET',
      url: '/v1/organizer/reviews',
      headers: o.ownerHeaders,
    });
    expect(own.statusCode, own.body).toBe(200);
    expect(own.json().items).toHaveLength(2);

    const replyUrl = `/v1/organizer/reviews/${id}/reply`;
    const stranger = await app.inject({
      method: 'POST',
      url: replyUrl,
      headers: other.ownerHeaders,
      payload: { reply: 'Not ours' },
    });
    expect(stranger.statusCode).toBe(404);

    const replied = await app.inject({
      method: 'POST',
      url: replyUrl,
      headers: o.ownerHeaders,
      payload: { reply: 'Sorry, the bus broke down. New operator from now on.' },
    });
    expect(replied.statusCode, replied.body).toBe(200);
    expect(replied.json().reply.text).toBe('Sorry, the bus broke down. New operator from now on.');
    const twice = await app.inject({
      method: 'POST',
      url: replyUrl,
      headers: o.ownerHeaders,
      payload: { reply: 'Edited' },
    });
    expect(twice.statusCode).toBe(409);

    // Organizers can't hide reviews; admins can.
    const notAdmin = await app.inject({
      method: 'POST',
      url: `/v1/admin/reviews/${id}/hide`,
      headers: o.ownerHeaders,
    });
    expect(notAdmin.statusCode).toBe(403);

    const admin = await fx.user({ admin: true });
    const adminHeaders = { authorization: `Bearer ${await keys.sign({ sub: admin })}` };
    const hidden = await app.inject({
      method: 'POST',
      url: `/v1/admin/reviews/${id}/hide`,
      headers: adminHeaders,
    });
    expect(hidden.statusCode, hidden.body).toBe(200);
    expect(hidden.json()).toMatchObject({ hidden: true, organizer: { id: o.org } });

    const pub = (
      await app.inject({ method: 'GET', url: `/v1/organizers/${o.slug}/reviews` })
    ).json();
    expect(pub.items.map((r: { id: string }) => r.id)).not.toContain(id);
    expect(pub.summary).toMatchObject({ average: 5, count: 1 });
    const flagged = (
      await app.inject({ method: 'GET', url: '/v1/organizer/reviews', headers: o.ownerHeaders })
    ).json().items as { id: string; hidden: boolean }[];
    expect(flagged.find((r) => r.id === id)?.hidden).toBe(true);

    const listed = await app.inject({
      method: 'GET',
      url: '/v1/admin/reviews?hidden=true&limit=100',
      headers: adminHeaders,
    });
    expect(listed.json().items.map((r: { id: string }) => r.id)).toContain(id);

    const shown = await app.inject({
      method: 'POST',
      url: `/v1/admin/reviews/${id}/unhide`,
      headers: adminHeaders,
    });
    expect(shown.json().hidden).toBe(false);
    const audit = await app.db
      .select({ action: adminAuditLog.action })
      .from(adminAuditLog)
      .where(and(eq(adminAuditLog.entityId, id), eq(adminAuditLog.entityType, 'review')));
    expect(audit.map((r) => r.action).sort()).toEqual(['review.hide', 'review.unhide']);
  });
});
