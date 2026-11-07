import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  ErrorResponse,
  OtpSendRequest,
  OtpSendResponse,
  OtpVerifyRequest,
  SessionResponse,
} from '@ohviana/contracts';
import type { OtpSender } from '../../auth/sms';
import { issueSessionToken } from '../../auth/verifier';
import { grantLeadAccess } from '../organizer/leads.service';
import { sendOtp, verifyOtp } from './otp';

const tags = ['auth'];
const errors = { 400: ErrorResponse, 401: ErrorResponse, 409: ErrorResponse, 429: ErrorResponse };
/** Slows code guessing per client; legitimate users rarely need more. */
const AUTH_LIMIT = { max: 10, timeWindow: '1 minute' };
/** Each send may cost an SMS; per-number limits live in ./otp. */
const OTP_SEND_LIMIT = { max: 5, timeWindow: '1 minute' };

export interface AuthRoutesOptions {
  secret: string;
  otpSender: OtpSender;
  otpDevCode?: string | undefined;
}

/**
 * Phone + SMS code sign-in, run by Ohviana: travellers reviewing their trips and trip leads.
 * Everyone else signs in with Google or an email code through Supabase. Registered only when
 * AUTH_JWT_SECRET is set.
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
