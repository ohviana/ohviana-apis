import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { batches, idempotencyKeys, organizers, organizerTreks, outboxEvents } from '@ohviana/db';
import { HANDLERS, type Handler, type HandlerContext } from '../src/worker/handlers';
import { findSeatMismatches, purgeExpiredIdempotencyKeys } from '../src/worker/maintenance';
import { LogNotifier, ResendNotifier } from '../src/worker/notifier';
import { backoffSeconds, MAX_ATTEMPTS, processOutboxBatch } from '../src/worker/outbox';
import { createFixtures, createTestApp, type TestApp } from './helpers';

let app: TestApp;
let fx: ReturnType<typeof createFixtures>;
let org: string;

beforeAll(async () => {
  app = await createTestApp();
  fx = createFixtures(app.db);
  org = await fx.organizer();
});

afterAll(async () => {
  await fx.cleanup();
  await app.close();
});

const ctx = (notifier = new LogNotifier()): HandlerContext => ({
  db: app.db,
  notifier,
  siteUrl: 'https://ohviana.test',
  adminEmail: 'ops@ohviana.test',
});

/** Unique topics per test so concurrent test files (and real events) are never touched. */
const topic = (name: string) => `test.${fx.tag}.${name}.${randomUUID().slice(0, 6)}`;

async function enqueue(t: string, extra: Partial<typeof outboxEvents.$inferInsert> = {}) {
  const [row] = await app.db
    .insert(outboxEvents)
    .values({ topic: t, payload: { organizerId: org }, ...extra })
    .returning();
  return row!;
}
const reload = async (id: string) =>
  (await app.db.select().from(outboxEvents).where(eq(outboxEvents.id, id)))[0]!;

describe('outbox processing', () => {
  it('delivers due events once and marks them processed', async () => {
    const t = topic('ok');
    const seen: string[] = [];
    const ev = await enqueue(t);
    const handlers: Record<string, Handler> = { [t]: async () => void seen.push(ev.id) };

    const r = await processOutboxBatch(ctx(), handlers, { topics: [t] });
    expect(r).toMatchObject({ claimed: 1, delivered: 1 });
    expect((await reload(ev.id)).processedAt).toBeInstanceOf(Date);

    expect((await processOutboxBatch(ctx(), handlers, { topics: [t] })).claimed).toBe(0);
    expect(seen).toEqual([ev.id]);
  });

  it('retries failures with exponential backoff', async () => {
    const t = topic('flaky');
    const ev = await enqueue(t);
    const handlers: Record<string, Handler> = {
      [t]: async () => {
        throw new Error('SMTP timeout');
      },
    };
    const before = Date.now();
    const r = await processOutboxBatch(ctx(), handlers, { topics: [t] });
    expect(r).toMatchObject({ claimed: 1, failed: 1 });

    const row = await reload(ev.id);
    expect(row).toMatchObject({ attempts: 1, lastError: 'SMTP timeout', processedAt: null });
    const delay = (row.availableAt.getTime() - before) / 1000;
    expect(delay).toBeGreaterThan(20);
    expect(delay).toBeLessThan(60);
    // Not due again until the backoff passes.
    expect((await processOutboxBatch(ctx(), handlers, { topics: [t] })).claimed).toBe(0);
  });

  it('parks an event after MAX_ATTEMPTS failures (dead letter)', async () => {
    const t = topic('dead');
    const ev = await enqueue(t, { attempts: MAX_ATTEMPTS - 1 });
    const r = await processOutboxBatch(
      ctx(),
      { [t]: async () => Promise.reject(new Error('bounced')) },
      { topics: [t] },
    );
    expect(r.dead).toBe(1);
    const [row] = await app.db.execute<{ parked: boolean }>(
      sql`select available_at = 'infinity'::timestamptz as parked from outbox_events where id = ${ev.id}`,
    );
    expect(row!.parked).toBe(true);
  });

  it('skips events that are not yet due, and marks unknown topics processed', async () => {
    const later = topic('later');
    const unknown = topic('unknown');
    const future = await enqueue(later, { availableAt: new Date(Date.now() + 3_600_000) });
    const orphan = await enqueue(unknown);
    const seenTopics: string[] = [];

    await processOutboxBatch(
      ctx(),
      {},
      { topics: [later, unknown], onUnknownTopic: (x) => seenTopics.push(x) },
    );
    expect((await reload(future.id)).processedAt).toBeNull();
    expect((await reload(orphan.id)).processedAt).toBeInstanceOf(Date);
    expect(seenTopics).toEqual([unknown]);
  });

  it('never hands the same event to two workers at once', async () => {
    const t = topic('race');
    const ids = (await Promise.all(Array.from({ length: 6 }, () => enqueue(t)))).map((e) => e.id);
    const handled: string[] = [];
    const handlers: Record<string, Handler> = {
      [t]: async (_ctx, p) => void handled.push(String((p as { organizerId: string }).organizerId)),
    };
    const results = await Promise.all([
      processOutboxBatch(ctx(), handlers, { topics: [t], limit: 4 }),
      processOutboxBatch(ctx(), handlers, { topics: [t], limit: 4 }),
    ]);
    expect(results[0]!.claimed + results[1]!.claimed).toBe(6);
    expect(handled).toHaveLength(6);
    const rows = await app.db.select().from(outboxEvents).where(inArray(outboxEvents.id, ids));
    expect(rows.every((r) => r.processedAt)).toBe(true);
  });

  it('computes capped backoff', () => {
    expect([1, 2, 3, 10].map(backoffSeconds)).toEqual([30, 60, 120, 3600]);
  });
});

