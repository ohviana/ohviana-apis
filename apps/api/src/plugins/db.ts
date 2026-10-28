import fp from 'fastify-plugin';
import { createDb, type Database, type DbClient } from '@ohviana/db';

declare module 'fastify' {
  interface FastifyInstance {
    db: Database;
    dbClient: DbClient;
  }
}

export interface DbPluginOptions {
  url: string;
  poolMax: number;
  /** Inject an existing client (tests); it is then owned and closed by the caller. */
  client?: DbClient;
}

/** One connection pool per process, closed on shutdown. */
export default fp<DbPluginOptions>(
  async (app, opts) => {
    const client =
      opts.client ?? createDb(opts.url, { max: opts.poolMax, applicationName: 'ohviana-api' });
    app.decorate('dbClient', client);
    app.decorate('db', client.db);
    if (!opts.client) {
      app.addHook('onClose', async () => {
        await client.close();
      });
    }
  },
  { name: 'db' },
);
