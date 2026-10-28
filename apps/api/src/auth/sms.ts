import type { FastifyBaseLogger } from 'fastify';

/** Delivers phone sign-in codes. Swap the implementation when an SMS provider is connected. */
export interface OtpSender {
  send(phone: string, code: string): Promise<void>;
}

/** Shows only the last 4 digits, e.g. +91******3210. */
export function maskPhone(phone: string): string {
  return phone.slice(0, 3) + '*'.repeat(Math.max(0, phone.length - 7)) + phone.slice(-4);
}

/**
 * TEMPORARY (SMS_PROVIDER=log): writes the code to the API log instead of sending an SMS.
 * Anyone who can read the logs can sign in as any number, so connect a provider before launch.
 */
export function createLogOtpSender(log: FastifyBaseLogger): OtpSender {
  return {
    async send(phone, code) {
      // Not under a `phone` key: the logger redacts those.
      log.info({ to: maskPhone(phone) }, `Sign-in code for ${maskPhone(phone)}: ${code}`);
    },
  };
}