describe('notification handlers', () => {
  it('emails the customer and the organizer when a booking is confirmed', async () => {
    const owner = await fx.user();
    const o = await fx.organizer({ name: `Mail Org ${fx.tag}` });
    await fx.member(o, owner, 'owner');
    await app.db
      .update(organizers)
      .set({ contactEmail: 'team@mailorg.test' })
      .where(eq(organizers.id, o));
    const catalog = await fx.catalogTrek();
    const [trek] = await app.db
      .insert(organizerTreks)
      .values({
        organizerId: o,
        catalogTrekId: catalog.id,
        title: 'Mail Trek',
        slug: `m-${fx.tag}`,
        status: 'published',
        cancellationPolicy: 'No refunds',
      })
      .returning();
    const departureAt = new Date('2026-12-04T16:00:00Z');
    const [batch] = await app.db
      .insert(batches)
      .values({
        name: `Test_Batch_${randomUUID()}`,
        organizerTrekId: trek!.id,
        organizerId: o,
        departureAt,
        returnAt: new Date(departureAt.getTime() + 86_400_000),
        bookingCutoffAt: departureAt,
        pricePaise: 199_900,
        capacity: 5,
        status: 'published',
      })
      .returning();
    const booking = await fx.booking(batch!, 2);
    await app.db.execute(
      sql`update bookings set contact_email = 'asha@example.com',
        policy_snapshot = jsonb_set(policy_snapshot, '{cancellationPolicy}', '"No refunds"')
        where id = ${booking.id}`,
    );

    const notifier = new LogNotifier();
    await HANDLERS['booking.confirmed']!(ctx(notifier), { organizerId: o, bookingId: booking.id });

    expect(notifier.sent.map((m) => m.to)).toEqual(['asha@example.com', 'team@mailorg.test']);
    const [customer] = notifier.sent;
    expect(customer!.subject).toContain(booking.bookingReference);
    // 2026-12-04 16:00 UTC is 9:30 pm IST the same day.
    expect(customer!.text).toMatch(/Departs: Fri, 4 Dec,? 2026, 9:30 pm IST/);
    expect(customer!.text).toContain('Total: ₹3,998.00');
    expect(customer!.text).toContain('Cancellation policy: No refunds');
  });

  it('notifies admins about new organizers only when an admin address is configured', async () => {
    const notifier = new LogNotifier();
    await HANDLERS['organizer.registered']!({ ...ctx(notifier), adminEmail: null }, { name: 'X' });
    expect(notifier.sent).toHaveLength(0);
    await HANDLERS['organizer.registered']!(ctx(notifier), { name: 'Trail Co' });
    expect(notifier.sent[0]).toMatchObject({
      to: 'ops@ohviana.test',
      subject: '[Ohviana admin] New organizer: Trail Co',
    });
  });

  it('sends through Resend and surfaces provider errors for retry', async () => {
    const calls: { url: string; body: unknown }[] = [];
    const ok = new ResendNotifier('key', 'Ohviana <a@b.test>', (async (
      url: string,
      init: RequestInit,
    ) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response('{}', { status: 200 });
    }) as typeof fetch);
    await ok.send({ to: 'x@y.test', subject: 'S', text: 'T' });
    expect(calls[0]).toMatchObject({
      url: 'https://api.resend.com/emails',
      body: { to: ['x@y.test'], subject: 'S' },
    });

    const failing = new ResendNotifier(
      'key',
      'a@b.test',
      (async () => new Response('', { status: 503 })) as unknown as typeof fetch,
    );
    await expect(failing.send({ to: 'x@y.test', subject: 'S', text: 'T' })).rejects.toThrow('503');
  });
});

describe('maintenance', () => {
  it('flags batches whose seat counter disagrees with bookings', async () => {
    const catalog = await fx.catalogTrek();
    const [trek] = await app.db
      .insert(organizerTreks)
      .values({
        organizerId: org,
        catalogTrekId: catalog.id,
        title: 'Recon',
        slug: `r-${fx.tag}`,
        status: 'published',
      })
      .returning();
    const make = async () => {
      const departureAt = new Date(Date.now() + 10 * 86_400_000);
      const [b] = await app.db
        .insert(batches)
        .values({
          name: `Test_Batch_${randomUUID()}`,
          organizerTrekId: trek!.id,
          organizerId: org,
          departureAt,
          returnAt: new Date(departureAt.getTime() + 86_400_000),
          bookingCutoffAt: departureAt,
          pricePaise: 100,
          capacity: 10,
          status: 'published',
        })
        .returning();
      return b!;
    };
    const consistent = await make();
    await fx.booking(consistent, 2);
    const drifted = await make();
    await app.db.update(batches).set({ confirmedSeats: 3 }).where(eq(batches.id, drifted.id));

    const mismatches = await findSeatMismatches(app.db);
    expect(mismatches).toContainEqual({ batchId: drifted.id, recordedSeats: 3, bookedSeats: 0 });
    expect(mismatches.map((m) => m.batchId)).not.toContain(consistent.id);
  });

  it('purges expired idempotency keys', async () => {
    const key = `${fx.tag}-expired`;
    await app.db
      .insert(idempotencyKeys)
      .values({ scope: 'anon', key, requestHash: 'x', expiresAt: new Date(Date.now() - 1000) });
    await purgeExpiredIdempotencyKeys(app.db);
    expect(
      await app.db.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, key)),
    ).toHaveLength(0);
  });
});
