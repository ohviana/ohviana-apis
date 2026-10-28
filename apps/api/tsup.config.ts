import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    server: 'src/server.ts',
    'worker/main': 'src/worker/main.ts',
    migrate: 'src/migrate.ts',
  },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  sourcemap: true,
  clean: true,
  // Workspace packages ship TypeScript source, so bundle them into the API build.
  noExternal: [/^@ohviana\//],
});
