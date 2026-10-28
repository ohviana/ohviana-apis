import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // First app boot (swagger, plugins) can be slow on a cold cache, especially on Windows/CI.
    hookTimeout: 30_000,
    // Tests reach a real (possibly remote) Postgres; first TLS connect can take seconds.
    testTimeout: 30_000,
    // Test files share one Supabase project whose session pooler allows only 15 connections;
    // running files one at a time keeps the suite well under that (and leaves room for dev).
    fileParallelism: false,
  },
});
