// SPDX-License-Identifier: EUPL-1.2
// WLED-original math ported from WLED v16.0.0 (commit 4374f01) wled00/wled_math.cpp,
// util.cpp, colors.cpp, prng.h. The FastLED-derived subset lives in
// @wiillownet/fastled-math (MIT); see PROVENANCE.md for the per-function split.
// Copyright (c) 2016-present Christian Schwinne and individual WLED contributors
/**
 * The WLED-original half of the uint8/uint16 fixed-point + color primitive kit
 * WLED effects lean on, ported faithfully from WLED firmware v16.0.0
 * (wled00/wled_math.cpp, wled00/util.cpp, wled00/colors.cpp, wled00/prng.h).
 * The FastLED-derived half (scale/wave/ease, packed-color bit utilities,
 * colorFromPalette, hsv2rgb_rainbow) lives in @wiillownet/fastled-math and is
 * re-exported here so effect code has one import surface.
 *
 * Colors are packed uint32 `0x00RRGGBB` (WLED's native pixel word; the W channel
 * is unused for RGB strips) so the color helpers stay bit-for-bit like firmware.
 * Fixed-point wraparound is deliberate: values are masked to 8/16 bits exactly
 * where WLED's integer types wrap, because effect motion depends on it.
 */

import { R, G, B, W, rgbw32, scale8, scale16 } from '@wiillownet/fastled-math';

export type { RGB } from '@wiillownet/fastled-math';
export {
  averageLight,
  B,
  BLACK,
  colorFromPalette,
  cubicwave8,
  ease8InOutCubic,
  G,
  hsv2rgb_rainbow,
  lerp8by8,
  LINEARBLEND,
  LINEARBLEND_NOWRAP,
  NOBLEND,
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
} from '@wiillownet/fastled-math';

// --- byte helpers -----------------------------------------------------------

const u8 = (x: number): number => x & 0xff;
const u16 = (x: number): number => x & 0xffff;

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

// WLED's `sin_t`/`cos_t` (used by ESP32 float-math effect paths, e.g. mode_palette)
// are #defined straight to these float wrappers around the sin16_t table
// (wled00/fcn_declare.h: `#define sin_t sin_approx`, `#define cos_t cos_approx`).
const RAD_TO_U16 = 0xffff / (2 * Math.PI);

/** WLED sin_approx (wled_math.cpp) -- float sine via the sin16_t table. */
export function sin_approx(theta: number): number {
  const scaledTheta = Math.trunc(theta * RAD_TO_U16) & 0xffff;
  return sin16_t(scaledTheta) / 0x7fff;
}

/** WLED cos_approx (wled_math.cpp) -- float cosine via the sin16_t table. */
export function cos_approx(theta: number): number {
  const scaledTheta = Math.trunc(theta * RAD_TO_U16) & 0xffff;
  return sin16_t((scaledTheta + 0x4000) & 0xffff) / 0x7fff;
}

// --- beat / beatsin, ported from WLED util.cpp ------------------------------
// `now` is passed in (WLED reads the global millis()); timebase is an offset.
// FastLED lineage, but WLED-reimplemented AND built on the EUPL sin16_t above,
// so they route with the WLED-original code (PROVENANCE.md).

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

// --- packed-color helpers (uint32 0xWWRRGGBB), ported from WLED colors.cpp ---

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
  if (c1 === 0) return c2 >>> 0;
  if (c2 === 0) return c1 >>> 0;
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
      const scale = Math.trunc((255 << 8) / maxval);
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
  if (c1 === 0 || amt === 0) return 0;
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

/**
 * Add packed color `c2` (scaled by `scale`/256) onto `c1`, ignoring white --
 * WLED FXparticleSystem.cpp `fast_color_scaleAdd`. On channel overflow it scales
 * the summed color down by the brightest channel (preserving hue) rather than
 * clamping each channel independently. Used by the 1D particle renderer.
 */
