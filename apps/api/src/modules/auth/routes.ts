import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { pgConstraintName, userCredentials, users } from '@ohviana/db';
import {
  ErrorResponse,
  OtpSendRequest,
  OtpSendResponse,
  OtpVerifyRequest,
  SessionResponse,
  SignInRequest,
  SignUpRequest,
} from '@ohviana/contracts';
import { dummyPasswordHash, hashPassword, verifyPassword } from '../../auth/password';
import type { OtpSender } from '../../auth/sms';
import { issueSessionToken } from '../../auth/verifier';
import { AppError, conflict } from '../../lib/errors';
import { grantLeadAccess } from '../organizer/leads.service';
import { sendOtp, verifyOtp } from './otp';

const tags = ['auth'];
const errors = { 400: ErrorResponse, 401: ErrorResponse, 409: ErrorResponse, 429: ErrorResponse };
/** Slows password guessing per client; legitimate users rarely need more. */
const AUTH_LIMIT = { max: 10, timeWindow: '1 minute' };
/** Each send may cost an SMS; per-number limits live in ./otp. */
const OTP_SEND_LIMIT = { max: 5, timeWindow: '1 minute' };

const invalidCredentials = () => new AppError('UNAUTHENTICATED', 'Email or password is incorrect');

export interface AuthRoutesOptions {
  secret: string;
  otpSender: OtpSender;
  otpDevCode?: string | undefined;
}

/**
 * Accounts managed by Ohviana: email + password (organizers, admins; no confirmation emails)
 * and phone + SMS code (customers, at checkout). Registered only when AUTH_JWT_SECRET is set.
 */
export const authRoutes: FastifyPluginAsyncZod<AuthRoutesOptions> = async (app, opts) => {
  const otp = {
    db: app.db,
    sender: opts.otpSender,
    secret: opts.secret,
    devCode: opts.otpDevCode,
  };

  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });

  app.post(
    '/auth/signup',
    {
      config: { rateLimit: AUTH_LIMIT },
      schema: {
        tags,
        summary: 'Create an account with email + password and sign in',
        body: SignUpRequest,
        response: { 201: SessionResponse, ...errors },
      },
    },
    async (request, reply) => {
      const { email, password, fullName } = request.body;
      const passwordHash = await hashPassword(password);

      const user = await app.db
        .transaction(async (tx) => {
          const [existing] = await tx
            .select({
              id: users.id,
              hasPassword: sql<boolean>`${userCredentials.userId} is not null`,
            })
            .from(users)
            .leftJoin(userCredentials, eq(userCredentials.userId, users.id))
            .where(sql`lower(${users.email}) = ${email}`)
            .for('update', { of: users });
          if (existing) {
            // Never let sign-up take over an existing account (e.g. one created another way).
            throw conflict(
              existing.hasPassword
                ? 'An account with this email already exists. Sign in instead.'
                : 'This email already has an Ohviana account without a password. Ask an Ohviana admin to set one.',
            );
          }
          const [created] = await tx
            .insert(users)
            .values({ id: randomUUID(), email, fullName: fullName ?? null })
            .returning({ id: users.id, email: users.email, fullName: users.fullName });
          await tx.insert(userCredentials).values({ userId: created!.id, passwordHash });
          return created!;
        })
        .catch((err: unknown) => {
          // Two sign-ups racing for the same new email: the unique index decides.
          if (pgConstraintName(err) === 'users_email_lower_uq') {
            throw conflict('An account with this email already exists. Sign in instead.');
          }
          throw err;
        });

      const session = await issueSessionToken(opts.secret, user);
      return reply.status(201).send({
        ...session,
        user: { id: user.id, email: user.email ?? email, phone: null, fullName: user.fullName },
      });
    },
  );

  app.post(
    '/auth/signin',
    {
      config: { rateLimit: AUTH_LIMIT },
      schema: {
        tags,
        summary: 'Sign in with email + password',
        body: SignInRequest,
        response: { 200: SessionResponse, ...errors },
      },
    },
    async (request) => {
      const { email, password } = request.body;
      const [row] = await app.db
        .select({
          id: users.id,
          email: users.email,
          phone: users.phone,
          fullName: users.fullName,
          passwordHash: userCredentials.passwordHash,
        })
        .from(users)
        .innerJoin(userCredentials, eq(userCredentials.userId, users.id))
        .where(sql`lower(${users.email}) = ${email}`);

      // Same work whether or not the account exists, so timing doesn't reveal registered emails.
      const ok = await verifyPassword(password, row?.passwordHash ?? (await dummyPasswordHash()));
      if (!row || !ok) throw invalidCredentials();

      const session = await issueSessionToken(opts.secret, row);
      return {
        ...session,
        user: { id: row.id, email: row.email ?? email, phone: row.phone, fullName: row.fullName },
      };
    },
  );

  app.post(
    '/auth/otp/send',
    {
      config: { rateLimit: OTP_SEND_LIMIT },
      schema: {
        tags,
        summary: 'Text a 6-digit sign-in code to a mobile number',
        body: OtpSendRequest,
        response: { 200: OtpSendResponse, ...errors },
      },
    },
    async (request) => sendOtp(otp, request.body.phone),
  );

  app.post(
    '/auth/otp/verify',
    {
      config: { rateLimit: AUTH_LIMIT },
      schema: {
        tags,
        summary: 'Sign in with the code (creates the account on first use)',
        body: OtpVerifyRequest,
        response: { 200: SessionResponse, ...errors },
      },
    },
    async (request) => {
      const user = await verifyOtp(otp, request.body.phone, request.body.code);
      // Named as a trek lead on some organizer's batches? This sign-in unlocks those batches.
      await grantLeadAccess(app.db, user.id, user.phone);
      // The code proved this number, so the session can act for it (e.g. review a trip).
      return { ...(await issueSessionToken(opts.secret, user, { phoneVerified: true })), user };
    },
  );
};
