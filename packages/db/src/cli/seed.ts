import { createDb, requireDatabaseUrl } from '../client';
import { seed } from '../seed';

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to seed sample data with NODE_ENV=production');
  process.exit(1);
}

const { db, close } = createDb(requireDatabaseUrl(), { max: 1, applicationName: 'ohviana-seed' });
try {
  const summary = await seed(db);
  console.warn('Seed complete (existing rows left untouched):', summary);
} catch (err) {
  console.error('Seed failed:', err);
  process.exitCode = 1;
} finally {
  await close();
}
