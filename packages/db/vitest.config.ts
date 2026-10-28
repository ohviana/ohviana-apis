import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tests talk to a real (possibly remote) Postgres.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
