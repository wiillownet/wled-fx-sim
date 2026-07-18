// SPDX-License-Identifier: MIT
// Test code original to this package.
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  averageLight,
  B,
  colorFromPalette,
  cubicwave8,
  ease8InOutCubic,
  G,
  hsv2rgb_rainbow,
  lerp8by8,
  pack,
  qadd8,
  qsub8,
  quadwave8,
  R,
  rgbw32,
  scale8,
  scale8_video,
  scale16,
  triwave8,
  triwave16,
  unpack,
  W,
  type RGB,
} from './lib8.js';

const u8Arb = fc.integer({ min: 0, max: 255 });
const u16Arb = fc.integer({ min: 0, max: 0xffff });
const palArb = fc.array(u8Arb.chain((r) => fc.tuple(fc.constant(r), u8Arb, u8Arb)), {
  minLength: 16,
  maxLength: 16,
}) as fc.Arbitrary<RGB[]>;

const inU8 = (v: number): void => {
  expect(Number.isInteger(v)).toBe(true);
  expect(v).toBeGreaterThanOrEqual(0);
  expect(v).toBeLessThanOrEqual(255);
};

describe('uint8 functions: integer output in [0,255] across the full domain', () => {
  const fns: Record<string, (a: number, b: number) => number> = {
    qadd8,
    qsub8,
    scale8,
    scale8_video,
  };
  for (const [name, fn] of Object.entries(fns)) {
    it(name, () => {
      fc.assert(fc.property(u8Arb, u8Arb, (a, b) => inU8(fn(a, b))));
      inU8(fn(0, 0));
      inU8(fn(255, 255));
      inU8(fn(0, 255));
      inU8(fn(255, 0));
    });
  }

  it('lerp8by8', () => {
    fc.assert(fc.property(u8Arb, u8Arb, u8Arb, (a, b, f) => inU8(lerp8by8(a, b, f))));
  });

  const waves: Record<string, (x: number) => number> = {
    triwave8,
    cubicwave8,
    quadwave8,
    ease8InOutCubic,
  };
  for (const [name, fn] of Object.entries(waves)) {
    it(name, () => {
      fc.assert(fc.property(u8Arb, (x) => inU8(fn(x))));
      inU8(fn(0));
      inU8(fn(255));
    });
  }
});

describe('uint16 functions', () => {
  it('triwave16 stays in [0,0xFFFF]', () => {
    fc.assert(
      fc.property(u16Arb, (x) => {
        const v = triwave16(x);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(0xffff);
      }),
    );
  });

  it('scale16 stays in [0,0xFFFF]', () => {
    fc.assert(
      fc.property(u16Arb, u16Arb, (a, b) => {
        const v = scale16(a, b);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(0xffff);
      }),
    );
  });
});

describe('packed color round-trips', () => {
  it('unpack(pack(rgb)) is identity on u8 triples', () => {
    fc.assert(
      fc.property(u8Arb, u8Arb, u8Arb, (r, g, b) => {
        expect(unpack(pack([r, g, b]))).toEqual([r, g, b]);
      }),
    );
  });

  it('rgbw32 channels read back exactly and the word is unsigned', () => {
    fc.assert(
      fc.property(u8Arb, u8Arb, u8Arb, u8Arb, (r, g, b, w) => {
        const c = rgbw32(r, g, b, w);
        expect(c).toBeGreaterThanOrEqual(0);
        expect([R(c), G(c), B(c), W(c)]).toEqual([r, g, b, w]);
      }),
    );
  });

  it('averageLight is a u8 for any packed color', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0xffffffff }), (c) => inU8(averageLight(c))),
    );
  });
});

describe('colorFromPalette / hsv2rgb_rainbow: no NaN, no throw, channels in range', () => {
  it('colorFromPalette over arbitrary palettes, indexes, brightness, blend modes', () => {
    fc.assert(
      fc.property(
        palArb,
        u8Arb,
        u8Arb,
        fc.integer({ min: 0, max: 2 }),
        (pal, idx, bri, blend) => {
          const c = colorFromPalette(pal, idx, bri, blend);
          expect(Number.isNaN(c)).toBe(false);
          inU8(R(c));
          inU8(G(c));
          inU8(B(c));
        },
      ),
    );
    // parameter extremes
    const flat: RGB[] = Array.from({ length: 16 }, () => [255, 255, 255]);
    for (const idx of [0, 255]) {
      for (const bri of [0, 255]) {
        inU8(R(colorFromPalette(flat, idx, bri)));
      }
    }
  });

  it('hsv2rgb_rainbow over the full 16-bit hue wheel and s/v extremes', () => {
    fc.assert(
      fc.property(u16Arb, u8Arb, u8Arb, (h, s, v) => {
        const c = hsv2rgb_rainbow(h, s, v);
        expect(Number.isNaN(c)).toBe(false);
        inU8(R(c));
        inU8(G(c));
        inU8(B(c));
      }),
    );
    expect(hsv2rgb_rainbow(0, 0, 0)).toBe(0);
    inU8(R(hsv2rgb_rainbow(0xffff, 255, 255)));
  });
});
