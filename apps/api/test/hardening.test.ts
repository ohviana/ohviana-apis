import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp, type BuildAppOptions } from '../src/app';
import { createFixtures, createTestKeys, testConfig } from './helpers';

const METRICS_TOKEN = 'metrics-token-for-tests-0123456789';
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
const cleanups: (() => Promise<void>)[] = [];

async function appWith(overrides: Record<string, string>, opts: BuildAppOptions = {}) {
  const app = await buildApp(testConfig(overrides), opts);
  await app.ready();
  apps.push(app);
  return app;
}

afterAll(async () => {
  for (const cleanup of cleanups) await cleanup();
  await Promise.all(apps.map((a) => a.close()));
});

describe('rate limiting', () => {
  it('limits booking attempts per client and answers in the standard envelope', async () => {
    const app = await appWith({ RATE_LIMIT_ENABLED: 'true' });
    const attempt = () =>
      app.inject({
        method: 'POST',
        url: '/v1/bookings',
        headers: { 'idempotency-key': randomUUID() },
        payload: {}, // anonymous on purpose: limits apply before auth, nothing is written
      });

    const codes: number[] = [];
    for (let i = 0; i < 21; i++) codes.push((await attempt()).statusCode);
    expect(codes.slice(0, 20).every((c) => c === 401)).toBe(true);
    expect(codes[20]).toBe(429);

    const limited = await attempt();
    expect(limited.json().error).toMatchObject({
      code: 'RATE_LIMITED',
      requestId: expect.any(String),
    });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('applies a global limit but never to health probes', async () => {
    const app = await appWith({ RATE_LIMIT_ENABLED: 'true', RATE_LIMIT_GLOBAL_MAX: '3' });
    const codes: number[] = [];
    for (let i = 0; i < 4; i++)
      codes.push((await app.inject({ method: 'GET', url: '/v1/me' })).statusCode);
    expect(codes).toEqual([401, 401, 401, 429]);
    for (let i = 0; i < 5; i++) {
      expect((await app.inject({ method: 'GET', url: '/v1/health' })).statusCode).toBe(200);
    }
  });

  it('uses the forwarded client address only when TRUST_PROXY is on', async () => {
    const app = await appWith({
      RATE_LIMIT_ENABLED: 'true',
      RATE_LIMIT_GLOBAL_MAX: '2',
      TRUST_PROXY: 'true',
    });
    const from = (ip: string) =>
      app.inject({ method: 'GET', url: '/v1/me', headers: { 'x-forwarded-for': ip } });
    await from('203.0.113.1');
    await from('203.0.113.1');
    expect((await from('203.0.113.1')).statusCode).toBe(429);
    expect((await from('203.0.113.2')).statusCode).toBe(401);
  });
});

describe('metrics', () => {
  it('is hidden without a configured token', async () => {
    const app = await appWith({});
    expect((await app.inject({ method: 'GET', url: '/internal/metrics' })).statusCode).toBe(404);
  });

  it('exposes request, booking and outbox metrics to the token holder', async () => {
    const keys = await createTestKeys();
    const app = await appWith({ METRICS_TOKEN }, { verifier: keys.verifier });
    const fx = createFixtures(app.db);
    cleanups.push(() => fx.cleanup());
    const customer = await keys.sign({ sub: await fx.user() });
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/internal/metrics',
          headers: { 'x-metrics-token': 'wrong-token-wrong-token-00' },
        })
      ).statusCode,
    ).toBe(404);

    await app.inject({ method: 'GET', url: '/v1/health' });
    await app.inject({
      method: 'POST',
      url: '/v1/bookings',
      headers: { 'idempotency-key': randomUUID(), authorization: `Bearer ${customer}` },
      payload: {
        batchId: randomUUID(),
        quantity: 1,
        contact: { name: 'Test User', phone: '+919876543210' },
        guests: [{ fullName: 'Test User' }],
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/internal/metrics',
      headers: { 'x-metrics-token': METRICS_TOKEN },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toMatch(
      /http_requests_total\{method="GET",route="\/v1\/health",status="200"\} \d+/,
    );
    expect(res.body).toContain('bookings_rejected_total{reason="not_found"} 1');
    expect(res.body).toMatch(/outbox_events\{state="pending"\} \d+/);
    expect(res.body).toContain('process_cpu_user_seconds_total');
  });
});
