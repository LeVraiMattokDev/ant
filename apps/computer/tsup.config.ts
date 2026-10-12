import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  splitting: false,
  // `@ant/shared` is source-only TypeScript: bundle it. npm dependencies stay external.
  noExternal: [/^@ant\//],
});
