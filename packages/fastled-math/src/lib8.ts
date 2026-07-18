// SPDX-License-Identifier: MIT
// Derived from FastLED 3.6.0 (Copyright (c) 2013 FastLED, MIT) as bundled by
// WLED v16.0.0 (fastled_slim), plus FastLED-marked blocks of wled00/colors.cpp.
/**
 * FastLED-derived uint8/uint16 fixed-point + color math, ported to TypeScript
 * from FastLED 3.6.0 as bundled by WLED v16.0.0 (wled00/src/dependencies/
 * fastled_slim, plus the FastLED-marked helpers in wled00/colors.cpp).
 * Pure TS, no DOM.
 *
 * Colors are packed uint32 `0x00RRGGBB` (WLED's native pixel word; the W channel
 * is unused for RGB strips) so the color helpers stay bit-for-bit like firmware.
 * Fixed-point wraparound is deliberate: values are masked to 8/16 bits exactly
 * where the C integer types wrap, because effect motion depends on it.
 */

/** Unpacked pixel: [r, g, b], each 0-255. */
export type RGB = [number, number, number];

// --- byte helpers -----------------------------------------------------------

const u8 = (x: number): number => x & 0xff;
const u16 = (x: number): number => x & 0xffff;

/** min(i+j, 255) -- FastLED qadd8. */
export function qadd8(i: number, j: number): number {
  const t = u8(i) + u8(j);
  return t > 255 ? 255 : t;
}

/** max(i-j, 0) -- FastLED qsub8. */
export function qsub8(i: number, j: number): number {
  const t = u8(i) - u8(j);
  return t < 0 ? 0 : t;
}

/** (i * (1+scale)) >> 8 -- FastLED scale8 (FASTLED_SCALE8_FIXED form WLED ships). */
export function scale8(i: number, scale: number): number {
  return (u8(i) * (1 + u8(scale))) >> 8;
}

/** scale8 that never fully dims a non-zero input unless scale is 0 -- FastLED scale8_video. */
export function scale8_video(i: number, scale: number): number {
  return ((u8(i) * u8(scale)) >> 8) + (i && scale ? 1 : 0);
}

/** (i * (1+scale)) >> 16 -- FastLED scale16. */
export function scale16(i: number, scale: number): number {
  return Math.trunc((u16(i) * (1 + u16(scale))) / 0x10000);
}

/** a + (b-a)*frac/256 -- FastLED lerp8by8. */
export function lerp8by8(a: number, b: number, frac: number): number {
  return u8(a + (((b - a) * (frac + 1)) >> 8));
}

/** Triangle wave, uint8 in/out -- FastLED triwave8. */
export function triwave8(inp: number): number {
  let x = u8(inp);
  if (x & 0x80) x = 255 - x;
  return u8(x << 1);
}

/** Triangle wave, uint16 in/out -- FastLED triwave16. */
export function triwave16(inp: number): number {
  const x = u16(inp);
  if (x < 0x8000) return x * 2;
  return 0xffff - (x - 0x8000) * 2;
}

/** S-curve ease, uint8 in/out -- FastLED ease8InOutCubic (fastled_slim.cpp). */
export function ease8InOutCubic(i: number): number {
  const ii = u8(i) * u8(i);
  const factor = (3 << 8) - (u8(i) << 1); // 3 - 2i, Q8
  return (ii * factor) >>> 16;
}

/** Cubic-eased triangle wave, uint8 in/out -- FastLED cubicwave8. */
export function cubicwave8(inp: number): number {
  return ease8InOutCubic(triwave8(inp));
}

/** S-curve ease, uint8 in/out -- FastLED ease8InOutQuad (fastled_slim.cpp). */
function ease8InOutQuad(i: number): number {
  let j = u8(i);
  if (j & 0x80) j = 255 - j;
  const jj = (j * j) >>> 7;
  return i & 0x80 ? 255 - jj : jj;
}

/** Quadratic-eased triangle wave, uint8 in/out -- FastLED quadwave8. */
export function quadwave8(inp: number): number {
  return ease8InOutQuad(triwave8(inp));
}

// --- packed-color bit utilities (uint32 0xWWRRGGBB) -------------------------
// Trivial packing helpers; kept with the MIT kit so both packages share one copy.

export const BLACK = 0x000000;

/** Pack channels into WLED's 0xWWRRGGBB word (unsigned). */
export function rgbw32(r: number, g: number, b: number, w = 0): number {
  return ((u8(w) << 24) | (u8(r) << 16) | (u8(g) << 8) | u8(b)) >>> 0;
}

export const R = (c: number): number => (c >>> 16) & 0xff;
export const G = (c: number): number => (c >>> 8) & 0xff;
export const B = (c: number): number => c & 0xff;
export const W = (c: number): number => (c >>> 24) & 0xff;

/** [r,g,b] from a packed word. */
export function unpack(c: number): RGB {
  return [R(c), G(c), B(c)];
}

