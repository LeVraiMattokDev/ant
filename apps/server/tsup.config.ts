import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { web: 'src/web.ts', worker: 'src/worker.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  splitting: true,
  // Workspace packages are TypeScript sources: bundle them. npm dependencies stay external.
  noExternal: [/^@ant\//],
});
