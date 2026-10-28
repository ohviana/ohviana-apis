import type { Logger } from 'pino';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

/** Delivery channel for outbox notifications. Throwing marks the event for retry. */
export interface Notifier {
  send(message: EmailMessage): Promise<void>;
}

/** Development/test: records and logs instead of sending (never logs the body: it holds PII). */
export class LogNotifier implements Notifier {
  readonly sent: EmailMessage[] = [];
  constructor(private readonly log?: Logger) {}

  async send(message: EmailMessage) {
    this.sent.push(message);
    this.log?.info({ subject: message.subject }, 'email (not sent: log notifier)');
  }
}

/** Resend HTTP API (https://resend.com). Swap this class to change provider. */
export class ResendNotifier implements Notifier {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(message: EmailMessage) {
    const res = await this.fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: this.from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      // 4xx other than rate limiting won't succeed on retry, but the outbox caps attempts.
      throw new Error(`Email provider responded ${res.status}`);
    }
  }
}
