import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  splitting: false,
  dts: false,
});
