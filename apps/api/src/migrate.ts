import { runMigrations } from '@ohviana/db/migrate';

/**
 * Production migration entry (bundled to dist/migrate.js). Run once per deploy, before the new
 * API version starts: `node dist/migrate.js`. Migrations are read from ../migrations.
 */
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}
const started = Date.now();
try {
  await runMigrations(url);
  console.warn(`Migrations applied in ${Date.now() - started}ms`);
} catch (err) {
  console.error('Migration failed:', err);
  process.exit(1);
}