/** Pack an [r,g,b] triple. */
export function pack(rgb: RGB): number {
  return rgbw32(rgb[0], rgb[1], rgb[2]);
}

/** Sum of R/G/B on a packed color, /3 -- FastLED CRGB::getAverageLight(). */
export function averageLight(c: number): number {
  return ((R(c) + G(c) + B(c)) * 21846) >>> 16;
}

// --- palette lookup (ColorFromPalette) --------------------------------------

/** Palette interpolation modes -- FastLED TBlendType. */
export const NOBLEND = 0;
export const LINEARBLEND = 1;
export const LINEARBLEND_NOWRAP = 2;

/**
 * A single color from a 16-entry palette -- ColorFromPalette (WLED colors.cpp:117,
 * marked "derived from FastLED"). `pal` is 16 RGB entries passed in by the
 * caller; `index` is 0-255 (wraps); `brightness` scales output.
 */
export function colorFromPalette(
  pal: RGB[],
  index: number,
  brightness = 255,
  blendType: number = LINEARBLEND,
): number {
  let idx = index;
  if (blendType === LINEARBLEND_NOWRAP) {
    idx = (u8(idx) * 0xf0) >> 8;
  }
  const hi4 = u8(idx) >> 4;
  const lo4 = idx & 0x0f;
  let red1 = pal[hi4][0];
  let green1 = pal[hi4][1];
  let blue1 = pal[hi4][2];
  if (lo4 && blendType !== NOBLEND) {
    const entry = hi4 === 15 ? pal[0] : pal[hi4 + 1];
    const f2 = lo4 << 4;
    const f1 = 256 - f2;
    red1 = (red1 * f1 + entry[0] * f2) >> 8;
    green1 = (green1 * f1 + entry[1] * f2) >> 8;
    blue1 = (blue1 * f1 + entry[2] * f2) >> 8;
  }
  const bri = u8(brightness);
  if (bri < 255) {
    const scale = bri + 1;
    red1 = (red1 * scale) >> 8;
    green1 = (green1 * scale) >> 8;
    blue1 = (blue1 * scale) >> 8;
  }
  return rgbw32(red1, green1, blue1, 0);
}

// --- HSV -> RGB (FastLED hsv2rgb_rainbow, 16-bit hue) -----------------------

/**
 * FastLED "rainbow" HSV->RGB with 16-bit hue, ported from WLED's fastled_slim
 * hsv2rgb_rainbow. Returns a packed 0x00RRGGBB word.
 */
export function hsv2rgb_rainbow(h: number, s: number, v: number): number {
  const hue = (u16(h) >> 8) & 0xff;
  const sat = u8(s);
  let val = u8(v);
  const offset = h & 0x1fff;
  const third16 = offset * 21846;
  const third = (third16 >>> 21) & 0xff;
  let r: number;
  let g: number;
  let b: number;

  if (!(hue & 0x80)) {
    if (!(hue & 0x40)) {
      if (!(hue & 0x20)) {
        r = 255 - third;
        g = third;
        b = 0;
      } else {
        r = 171;
        g = 85 + third;
        b = 0;
      }
    } else {
      if (!(hue & 0x20)) {
        const twothirds = (third16 >>> 20) & 0xff;
        r = 171 - twothirds;
        g = 170 + third;
        b = 0;
      } else {
        r = 0;
        g = 255 - third;
        b = third;
      }
    }
  } else {
    if (!(hue & 0x40)) {
      if (!(hue & 0x20)) {
        const twothirds = (third16 >>> 20) & 0xff;
        r = 0;
        g = 171 - twothirds;
        b = 85 + twothirds;
      } else {
        r = third;
        g = 0;
        b = 255 - third;
      }
    } else {
      if (!(hue & 0x20)) {
        r = 85 + third;
        g = 0;
        b = 171 - third;
      } else {
        r = 170 + third;
        g = 0;
        b = 85 - third;
      }
    }
  }

  if (sat !== 255) {
    if (sat === 0) {
      r = 255;
      g = 255;
      b = 255;
    } else {
      let desat = 255 - sat;
      desat = desat * desat;
      const floorB = desat >>> 8;
      const satscale = 0xffff - desat;
      if (r) r = (r * satscale) >>> 16;
      if (g) g = (g * satscale) >>> 16;
      if (b) b = (b * satscale) >>> 16;
      r += floorB;
      g += floorB;
      b += floorB;
    }
  }

  if (val !== 255) {
    if (val === 0) {
      r = 0;
      g = 0;
      b = 0;
    } else {
      val = val * val + 512;
      if (r) r = ((r * val) >>> 16) + 1;
      if (g) g = ((g * val) >>> 16) + 1;
      if (b) b = ((b * val) >>> 16) + 1;
    }
  }
  return rgbw32(r & 0xff, g & 0xff, b & 0xff, 0);
}
