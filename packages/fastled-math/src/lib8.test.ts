// SPDX-License-Identifier: MIT
// Test code original to this package.
import { describe, expect, it } from 'vitest';
import type { RGB } from './lib8.js';
import {
  B,
  G,
  LINEARBLEND,
  LINEARBLEND_NOWRAP,
  NOBLEND,
  R,
  colorFromPalette,
  hsv2rgb_rainbow,
  lerp8by8,
  qadd8,
  qsub8,
  rgbw32,
  scale8,
  scale8_video,
  triwave8,
} from './lib8.js';

describe('scale/qadd/qsub/lerp/triwave', () => {
  it('scale8', () => {
    expect(scale8(255, 255)).toBe(255);
    expect(scale8(255, 0)).toBe(0);
    expect(scale8(255, 128)).toBe(128);
    expect(scale8(0, 200)).toBe(0);
  });

  it('scale8_video keeps a non-zero input alive', () => {
    expect(scale8_video(255, 1)).toBe(1); // plain scale8(255,1) would be 0
    expect(scale8_video(0, 255)).toBe(0);
    expect(scale8_video(200, 0)).toBe(0);
  });

  it('qadd8 / qsub8 saturate', () => {
    expect(qadd8(200, 100)).toBe(255);
    expect(qadd8(10, 20)).toBe(30);
    expect(qsub8(10, 20)).toBe(0);
    expect(qsub8(200, 50)).toBe(150);
  });

  it('lerp8by8 interpolates', () => {
    expect(lerp8by8(0, 255, 0)).toBe(0);
    expect(lerp8by8(0, 255, 255)).toBe(255);
    expect(lerp8by8(0, 200, 128)).toBe(100);
  });

  it('triwave8 is a triangle', () => {
    expect(triwave8(0)).toBe(0);
    expect(triwave8(64)).toBe(128);
    expect(triwave8(128)).toBe(254);
    expect(triwave8(192)).toBe(126);
  });
});

describe('rgbw32 packing', () => {
  it('packs unsigned', () => {
    expect(rgbw32(255, 0, 0)).toBe(0xff0000);
    const white = rgbw32(0, 0, 0, 255);
    expect(white).toBe(0xff000000);
    expect(white).toBeGreaterThan(0); // unsigned, not negative
  });
});

describe('colorFromPalette', () => {
  const pal: RGB[] = Array.from({ length: 16 }, (_, i) =>
    i < 8 ? [255, 0, 0] : [0, 0, 255],
  );

  it('reads discrete entries at NOBLEND', () => {
    expect(colorFromPalette(pal, 0, 255, NOBLEND)).toBe(0xff0000);
    expect(colorFromPalette(pal, 128, 255, NOBLEND)).toBe(0x0000ff);
  });

  it('blends between adjacent entries (LINEARBLEND)', () => {
    expect(colorFromPalette(pal, 0, 255, LINEARBLEND)).toBe(0xff0000);
    expect(colorFromPalette(pal, 128, 255, LINEARBLEND)).toBe(0x0000ff);
    // index 120 sits on the red->blue boundary between entry 7 and 8
    expect(colorFromPalette(pal, 120, 255, LINEARBLEND)).toBe(0x7f007f);
  });

  it('brightness scales output', () => {
    const dim = colorFromPalette(pal, 0, 128, LINEARBLEND_NOWRAP);
    expect(R(dim)).toBeLessThan(255);
    expect(R(dim)).toBeGreaterThan(0);
  });
});

describe('hsv2rgb_rainbow', () => {
  it('produces valid RGB across the hue wheel', () => {
    for (let h = 0; h < 0x10000; h += 0x800) {
      const c = hsv2rgb_rainbow(h, 255, 255);
      expect(R(c)).toBeGreaterThanOrEqual(0);
      expect(R(c)).toBeLessThanOrEqual(255);
      expect(G(c)).toBeLessThanOrEqual(255);
      expect(B(c)).toBeLessThanOrEqual(255);
    }
  });

  it('hue 0 is red-dominant, value 0 is black', () => {
    expect(R(hsv2rgb_rainbow(0, 255, 255))).toBe(255);
    expect(hsv2rgb_rainbow(0, 255, 0)).toBe(0);
  });
});
