/**
 * The uint8/uint16 fixed-point + color primitive kit WLED 1D effects lean on,
 * ported faithfully from WLED firmware v16.0.0 (wled00/wled_math.cpp,
 * wled00/util.cpp, wled00/colors.cpp) and its bundled FastLED-derived helpers
 * (wled00/src/dependencies/fastled_slim). Pure TS, no DOM/Svelte -- this is the
 * math, not the render (decisions.md, 2026-07-03 "Effect previews become real
 * 1D WLED simulations").
 *
 * Colors are packed uint32 `0x00RRGGBB` (WLED's native pixel word; the W channel
 * is unused for RGB strips) so the color helpers stay bit-for-bit like firmware.
 * Fixed-point wraparound is deliberate: values are masked to 8/16 bits exactly
 * where WLED's integer types wrap, because effect motion depends on it.
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

// --- trig (WLED's own integer sine, NOT FastLED's table sin8) ---------------

/**
 * 16-bit Bhaskara-I sine approximation, ported from WLED wled_math.cpp
 * `sin16_t` (by @dedehai). Input 0-65535 maps 0-2pi; output signed -32767..32767.
 * WLED 16.0 replaced FastLED's `sin16`/`sin8` with these, so effect motion is
 * matched against *these*, not FastLED's table values.
 */
export function sin16_t(theta: number): number {
  let t = u16(theta);
  let scale = 1;
  if (t > 0x7fff) {
    t = 0xffff - t;
    scale = -1;
  }
  const precal = t * (0x7fff - t);
  const numerator = precal * (4 * 0x7fff);
  const denominator = 1342095361 - precal; // 5 * 0x7FFF^2 / 4
  // int16_t truncation in firmware; the design keeps |result| < 32768.
  const result = Math.trunc(numerator / denominator) * scale;
  return result === 0 ? 0 : result; // normalize -0 (firmware int16 has none)
}

/** cos(x) = sin(x + pi/2) -- WLED cos16_t. */
export function cos16_t(theta: number): number {
  return sin16_t(u16(theta + 0x4000));
}

/** 8-bit sine built on sin16_t -- WLED sin8_t. sin8_t(0)=128, sin8_t(64)=255. */
export function sin8_t(theta: number): number {
  let s = sin16_t(u8(theta) * 257); // 255 * 257 = 0xFFFF
  s += 0x7fff + 128; // shift to 0-0xFFFF, +128 rounding
  return Math.min(s, 0xffff) >> 8;
}

/** cos(x) = sin(x + pi/2) -- WLED cos8_t. */
export function cos8_t(theta: number): number {
  return sin8_t(u8(theta + 64));
}

// --- beat / beatsin, ported from WLED util.cpp ------------------------------
// `now` is passed in (WLED reads the global millis()); timebase is an offset.

/** 16-bit sawtooth at a given BPM (Q8.8) -- WLED beat88. */
export function beat88(bpm88: number, now: number, timebase = 0): number {
  return ((now - timebase) * bpm88 * 280) >>> 16;
}

/** 16-bit sawtooth at a given BPM -- WLED beat16. */
export function beat16(bpm: number, now: number, timebase = 0): number {
  const b = bpm < 256 ? bpm << 8 : bpm;
  return beat88(b, now, timebase);
}

/** 8-bit sawtooth at a given BPM -- WLED beat8. */
export function beat8(bpm: number, now: number, timebase = 0): number {
  return beat16(bpm, now, timebase) >> 8;
}

/** 8-bit sine oscillating lowest..highest at a given BPM -- WLED beatsin8_t. */
export function beatsin8_t(
  bpm: number,
  now: number,
  lowest = 0,
  highest = 255,
  timebase = 0,
  phase = 0,
): number {
  const beat = beat8(bpm, now, timebase);
  const bs = sin8_t(u8(beat + phase));
  return lowest + scale8(bs, highest - lowest);
}

/** 16-bit sine oscillating lowest..highest at a given BPM -- WLED beatsin16_t. */
export function beatsin16_t(
  bpm: number,
  now: number,
  lowest = 0,
  highest = 65535,
  timebase = 0,
  phase = 0,
): number {
  const beat = beat16(bpm, now, timebase);
  const bs = u16(sin16_t(u16(beat + phase)) + 32768);
  return lowest + scale16(bs, highest - lowest);
}

