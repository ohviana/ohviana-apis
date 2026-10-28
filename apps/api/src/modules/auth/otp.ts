import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { and, asc, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { phoneOtps, users, type Database } from '@ohviana/db';
import type { OtpSender } from '../../auth/sms';
import { AppError } from '../../lib/errors';

const CODE_TTL_MS = 5 * 60_000;
const RESEND_AFTER_MS = 30_000;
/** Codes per number per hour: caps SMS cost and stops one number being flooded. */
const MAX_SENDS_PER_HOUR = 5;
/** Wrong guesses allowed per code (1 in 10^6 each), after which a new code is needed. */
const MAX_ATTEMPTS = 5;

export interface OtpOptions {
  db: Database;
  sender: OtpSender;
  /** Keys the stored code hashes (AUTH_JWT_SECRET). */
  secret: string;
  /** Testing only: use this code instead of a random one. */
  devCode?: string | undefined;
}

function hashCode(secret: string, phone: string, code: string): string {
  return createHmac('sha256', secret).update(`otp:${phone}:${code}`).digest('base64');
}

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Serializes sends and verifications for one number (released at commit). */
const lockPhone = (tx: Pick<Database, 'execute'>, phone: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'otp:' + phone}))`);

export async function sendOtp(opts: OtpOptions, phone: string) {
  const code = opts.devCode ?? String(randomInt(0, 1_000_000)).padStart(6, '0');
  const now = Date.now();

  const sent = await opts.db.transaction(async (tx) => {
    await lockPhone(tx, phone);
    const recent = await tx
      .select({ createdAt: phoneOtps.createdAt })
      .from(phoneOtps)
      .where(and(eq(phoneOtps.phone, phone), gt(phoneOtps.createdAt, new Date(now - 3_600_000))))
      .orderBy(desc(phoneOtps.createdAt));

    const last = recent[0]?.createdAt.getTime();
    if (last !== undefined && now - last < RESEND_AFTER_MS) {
      const wait = Math.ceil((last + RESEND_AFTER_MS - now) / 1000);
      throw new AppError('RATE_LIMITED', `Wait ${wait}s before asking for another code.`);
    }
    if (recent.length >= MAX_SENDS_PER_HOUR) {
      throw new AppError('RATE_LIMITED', 'Too many codes sent to this number. Try again later.');
    }

    const [row] = await tx
      .insert(phoneOtps)
      .values({
        phone,
        codeHash: hashCode(opts.secret, phone, code),
        expiresAt: new Date(now + CODE_TTL_MS),
      })
      .returning({ createdAt: phoneOtps.createdAt, expiresAt: phoneOtps.expiresAt });
    return row!;
  });

  await opts.sender.send(phone, code);
  return {
    expiresAt: sent.expiresAt.toISOString(),
    resendAt: new Date(sent.createdAt.getTime() + RESEND_AFTER_MS).toISOString(),
  };
}

type VerifyOutcome =
  | { ok: true; user: { id: string; email: string | null; phone: string; fullName: string | null } }
  | { ok: false; message: string };

/**
 * Checks the latest code for `phone` and signs in its account, creating one the first time the
 * number is used. Wrong guesses are counted even though the request fails.
 */
export async function verifyOtp(opts: OtpOptions, phone: string, code: string) {
  const outcome = await opts.db.transaction(async (tx): Promise<VerifyOutcome> => {
    await lockPhone(tx, phone);
    const [otp] = await tx
      .select()
      .from(phoneOtps)
      .where(
        and(
          eq(phoneOtps.phone, phone),
          isNull(phoneOtps.consumedAt),
          gt(phoneOtps.expiresAt, new Date()),
        ),
      )
      .orderBy(desc(phoneOtps.createdAt))
      .limit(1);

    if (!otp || otp.attempts >= MAX_ATTEMPTS) {
      return { ok: false, message: 'This code has expired. Ask for a new one.' };
    }
    if (!sameHash(otp.codeHash, hashCode(opts.secret, phone, code))) {
      await tx
        .update(phoneOtps)
        .set({ attempts: sql`${phoneOtps.attempts} + 1` })
        .where(eq(phoneOtps.id, otp.id));
      return { ok: false, message: 'That code is incorrect.' };
    }
    await tx.update(phoneOtps).set({ consumedAt: new Date() }).where(eq(phoneOtps.id, otp.id));

    const columns = {
      id: users.id,
      email: users.email,
      phone: users.phone,
      fullName: users.fullName,
    };
    // The oldest account with this number, if several were given it through their profile.
    const [existing] = await tx
      .select(columns)
      .from(users)
      .where(eq(users.phone, phone))
      .orderBy(asc(users.createdAt))
      .limit(1);
    const user =
      existing ??
      (await tx.insert(users).values({ id: randomUUID(), phone }).returning(columns))[0]!;
    return { ok: true, user: { ...user, phone } };
  });

  if (!outcome.ok) throw new AppError('UNAUTHENTICATED', outcome.message);
  return outcome.user;
}
