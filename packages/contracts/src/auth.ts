import { z } from 'zod';
import { Uuid } from './common';
import { PhoneE164 } from './me';

export const SessionResponse = z.object({
  accessToken: z.string(),
  expiresAt: z.iso.datetime(),
  user: z.object({
    id: Uuid,
    email: z.string().nullable(),
    phone: z.string().nullable(),
    fullName: z.string().nullable(),
  }),
});
export type SessionResponse = z.infer<typeof SessionResponse>;

/** Phone sign-in: step 1 sends a one-time code by SMS. */
export const OtpSendRequest = z.object({ phone: PhoneE164 });
export type OtpSendRequest = z.infer<typeof OtpSendRequest>;

export const OtpSendResponse = z.object({
  expiresAt: z.iso.datetime(),
  /** When another code can be requested. */
  resendAt: z.iso.datetime(),
});
export type OtpSendResponse = z.infer<typeof OtpSendResponse>;

/** Step 2: the code signs in, creating the account the first time this number is used. */
export const OtpVerifyRequest = z.object({
  phone: PhoneE164,
  code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code'),
});
export type OtpVerifyRequest = z.infer<typeof OtpVerifyRequest>;
