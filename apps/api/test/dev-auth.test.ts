import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { createFixtures, testConfig } from './helpers';

type App = Awaited<ReturnType<typeof buildApp>>;
let devApp: App;
let normalApp: App;
let fx: ReturnType<typeof createFixtures>;

beforeAll(async () => {
  devApp = await buildApp(testConfig({ AUTH_MODE: 'dev' }));
  normalApp = await buildApp(testConfig());
  await Promise.all([devApp.ready(), normalApp.ready()]);
  fx = createFixtures(devApp.db);
});

afterAll(async () => {
  await fx.cleanup();
  await Promise.all([devApp.close(), normalApp.close()]);
});

const me = (app: App, email: string) =>
  app.inject({ method: 'GET', url: '/v1/me', headers: { 'x-dev-user': email } });

describe('AUTH_MODE=dev (temporary password-less login)', () => {
  it('signs in by email alone and keeps the same identity', async () => {
    const email = `Dev-${fx.tag}@Test.Ohviana.dev`;
    const first = await me(devApp, email);
    expect(first.statusCode).toBe(200);
    const id = fx.trackUser(first.json().user.id);
    expect(first.json().user.email).toBe(email.toLowerCase());
    expect((await me(devApp, email)).json().user.id).toBe(id);
  });

  it("reuses an existing account's id and roles for that email", async () => {
    const adminId = await fx.user({ admin: true, email: `admin-${fx.tag}@test.ohviana.dev` });
    const res = await me(devApp, `admin-${fx.tag}@test.ohviana.dev`);
    expect(res.json()).toMatchObject({ user: { id: adminId }, isAdmin: true });
  });

  it('rejects a value that is not an email', async () => {
    expect((await me(devApp, 'not-an-email')).statusCode).toBe(401);
  });

  it('is ignored entirely in the normal Supabase mode', async () => {
    expect((await me(normalApp, `someone-${fx.tag}@test.ohviana.dev`)).statusCode).toBe(401);
  });

  it('refuses to start in production', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        AUTH_MODE: 'dev',
        DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
        SUPABASE_URL: 'https://x.supabase.co',
      }),
    ).toThrow(/not allowed in production/);
  });
});
