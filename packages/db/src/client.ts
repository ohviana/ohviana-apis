import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index';

export type Database = PostgresJsDatabase<typeof schema>;
/** A transaction handle; services accept `Database | Tx` so they compose inside transactions. */
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface DbClient {
  db: Database;
  close: () => Promise<void>;
  ping: () => Promise<void>;
}

export interface CreateDbOptions {
  /** Pool size. Keep small: Supabase session pooler limits connections per project. */
  max?: number;
  applicationName?: string;
}

function isLocal(url: string): boolean {
  const host = new URL(url).hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

export function createDb(url: string, opts: CreateDbOptions = {}): DbClient {
  // Supabase's transaction pooler (port 6543) multiplexes connections between transactions, so
  // server-side prepared statements can't be reused there.
  const transactionPooler = new URL(url).port === '6543';
  const client = postgres(url, {
    max: opts.max ?? 10,
    prepare: !transactionPooler,
    ssl: isLocal(url) ? false : 'require',
    idle_timeout: 20,
    connect_timeout: 15,
    connection: { application_name: opts.applicationName ?? 'ohviana' },
    onnotice: () => {},
  });
  const db = drizzle(client, { schema, casing: 'snake_case' });

  return {
    db,
    close: () => client.end({ timeout: 5 }),
    ping: async () => {
      await client`select 1`;
    },
  };
}

export function requireDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set (see .env.example)');
  return url;
}