/** 16-bit sine oscillating lowest..highest at a Q8.8 BPM -- WLED beatsin88_t. */
export function beatsin88_t(
  bpm88: number,
  now: number,
  lowest = 0,
  highest = 65535,
  timebase = 0,
  phase = 0,
): number {
  const beat = beat88(bpm88, now, timebase);
  const bs = u16(sin16_t(u16(beat + phase)) + 32768);
  return lowest + scale16(bs, highest - lowest);
}

/** S-curve ease, uint8 in/out -- FastLED ease8InOutCubic (fastled_slim.cpp). */
function ease8InOutCubic(i: number): number {
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

// --- packed-color helpers (uint32 0xWWRRGGBB), ported from WLED colors.cpp ---

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

const TWO_CH = 0x00ff00ff;
const WG_MASK = 0xff00ff00; // ~TWO_CH, kept explicit so JS bitwise-NOT sign issues can't bite

/**
 * Blend color1 -> color2 by `blend` (0-255) -- WLED color_blend (poor-man's SIMD
 * over the R/B and W/G channel pairs).
 */
export function color_blend(
  color1: number,
  color2: number,
  blend: number,
): number {
  const bl = u8(blend);
  const rb1 = (color1 & TWO_CH) >>> 0;
  const wg1 = ((color1 >>> 8) & TWO_CH) >>> 0;
  const rb2 = (color2 & TWO_CH) >>> 0;
  const wg2 = ((color2 >>> 8) & TWO_CH) >>> 0;
  const rb3 = ((((rb1 << 8) >>> 0) | rb2) + rb2 * bl - rb1 * bl) >>> 8;
  const wg3 = ((((wg1 << 8) >>> 0) | wg2) + wg2 * bl - wg1 * bl) >>> 0;
  return ((rb3 & TWO_CH) | (wg3 & WG_MASK)) >>> 0;
}

/** Saturating (or ratio-preserving) additive blend -- WLED color_add. */
export function color_add(c1: number, c2: number, preserveCR = false): number {
  if (c1 === BLACK) return c2 >>> 0;
  if (c2 === BLACK) return c1 >>> 0;
  let rb = (c1 & TWO_CH) + (c2 & TWO_CH);
  let wg = ((c1 >>> 8) & TWO_CH) + ((c2 >>> 8) & TWO_CH);
  if (preserveCR) {
    const overflow = (rb | wg) & 0x01000100;
    if (overflow) {
      const r = rb >>> 16;
      const b = rb & 0xffff;
      const w = wg >>> 16;
      const g = wg & 0xffff;
      let maxval = r > g ? (r > b ? r : b) : g > b ? g : b;
      maxval = w > maxval ? w : maxval;
      const scale = ((255 << 8) / maxval) | 0;
      rb = ((rb * scale) >>> 8) & TWO_CH;
      wg = (wg * scale) & WG_MASK;
    } else {
      wg = (wg << 8) >>> 0;
    }
  } else {
    rb |= ((rb & 0x01000100) - ((rb >>> 8) & 0x00010001)) & 0x00ff00ff;
    wg |= ((wg & 0x01000100) - ((wg >>> 8) & 0x00010001)) & 0x00ff00ff;
    wg = (wg << 8) >>> 0;
  }
  return ((rb | wg) & 0xffffffff) >>> 0;
}

/**
 * Fade a color toward black by `amount` (0-255; 0=black, 255=unchanged) --
 * WLED color_fade. `video` keeps a non-zero color from dimming fully to black.
 */
export function color_fade(c1: number, amount: number, video = false): number {
  const amt = u8(amount);
  if (c1 === BLACK || amt === 0) return 0;
  if (amt === 255) return c1 >>> 0;
  const rb = (c1 & TWO_CH) >>> 0;
  const wg = ((c1 >>> 8) & TWO_CH) >>> 0;
  let rbS: number;
  let wgS: number;
  if (video) {
    rbS = ((rb * amt + 0x007f007f) >>> 8) & TWO_CH;
    wgS = (wg * amt + 0x007f007f) & WG_MASK;
    const r = R(c1);
    const g = G(c1);
    const b = B(c1);
    const w = W(c1);
    let maxc = r > g ? (r > b ? r : b) : g > b ? g : b;
    maxc = (maxc >>> 2) + 1;
    rbS |= r > maxc ? 0x00010000 : 0;
    wgS |= g > maxc ? 0x00000100 : 0;
    rbS |= b > maxc ? 0x00000001 : 0;
    wgS |= w ? 0x01000000 : 0;
  } else {
    rbS = ((rb * (amt + 1)) >>> 8) & TWO_CH;
    wgS = (wg * (amt + 1)) & ~TWO_CH & 0xffffffff;
  }
  return ((rbS | wgS) & 0xffffffff) >>> 0;
}

/** Scale a packed color's R/G/B by `scale`/256 -- WLED fast_color_scale (used by fade/blur). */
export function fast_color_scale(c: number, scale: number): number {
  const s = u8(scale);
  const rb = (((c & TWO_CH) * s) >>> 8) & TWO_CH;
  const wg = ((((c >>> 8) & TWO_CH) * s) >>> 8) & TWO_CH;
  return ((rb | ((wg << 8) >>> 0)) & 0xffffffff) >>> 0;
}

/** Sum of R/G/B on a packed color, /3 -- FastLED CRGB::getAverageLight(). */
export function averageLight(c: number): number {
  return ((R(c) + G(c) + B(c)) * 21846) >>> 16;
}

// --- inverse gamma (WLED colors.h/.cpp NeoGammaWLEDMethod) ------------------
// WLED builds gammaT_inv as a 256-entry LUT from the *device's* gamma setting
// (gammaCorrectVal, default 2.2) via calcGammaTable(); this sim has no device
// gamma setting to reconcile, so it computes the same formula on the fly at
// the firmware default (2.2) rather than faking a table for an unset device.
const GAMMA_DEFAULT = 2.2;

/** WLED gamma8inv (NeoGammaWLEDMethod::rawInverseGamma8), at gamma 2.2. */
export function gamma8inv(val: number): number {
  const v = u8(val);
  if (v === 0) return 0;
  return Math.round(((v - 0.5) / 255) ** (1 / GAMMA_DEFAULT) * 255);
}

/** WLED gamma32inv (NeoGammaWLEDMethod::inverseGamma32) -- per-channel gamma8inv. */
export function gamma32inv(c: number): number {
  return rgbw32(
    gamma8inv(R(c)),
    gamma8inv(G(c)),
    gamma8inv(B(c)),
    gamma8inv(W(c)),
  );
}

// --- palette lookup (WLED ColorFromPalette) ---------------------------------

/** Palette interpolation modes -- FastLED TBlendType. */
export const NOBLEND = 0;
export const LINEARBLEND = 1;
export const LINEARBLEND_NOWRAP = 2;

/**
 * A single color from a 16-entry palette -- WLED ColorFromPalette (colors.cpp).
 * `pal` is 16 RGB entries; `index` is 0-255 (wraps); `brightness` scales output.
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

// --- HSV -> RGB (WLED hsv2rgb_rainbow, 16-bit hue) --------------------------

/**
 * FastLED "rainbow" HSV->RGB with 16-bit hue, ported from WLED's
 * fastled_slim hsv2rgb_rainbow. Returns a packed 0x00RRGGBB word. Used by
 * color_wheel (rainbow-family effects).
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

// --- deterministic PRNG (WLED prng.h) ---------------------------------------

/**
 * WLED's small 16-bit PRNG (wled00/prng.h). The firmware uses a non-deterministic
 * hardware RNG (`hw_random*`) on-device; the sim routes *all* randomness through
 * this seedable generator instead so a preview is deterministic given its seed
 * (accuracy target is perceptual, not frame-parity -- decisions.md 2026-07-03).
 */
export class PRNG {
  private seed: number;

  constructor(initialSeed = 0x1234) {
    this.seed = u16(initialSeed);
  }

  setSeed(s: number): void {
    this.seed = u16(s);
  }

  getSeed(): number {
    return this.seed;
  }

  random16(): number;
  random16(lim: number): number;
  random16(min: number, lim: number): number;
  random16(a?: number, b?: number): number {
    if (a === undefined) {
      this.seed = u16(this.seed * 3001 + 31683);
      this.seed = u16(this.seed ^ (this.seed >> 7));
      return this.seed;
    }
    if (b === undefined) {
      return ((this.random16() * a) >>> 16) & 0xffff;
    }
    return this.random16(b - a) + a;
  }

  random8(): number;
  random8(lim: number): number;
  random8(min: number, lim: number): number;
  random8(a?: number, b?: number): number {
    if (a === undefined) return u8(this.random16());
    if (b === undefined) return ((this.random8() * a) >> 8) & 0xff;
    return this.random8(b - a) + a;
  }
}
