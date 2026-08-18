// SPDX-License-Identifier: EUPL-1.2
// Ported from WLED v16.0.0 (commit 4374f01) wled00/FX_fcn.cpp Segment::loadPalette.
// Copyright (c) 2016-present Christian Schwinne and individual WLED contributors
/**
 * Palette resolution -- WLED Segment::loadPalette (wled00/FX_fcn.cpp), ported.
 * Palettes 0-5 are built at runtime from the segment's P/S/T colors (dynamic);
 * palettes 6-71 are the baked fixed table (palette-data.generated.ts). Anything
 * outside 0-71 (custom/usermod palettes, which live on a device and have no
 * offline data) falls back to the default palette -- see the gap note in the
 * sim's report. Returns a 16-entry CRGBPalette16 (RGB[16]) for ColorFromPalette.
 */
import type { RGB } from './lib8.js';
import { unpack } from './lib8.js';
import { FIXED_PALETTES } from './palette-data.generated.js';

// loadPalette hands these arrays out by reference (firmware copies its
// CRGBPalette16 by value instead), so one in-place write would corrupt the
// palette for every sim sharing that id. Freeze the triples, not just the rows:
// the realistic slip is `pal[i][channel] = x`, which a shallow freeze misses.
// Lives here rather than in palette-data.generated.ts so it survives a
// regeneration of that file.
for (const pal of Object.values(FIXED_PALETTES)) {
  for (const entry of pal) Object.freeze(entry);
  Object.freeze(pal);
}
Object.freeze(FIXED_PALETTES);

/**
 * Linear RGB gradient between two colors across [startpos, endpos] --
 * fill_gradient_RGB (single-range overload). Exported beyond loadPalette's own
 * use so effects that build an ad-hoc runtime palette (e.g. Noise Pal's
 * CHSV-stop palette) can reuse the same primitive rather than re-deriving it.
 */
export function fillGradient(
  out: RGB[],
  startpos: number,
  sc: RGB,
  endpos: number,
  ec: RGB,
): void {
  let s = startpos;
  let e = endpos;
  let a = sc;
  let b = ec;
  if (e < s) {
    [s, e] = [e, s];
    [a, b] = [b, a];
  }
  const divisor = e - s === 0 ? 1 : e - s;
  const rd = ((b[0] - a[0]) << 16) / divisor;
  const gd = ((b[1] - a[1]) << 16) / divisor;
  const bd = ((b[2] - a[2]) << 16) / divisor;
  let r = a[0] << 16;
  let g = a[1] << 16;
  let bl = a[2] << 16;
  for (let i = s; i <= e; i++) {
    out[i] = [Math.trunc(r) >> 16, Math.trunc(g) >> 16, Math.trunc(bl) >> 16];
    r += rd;
    g += gd;
    bl += bd;
  }
}

function solid(c: RGB): RGB[] {
  return Array.from({ length: 16 }, () => [c[0], c[1], c[2]] as RGB);
}

function fromColors(colors: RGB[]): RGB[] {
  const out: RGB[] = Array.from({ length: 16 }, () => [0, 0, 0] as RGB);
  fillGradient(out, 0, colors[0], 5, colors[1]);
  fillGradient(out, 5, colors[1], 10, colors[2]);
  fillGradient(out, 10, colors[2], 15, colors[0]);
  return out;
}

/**
 * Resolve palette id `pal` to a 16-entry palette, given the segment's three
 * colors (packed uint32). Mirrors loadPalette's dynamic cases:
 *   0 default -> Party (id 6); 2 primary; 3 primary+secondary;
 *   4 tertiary+secondary+primary; 5 as 4 but wider bands.
 * (Palette 1 "random" has no offline equivalent -> default.)
 */
export function loadPalette(
  pal: number,
  c0: number,
  c1: number,
  c2: number,
): RGB[] {
  const p0 = unpack(c0);
  const p1 = unpack(c1);
  const p2 = unpack(c2);
  switch (pal) {
    case 0:
    case 1:
      return FIXED_PALETTES[6]; // default (Party); random has no offline form
    case 2:
      return solid(p0);
    case 3: {
      const out: RGB[] = Array.from({ length: 16 }, () => [0, 0, 0] as RGB);
      // CRGBPalette16(prim,prim,sec,sec) -> gradient across the 4 quarters
      fillGradient(out, 0, p0, 5, p0);
      fillGradient(out, 5, p0, 10, p1);
      fillGradient(out, 10, p1, 15, p1);
      return out;
    }
    case 4:
      return fromColors([p2, p1, p0]);
    case 5: {
      // primary/secondary(/tertiary) in distinct blocks
      const out: RGB[] = Array.from({ length: 16 }, () => [0, 0, 0] as RGB);
      const hasTer = c2 !== 0;
      const blocks: RGB[] = hasTer
        ? [p0, p0, p0, p0, p0, p1, p1, p1, p1, p1, p2, p2, p2, p2, p2, p0]
        : [p0, p0, p0, p0, p0, p0, p0, p0, p1, p1, p1, p1, p1, p1, p1, p1];
      for (let i = 0; i < 16; i++) out[i] = [...blocks[i]] as RGB;
      return out;
    }
    default:
      return FIXED_PALETTES[pal] ?? FIXED_PALETTES[6];
  }
}

/** Whether a palette id has real offline data (dynamic 0-5 or fixed 6-71). */
export function hasPaletteData(pal: number): boolean {
  return pal <= 5 || pal in FIXED_PALETTES;
}

/**
 * Blend a 16-entry palette toward a target palette by up to `maxChanges`
 * byte-channels per call, one step at a time -- WLED/FastLED
 * nblendPaletteTowardPalette (declared fastled_slim.h:59; the body is not in
 * the vendored tree), ported byte-for-byte over the
 * RGB[16] representation this sim uses in place of CRGBPalette16's raw bytes.
 * Mutates `current` in place. A real FastLED asymmetry, not a bug: a channel
 * eases *up* by 1 per changed step but eases *down* by up to 2, so a palette
 * dims faster than it brightens.
 */
export function nblendPaletteTowardPalette(
  current: RGB[],
  target: RGB[],
  maxChanges: number,
): void {
  let changes = 0;
  for (let i = 0; i < 16; i++) {
    for (let ch = 0; ch < 3; ch++) {
      const p2 = target[i][ch];
      let p1 = current[i][ch];
      if (p1 === p2) continue;
      if (p1 < p2) {
        p1 += 1;
        changes++;
      } else {
        p1 -= 1;
        changes++;
        if (p1 > p2) p1 -= 1;
      }
      current[i][ch] = p1;
      if (changes >= maxChanges) return;
    }
  }
}
