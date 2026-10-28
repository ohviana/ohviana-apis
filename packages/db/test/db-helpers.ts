import { expect } from 'vitest';
import { createDb, type DbClient, type Tx } from '../src/client';
import { pgConstraintName } from '../src/errors';

try {
  process.loadEnvFile('../../.env');
} catch {
  // No .env (e.g. CI): rely on the environment.
}

const ROLLBACK = Symbol('rollback');

export function testDb(): DbClient {
  const url = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
  if (!url) throw new Error('Set DATABASE_URL (or DATABASE_URL_TEST) to run DB tests');
  return createDb(url, { max: 2, applicationName: 'ohviana-test' });
}

/**
 * Runs `fn` inside a transaction that is always rolled back, so tests never leave data behind
 * (safe even against a shared dev database).
 */
export async function withRollback(client: DbClient, fn: (tx: Tx) => Promise<void>) {
  try {
    await client.db.transaction(async (tx) => {
      await fn(tx);
      throw ROLLBACK;
    });
  } catch (err) {
    if (err !== ROLLBACK) throw err;
  }
}

/** Asserts `fn` fails on the named constraint. Uses a savepoint so `tx` stays usable. */
export async function expectViolation(
  tx: Tx,
  constraint: string,
  fn: (sp: Tx) => Promise<unknown>,
) {
  let caught: unknown;
  try {
    await tx.transaction(async (sp) => {
      await fn(sp);
    });
  } catch (err) {
    caught = err;
  }
  expect(caught, `expected violation of ${constraint}`).toBeDefined();
  expect(pgConstraintName(caught)).toBe(constraint);
}
