import { randomInt } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { batches, organizerTreks, phoneOtps, users } from '@ohviana/db';
import { buildApp } from '../src/app';
import { createFixtures, testConfig } from './helpers';

const SECRET = 'test-session-secret-0123456789abcdef-xyz';
let app: Awaited<ReturnType<typeof buildApp>>;
let fx: ReturnType<typeof createFixtures>;
/** Codes "sent by SMS", newest last per number. */
const inbox = new Map<string, string[]>();
const phones: string[] = [];

beforeAll(async () => {
  app = await buildApp(testConfig({ AUTH_JWT_SECRET: SECRET }), {
    otpSender: {
      async send(phone, code) {
        inbox.set(phone, [...(inbox.get(phone) ?? []), code]);
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

/** A fresh number per test, so per-number limits never leak between tests. */
function newPhone(): string {
  const phone = `+9190${String(randomInt(0, 1e8)).padStart(8, '0')}`;
  phones.push(phone);
  return phone;
}

const send = (phone: string) =>
  app.inject({ method: 'POST', url: '/v1/auth/otp/send', payload: { phone } });
const verify = (phone: string, code: string) =>
  app.inject({ method: 'POST', url: '/v1/auth/otp/verify', payload: { phone, code } });
const lastCode = (phone: string) => inbox.get(phone)!.at(-1)!;
const wrong = (code: string) => String((Number(code) + 1) % 1e6).padStart(6, '0');

describe('phone sign-in with an SMS code', () => {
  it('creates the account on first sign-in and returns it on the next', async () => {
    const phone = newPhone();
    const sent = await send(phone);
    expect(sent.statusCode, sent.body).toBe(200);
    expect(lastCode(phone)).toMatch(/^\d{6}$/);

    const first = await verify(phone, lastCode(phone));
    expect(first.statusCode, first.body).toBe(200);
    const body = first.json();
    fx.trackUser(body.user.id);
    expect(body.user).toMatchObject({ phone, email: null });

    const me = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${body.accessToken}` },
    });
    expect(me.statusCode).toBe(200);

    // Only an HMAC of the code is stored.
    const [row] = await app.db.select().from(phoneOtps).where(eq(phoneOtps.phone, phone));
    expect(row!.codeHash).not.toContain(lastCode(phone));

    await app.db
      .update(phoneOtps)
      .set({ createdAt: new Date(Date.now() - 60_000) })
      .where(eq(phoneOtps.phone, phone));
    await send(phone);
    const again = await verify(phone, lastCode(phone));
    expect(again.json().user.id).toBe(body.user.id);
  });

  it('signs in to an existing account that has this number', async () => {
    const id = await fx.user();
    const phone = newPhone();
    await app.db.update(users).set({ phone }).where(eq(users.id, id));
    await send(phone);
    const res = await verify(phone, lastCode(phone));
    expect(res.json().user).toMatchObject({ id, phone });
  });

  it('accepts a code once only', async () => {
    const phone = newPhone();
    await send(phone);
    const code = lastCode(phone);
    fx.trackUser((await verify(phone, code)).json().user.id);
    expect((await verify(phone, code)).statusCode).toBe(401);
  });

  it('locks a code after 5 wrong guesses', async () => {
    const phone = newPhone();
    await send(phone);
    const code = lastCode(phone);
    for (let i = 0; i < 5; i++) {
      const res = await verify(phone, wrong(code));
      expect(res.statusCode).toBe(401);
      expect(res.json().error.message).toBe('That code is incorrect.');
    }
    const locked = await verify(phone, code);
    expect(locked.statusCode).toBe(401);
    expect(locked.json().error.message).toContain('expired');
  });

  it('refuses expired codes', async () => {
    const phone = newPhone();
    await send(phone);
    await app.db
      .update(phoneOtps)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(phoneOtps.phone, phone));
    expect((await verify(phone, lastCode(phone))).statusCode).toBe(401);
  });

  it('limits how often a number can be sent codes', async () => {
    const phone = newPhone();
    expect((await send(phone)).statusCode).toBe(200);
    const tooSoon = await send(phone);
    expect(tooSoon.statusCode).toBe(429);
    expect(tooSoon.json().error.code).toBe('RATE_LIMITED');

    // Past the resend wait, but already 5 codes this hour.
    await app.db
      .update(phoneOtps)
      .set({ createdAt: new Date(Date.now() - 60_000) })
      .where(eq(phoneOtps.phone, phone));
    await app.db.insert(phoneOtps).values(
      Array.from({ length: 4 }, (_, i) => ({
        phone,
        codeHash: 'x',
        expiresAt: new Date(),
        createdAt: new Date(Date.now() - (i + 2) * 60_000),
      })),
    );
    const hourly = await send(phone);
    expect(hourly.statusCode).toBe(429);
    expect(hourly.json().error.message).toContain('Too many codes');
  });

  it('gives a trek lead access to the organizer that named their mobile', async () => {
    const phone = newPhone();
    const org = await fx.organizer();
    const catalog = await fx.catalogTrek();
    const [trek] = await app.db
      .insert(organizerTreks)
      .values({ organizerId: org, catalogTrekId: catalog.id, title: 'Led', slug: `led-${fx.tag}` })
      .returning();
    const departureAt = new Date(Date.now() + 10 * 86_400_000);
    await app.db.insert(batches).values({
      name: `Test_Batch_${fx.tag}_lead`,
      organizerTrekId: trek!.id,
      organizerId: org,
      departureAt,
      returnAt: new Date(departureAt.getTime() + 86_400_000),
      bookingCutoffAt: departureAt,
      pricePaise: 100,
      capacity: 5,
      leads: [{ name: 'Ravi', phone }],
    });

    await send(phone);
    const session = (await verify(phone, lastCode(phone))).json();
    fx.trackUser(session.user.id);
    const me = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${session.accessToken}` },
    });
    expect(me.json().memberships).toEqual([
      expect.objectContaining({ organizerId: org, role: 'trek_lead' }),
    ]);
  });

  it('rejects numbers that are not in E.164 format', async () => {
    expect((await send('9876543210')).statusCode).toBe(400);
  });

  it('uses the fixed testing code when OTP_DEV_CODE is set', async () => {
    const dev = await buildApp(testConfig({ AUTH_JWT_SECRET: SECRET, OTP_DEV_CODE: '123456' }), {
      otpSender: { send: async () => {} },
    });
    await dev.ready();
    const phone = newPhone();
    await dev.inject({ method: 'POST', url: '/v1/auth/otp/send', payload: { phone } });
    const res = await dev.inject({
      method: 'POST',
      url: '/v1/auth/otp/verify',
      payload: { phone, code: '123456' },
    });
    expect(res.statusCode).toBe(200);
    fx.trackUser(res.json().user.id);
    await dev.close();
  });

  it('refuses a fixed testing code in production', () => {
    expect(() => testConfig({ NODE_ENV: 'production', OTP_DEV_CODE: '123456' })).toThrow(
      /OTP_DEV_CODE/,
    );
  });
});
