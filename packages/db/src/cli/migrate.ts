import { requireDatabaseUrl } from '../client';
import { runMigrations } from '../migrate';

const started = Date.now();
try {
  await runMigrations(requireDatabaseUrl());
  console.warn(`Migrations applied in ${Date.now() - started}ms`);
} catch (err) {
  console.error('Migration failed:', err);
  process.exit(1);
}