export function fast_color_scaleAdd(
  c1: number,
  c2: number,
  scale = 255,
): number {
  const MASK_RB = 0x00ff00ff;
  const MASK_G = 0x0000ff00;
  const s = u8(scale);
  let rb = c2 & MASK_RB;
  let g = c2 & MASK_G;
  // scale second color (red+blue packed in parallel; each channel stays in-byte)
  rb = Math.trunc((rb * s) / 256) & MASK_RB;
  g = Math.trunc((g * s) / 256) & MASK_G;
  // add
  rb = (c1 & MASK_RB) + rb;
  g = (c1 & MASK_G) + g;
  // overflow (9th bit of a channel set) -> rescale by brightest channel
  if (((rb | (g >>> 8)) & 0x01000100) !== 0) {
    g = g >>> 8;
    let maxVal = rb >>> 16; // red
    const blue = rb & 0xffff;
    if (blue > maxVal) maxVal = blue;
    if (g > maxVal) maxVal = g;
    const scaleFactor = Math.trunc((255 << 8) / maxVal);
    rb = Math.trunc((rb * scaleFactor) / 256) & MASK_RB;
    g = (g * scaleFactor) & MASK_G;
  }
  return ((rb | g) & 0xffffffff) >>> 0;
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

/** WLED gamma8 (NeoGammaWLEDMethod::rawGamma8), the forward direction -- some
 * effects call this directly for their own fade curve, separate from the
 * device's automatic output-stage correction. Also at gamma 2.2. */
export function gamma8(val: number): number {
  const v = u8(val);
  if (v === 0) return 0;
  return Math.round((v / 255) ** GAMMA_DEFAULT * 255);
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

/**
 * Spectrum HSV->RGB (wled00/colors.cpp hsv2rgb_spectrum). Even hue spacing,
 * unlike the perceptually-weighted rainbow variant. `h` is a 16-bit hue: CHSV32
 * stores hue at 16-bit precision, so an 8-bit hue maps in as `h << 8`.
 */
export function hsv2rgb_spectrum(h: number, s: number, v: number): number {
  const hue = u16(h);
  const sat = u8(s);
  const val = u8(v);

  if (sat === 0) return rgbw32(val, val, val, 0);

  const region = (hue * 6) >>> 16; // hue / (65536 / 6)
  const remainder = (hue - region * 10923) * 6; // 10923 = 65536 / 6

  const p = (val * (255 - sat)) >>> 8;
  const q = (val * (255 - ((sat * remainder) >>> 16))) >>> 8;
  const t = (val * (255 - ((sat * (65535 - remainder)) >>> 16))) >>> 8;
  let r: number;
  let g: number;
  let b: number;
  switch (region) {
    case 0:
      r = val;
      g = t;
      b = p;
      break;
    case 1:
      r = q;
      g = val;
      b = p;
      break;
    case 2:
      r = p;
      g = val;
      b = t;
      break;
    case 3:
      r = p;
      g = q;
      b = val;
      break;
    case 4:
      r = t;
      g = p;
      b = val;
      break;
    default:
      r = val;
      g = p;
      b = q;
      break;
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

// --- 3D fixed-point gradient noise (WLED util.cpp `perlin16`, by @dedehai) --
// WLED 16.0 ships its own fixed-point gradient-noise implementation (a fast
// hash-based scheme, not the classic permutation-table Perlin, and not a
// literal copy of FastLED's inoise -- fcn_declare.h aliases this `inoise16`
// for FastLED-legacy call sites). Ported bit-for-bit, including the 32-bit
// hash multiplies (via Math.imul, matching C's uint32 wraparound), since the
// visual character depends on the exact gradient hash, not just "some" noise.
const PERLIN_SHIFT = 1;

function hashToGradient(h: number): number {
  return (h & 0x03) - 2;
}

function gradient3D(
  x0: number,
  dx: number,
  y0: number,
  dy: number,
  z0: number,
  dz: number,
): number {
  let h =
    Math.imul(x0, 0x27d4eb2d) ^
    Math.imul(y0, 0xb5297a4d) ^
    Math.imul(z0, 0x1b56c4e9);
  h ^= h >>> 15;
  h = Math.imul(h, 0x92c3412b);
  h ^= h >>> 13;
  const gx = hashToGradient(h);
  const gy = hashToGradient(h >>> (1 + PERLIN_SHIFT));
  const gz = hashToGradient(h >>> (1 + 2 * PERLIN_SHIFT));
  return ((gx * dx + gy * dy + gz * dz) * 85) >> (8 + PERLIN_SHIFT);
}

/** t*(3-2t) fixed-point smoothstep; the uint32 wraparound is load-bearing. */
function smoothstep(t: number): number {
  const tSquared = (t * t) >>> 16;
  const factor = (3 << 16) - (t << 1);
  return (tSquared * factor) >>> 18;
}

function lerpPerlin(a: number, b: number, t: number): number {
  return a + (Math.imul(b - a, t) >> 14);
}

function perlin3DRaw(x: number, y: number, z: number, is16bit = false): number {
  const x0 = x >>> 16;
  const y0 = y >>> 16;
  const z0 = z >>> 16;
  let x1 = x0 + 1;
  let y1 = y0 + 1;
  let z1 = z0 + 1;
  if (is16bit) {
    x1 &= 0xff;
    y1 &= 0xff;
    z1 &= 0xff;
  }

  const dx0 = x & 0xffff;
  const dy0 = y & 0xffff;
  const dz0 = z & 0xffff;
  const dx1 = dx0 - 0x10000;
  const dy1 = dy0 - 0x10000;
  const dz1 = dz0 - 0x10000;

  const g000 = gradient3D(x0, dx0, y0, dy0, z0, dz0);
  const g001 = gradient3D(x0, dx0, y0, dy0, z1, dz1);
  const g010 = gradient3D(x0, dx0, y1, dy1, z0, dz0);
  const g011 = gradient3D(x0, dx0, y1, dy1, z1, dz1);
  const g100 = gradient3D(x1, dx1, y0, dy0, z0, dz0);
  const g101 = gradient3D(x1, dx1, y0, dy0, z1, dz1);
  const g110 = gradient3D(x1, dx1, y1, dy1, z0, dz0);
  const g111 = gradient3D(x1, dx1, y1, dy1, z1, dz1);

  const tx = smoothstep(dx0);
  const ty = smoothstep(dy0);
  const tz = smoothstep(dz0);

  const nx0 = lerpPerlin(g000, g100, tx);
  const nx1 = lerpPerlin(g010, g110, tx);
  const nx2 = lerpPerlin(g001, g101, tx);
  const nx3 = lerpPerlin(g011, g111, tx);
  const ny0 = lerpPerlin(nx0, nx1, ty);
  const ny1 = lerpPerlin(nx2, nx3, ty);

  return lerpPerlin(ny0, ny1, tz);
}

/**
 * 3D fixed-point gradient noise, uint16 in/out -- WLED perlin16(x,y,z)
 * (util.cpp), aliased `inoise16` for FastLED-style call sites. `x`/`y`/`z` are
 * Q16.16 fixed-point coordinates (the integer part selects a lattice cell).
 */
export function inoise16(x: number, y: number, z: number): number {
  return (((perlin3DRaw(x, y, z) * 1731) >> 10) + 33147) & 0xffff;
}

/**
 * 2D fixed-point gradient noise, uint16 in/out -- WLED perlin16(x,y) (a
 * genuinely distinct overload, NOT `inoise16(x,y,0)`: real firmware scales
 * perlin2D_raw with its own constants (1537/32725) separate from the 3D
 * overload's (1731/33147), so the two aren't interchangeable.
 */
export function inoise16xy(x: number, y: number): number {
  return (((perlin2DRaw(x, y, false) * 1537) >> 10) + 32725) & 0xffff;
}

// --- Perlin noise (WLED util.cpp, NOT FastLED's table-based inoise8/16) -----
// WLED 16.0 replaced FastLED's classic Perlin noise with its own from-scratch
// integer implementation (by @dedehai): a hash-based gradient noise with a
// cubic smoothstep, ported faithfully since effect motion depends on its
// exact curve, not just "some noise." Only the 2D uint8 form (`perlin8(x,y)`)
// is implemented here -- `PERLIN_SHIFT`/`hashToGradient`/`smoothstep` are the
// same primitives the 3D `inoise16` above already declares, reused as-is
// (upstream likewise has a single smoothstep, util.cpp:1139).

/** 2D corner gradient dot-product from hashed integer coordinates -- gradient2D. */
function gradient2D(x0: number, dx: number, y0: number, dy: number): number {
  let h = (Math.imul(x0, 0x27d4eb2d) ^ Math.imul(y0, 0xb5297a4d)) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  h = Math.imul(h, 0x92c3412b) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  return (
    (hashToGradient(h) * dx + hashToGradient(h >>> PERLIN_SHIFT) * dy) >>
    (1 + PERLIN_SHIFT)
  );
}

/** 2D Perlin noise, 16.16 fixed-point inputs, `is16bit` wraps corners at 0xFF
 * instead of 0xFFFF -- util.cpp perlin2D_raw. Returns roughly -20633..20629. */
function perlin2DRaw(x: number, y: number, is16bit: boolean): number {
  const x0 = x >>> 16;
  const y0 = y >>> 16;
  let x1 = x0 + 1;
  let y1 = y0 + 1;
  if (is16bit) {
    x1 &= 0xff;
    y1 &= 0xff;
  }
  const dx0 = x & 0xffff;
  const dy0 = y & 0xffff;
  const dx1 = dx0 - 0x10000;
  const dy1 = dy0 - 0x10000;
  const g00 = gradient2D(x0, dx0, y0, dy0);
  const g10 = gradient2D(x1, dx1, y0, dy0);
  const g01 = gradient2D(x0, dx0, y1, dy1);
  const g11 = gradient2D(x1, dx1, y1, dy1);
  const tx = smoothstep(dx0);
  const ty = smoothstep(dy0);
  const nx0 = lerpPerlin(g00, g10, tx);
  const nx1 = lerpPerlin(g01, g11, tx);
  return lerpPerlin(nx0, nx1, ty);
}

/**
 * WLED perlin8(x, y): 2D Perlin noise, uint8 output -- util.cpp. `x`/`y` are
 * truncated to uint16_t first, matching the real function's parameter types
 * (a real firmware quirk: callers passing a larger int silently wrap mod
 * 65536, e.g. Noise Pal's `SEGENV.aux0 + i*scale`).
 */
export function perlin8(x: number, y: number, z?: number): number {
  const xs = (x & 0xffff) << 8;
  const ys = (y & 0xffff) << 8;
  if (z !== undefined) {
    // util.cpp perlin8(x, y, z) -- its own scale/offset constants (2015/33168)
    const raw = perlin3DRaw(
      xs >>> 0,
      ys >>> 0,
      ((z & 0xffff) << 8) >>> 0,
      true,
    );
    return (((((raw * 2015) >> 10) + 33168) >> 8) & 0xff) >>> 0;
  }
  const raw = perlin2DRaw(xs >>> 0, ys >>> 0, true);
  return (((((raw * 1620) >> 10) + 32771) >> 8) & 0xff) >>> 0;
}

// --- 1D Perlin noise (WLED util.cpp perlin1D_raw, feeding inoise8's 1D form) -
// Reuses the PERLIN_SHIFT/hashToGradient/smoothstep/lerpPerlin/perlin2DRaw
// primitives already declared above (shared with inoise16/perlin8) plus a new
// 1D gradient hash for the 1-argument form.

/** WLED gradient1D (fast hash of a lattice corner + its signed offset). */
function gradient1D(x0: number, dx: number): number {
  let h = Math.imul(x0, 0x27d4eb2d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x92c3412b);
  h ^= h >>> 13;
  h ^= h >>> 7;
  return (hashToGradient(h) * dx) >> PERLIN_SHIFT;
}

/** 1D raw Perlin noise, range about -24691..24689 -- WLED perlin1D_raw(x, true). */
function perlin1DRaw(x: number): number {
  const x0 = x >>> 16;
  const x1 = (x0 + 1) & 0xff; // is16bit: wrap back to zero at 0xFF
  const dx0 = x & 0xffff;
  const dx1 = dx0 - 0x10000;
  const g0 = gradient1D(x0, dx0);
  const g1 = gradient1D(x1, dx1);
  const tx = smoothstep(dx0);
  return lerpPerlin(g0, g1, tx);
}

/**
 * 8-bit Perlin noise, 1D or 2D -- WLED perlin8(uint16_t x[, uint16_t y]).
 * Each input is masked to 16 bits (matching the real uint16_t parameter);
 * output is 0-255. Named `inoise8` (the term WLED's own effect comments still
 * use for the concept, e.g. "Let's randomize ... with some Perlin noise")
 * even though the underlying algorithm is this custom gradient noise, not
 * FastLED's classic inoise8. Verified bit-for-bit against a native port of
 * the real perlin1D_raw/perlin2D_raw/perlin8 C source across a spread of
 * inputs (0, small, boundary-at-256, and large uint16 values).
 */
export function inoise8(x: number, y?: number): number {
  if (y === undefined) {
    const raw = perlin1DRaw(u16(x) << 8);
    return (((raw * 1353) >> 10) + 32769) >> 8;
  }
  const raw = perlin2DRaw(u16(x) << 8, u16(y) << 8, true);
  return (((raw * 1620) >> 10) + 32771) >> 8;
}
