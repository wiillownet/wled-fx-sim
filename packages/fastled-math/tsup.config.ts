import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/lib8.ts', 'src/palettes.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  treeshake: true,
  splitting: true,
  sourcemap: true,
  clean: true,
});
