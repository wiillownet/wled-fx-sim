import { describe, expect, it } from 'vitest';
import {
  PRNG,
  R,
  beatsin8_t,
  color_blend,
  color_fade,
  cos8_t,
  inoise8,
  sin16_t,
  sin8_t,
} from './lib8.js';

// Anchors below are the exact outputs of WLED 16.0's integer math (wled_math.cpp
// / util.cpp / colors.cpp / prng.h), NOT FastLED's table sin8 -- WLED replaced
// those. Verified against a faithful replica of the firmware source.

describe('sin8_t / cos8_t / sin16_t', () => {
  it('sin8_t hits the firmware anchors', () => {
    expect(sin8_t(0)).toBe(128);
    expect(sin8_t(64)).toBe(255);
    expect(sin8_t(128)).toBe(126); // WLED's approximation, not exactly 128
    expect(sin8_t(192)).toBe(0);
    expect(sin8_t(255)).toBe(128);
  });

  it('sin8_t wraps its 8-bit input (256 == 0)', () => {
    expect(sin8_t(256)).toBe(sin8_t(0));
    expect(sin8_t(320)).toBe(sin8_t(64));
  });

  it('cos8_t is sin8_t shifted by 64', () => {
    expect(cos8_t(0)).toBe(255);
    expect(cos8_t(64)).toBe(126);
    expect(cos8_t(128)).toBe(0);
  });

  it('sin16_t hits the firmware anchors', () => {
    expect(sin16_t(0)).toBe(0);
    expect(sin16_t(16384)).toBe(32766);
    expect(sin16_t(32768)).toBe(0);
    expect(sin16_t(49152)).toBe(-32766);
  });
});


describe('beatsin8_t', () => {
  it('stays within [lowest, highest] across a period', () => {
    for (let t = 0; t < 4000; t += 37) {
      const v = beatsin8_t(60, t, 20, 200);
      expect(v).toBeGreaterThanOrEqual(20);
      expect(v).toBeLessThanOrEqual(200);
    }
  });

  it('is deterministic for a given now', () => {
    expect(beatsin8_t(120, 1234, 0, 255)).toBe(beatsin8_t(120, 1234, 0, 255));
  });
});

describe('color helpers (packed uint32)', () => {
  it('color_blend hits firmware anchors', () => {
    expect(color_blend(0xff0000, 0x0000ff, 0)).toBe(0xff0000);
    expect(color_blend(0xff0000, 0x0000ff, 255)).toBe(0x0000ff);
    expect(color_blend(0xff0000, 0x0000ff, 128)).toBe(0x7f0080);
  });

  it('color_fade toward black', () => {
    expect(color_fade(0xff0000, 0)).toBe(0);
    expect(color_fade(0xff0000, 255)).toBe(0xff0000);
    expect(R(color_fade(0xff0000, 128))).toBeLessThan(255);
    // video fade keeps a bright color from collapsing fully to black
    expect(color_fade(0xffffff, 1, true)).not.toBe(0);
  });
});



describe('PRNG (deterministic, seeded)', () => {
  it('reproduces the firmware sequence for seed 0x1234', () => {
    const rng = new PRNG(0x1234);
    const seq = Array.from({ length: 6 }, () => rng.random16());
    expect(seq).toEqual([57065, 37902, 5062, 18262, 48028, 49913]);
  });

  it('random8 mirrors the low byte of the same stream', () => {
    const rng = new PRNG(0x1234);
    const seq = Array.from({ length: 6 }, () => rng.random8());
    expect(seq).toEqual([233, 14, 198, 86, 156, 249]);
  });

  it('two generators with the same seed agree step for step', () => {
    const a = new PRNG(42);
    const b = new PRNG(42);
    for (let i = 0; i < 100; i++) expect(a.random16()).toBe(b.random16());
  });

  it('bounded forms stay in range', () => {
    const rng = new PRNG(7);
    for (let i = 0; i < 200; i++) {
      const r8 = rng.random8(5, 12);
      expect(r8).toBeGreaterThanOrEqual(5);
      expect(r8).toBeLessThan(12);
      const r16 = rng.random16(1000);
      expect(r16).toBeGreaterThanOrEqual(0);
      expect(r16).toBeLessThan(1000);
    }
  });
});

describe('inoise8 (WLED perlin8, fixed-point gradient noise)', () => {
  // Anchors are the exact outputs of a native port of WLED's real
  // perlin1D_raw/perlin2D_raw/perlin8 C source (util.cpp), compiled and run
  // standalone to cross-check this port bit-for-bit -- not hand-derived.
  it('1-arg (1D) hits the firmware anchors', () => {
    const anchors: [number, number][] = [
      [0, 128],
      [1, 126],
      [5, 121],
      [10, 115],
      [16, 108],
      [20, 104],
      [30, 95],
      [50, 82],
      [100, 75],
      [200, 128],
      [255, 128],
      [256, 128],
      [500, 134],
      [1000, 139],
      [5000, 171],
      [12345, 161],
      [65535, 129],
    ];
    for (const [x, expected] of anchors) expect(inoise8(x)).toBe(expected);
  });

  it('2-arg (2D) hits the firmware anchors', () => {
    const anchors: [number, number, number][] = [
      [0, 0, 128],
      [1, 0, 127],
      [0, 1, 127],
      [5, 5, 120],
      [10, 20, 108],
      [100, 200, 150],
      [255, 255, 128],
      [1000, 2000, 144],
      [12345, 6789, 69],
      [65535, 65535, 129],
      [300, 7, 105],
      [7, 300, 87],
    ];
    for (const [x, y, expected] of anchors)
      expect(inoise8(x, y)).toBe(expected);
  });

  it('stays within uint8 range and is deterministic', () => {
    for (let x = 0; x < 2000; x += 37) {
      const v1 = inoise8(x);
      expect(v1).toBeGreaterThanOrEqual(0);
      expect(v1).toBeLessThanOrEqual(255);
      expect(inoise8(x)).toBe(v1); // pure function of its input

      const v2 = inoise8(x, x * 3 + 1);
      expect(v2).toBeGreaterThanOrEqual(0);
      expect(v2).toBeLessThanOrEqual(255);
      expect(inoise8(x, x * 3 + 1)).toBe(v2);
    }
  });

  it('varies smoothly rather than jumping randomly (it is noise, not random8)', () => {
    let bigJump = false;
    let prev = inoise8(0);
    for (let x = 1; x < 500; x++) {
      const cur = inoise8(x * 20);
      if (Math.abs(cur - prev) > 40) bigJump = true;
      prev = cur;
    }
    expect(bigJump).toBe(false);
  });
});
