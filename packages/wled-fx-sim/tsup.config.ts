import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/lib8.ts',
    'src/segment.ts',
    'src/segment-2d.ts',
    'src/palettes.ts',
    'src/effects.ts',
    'src/particles-1d.ts',
    'src/particles-2d.ts',
  ],
  format: ['esm', 'cjs'],
  dts: true,
  treeshake: true,
  splitting: true,
  sourcemap: true,
  clean: true,
  external: ['@wiillownet/fastled-math'],
});
