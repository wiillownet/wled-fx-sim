// SPDX-License-Identifier: EUPL-1.2
// Ported from WLED v16.0.0 (commit 4374f01) wled00/FX_fcn.cpp (Segment/SEGENV +
// packed-color helpers).
// Copyright (c) 2016-present Christian Schwinne and individual WLED contributors
/**
 * Lightweight stand-in for WLED's Segment + SEGENV (wled00/FX_fcn.cpp), holding
 * everything a 1D effect body reads/writes across frames: the pixel buffer, the
 * per-effect scratch state (aux0/aux1/step/call/data), the segment inputs
 * (speed/intensity/palette/colors), and the packed-color helpers effects call
 * (fill, fade_out, fadeToBlackBy, blur, color_from_palette, color_wheel).
 *
 * Pure TS. Colors are packed uint32 words internally (like firmware); the public
 * frame buffer is unpacked to RGB by the sim wrapper. `now` is the show time in
 * ms (WLED's strip.now); all randomness goes through the seeded PRNG so a frame
 * is deterministic given its inputs (decisions.md, 2026-07-03).
 */
import type { RGB } from './lib8.js';
import {
  B,
  G,
  LINEARBLEND,
  LINEARBLEND_NOWRAP,
  NOBLEND,
  PRNG,
  R,
  W,
  color_add,
  color_fade,
  colorFromPalette,
  fast_color_scale,
  hsv2rgb_rainbow,
} from './lib8.js';
import { loadPalette } from './palettes.js';

// paletteBlend defaults to 0 in WLED (blend, wrap only when moving). These two
// macros (FX.cpp) are derived from that default.
const PALETTE_BLEND = 0;

export class Segment {
  readonly length: number;
  /** Pixel buffer, packed uint32 0x00RRGGBB. */
  readonly pixels: Uint32Array;

  // segment inputs (a block compiles to these)
  speed = 128; // sx 0-255
  intensity = 128; // ix 0-255
  palette = 0; // pal id
  /** P/S/T colors, packed uint32. */
  colors: [number, number, number] = [0xffffff, 0x000000, 0x000000];
  check1 = false;
  check2 = false;
  check3 = false;
  custom1 = 0;
  custom2 = 0;
  custom3 = 0;

  // SEGENV scratch, persists across frames
  aux0 = 0;
  aux1 = 0;
  step = 0;
  call = 0;
  /** Per-effect byte scratch (SEGENV.data / allocateData). */
  data: Uint8Array | null = null;

  /** Show time in ms for the current frame (WLED strip.now). */
  now = 0;
  readonly rng: PRNG;

  /** Resolved 16-entry palette for this frame (loaded once per frame). */
  private currentPalette: RGB[] = [];

  constructor(length: number, seed = 0x1234) {
    this.length = Math.max(1, length | 0);
    this.pixels = new Uint32Array(this.length);
    this.rng = new PRNG(seed);
  }

  /** Ensure `data` holds at least `bytes` (SEGENV.allocateData). */
  allocateData(bytes: number): Uint8Array {
    if (!this.data || this.data.length < bytes)
      this.data = new Uint8Array(bytes);
    return this.data;
  }

  /** Load _currentPalette for this frame from palette id + segment colors. */
  refreshPalette(): void {
    this.currentPalette = loadPalette(
      this.palette,
      this.colors[0],
      this.colors[1],
      this.colors[2],
    );
  }

  getCurrentPalette(): RGB[] {
    return this.currentPalette;
  }

  // --- pixel access ---------------------------------------------------------

  setPixelColor(i: number, c: number): void {
    if (i < 0 || i >= this.length) return;
    this.pixels[i] = c >>> 0;
  }

  getPixelColor(i: number): number {
    if (i < 0 || i >= this.length) return 0;
    return this.pixels[i];
  }

  /** SEGCOLOR(x) -- one of the P/S/T slots. */
  color(x: number): number {
    return this.colors[x] ?? 0;
  }

  fill(c: number): void {
    this.pixels.fill(c >>> 0);
  }

  // --- fades / blur, ported from Segment (FX_fcn.cpp) -----------------------

  /** fade_out(rate): fade every pixel toward the secondary color. */
  fade_out(rate: number): void {
    const r = (256 - (rate & 0xff)) >> 1;
    const mappedRate = Math.trunc(256 / (r + 1));
    const target = this.colors[1] >>> 0;
    for (let j = 0; j < this.length; j++) {
      let color = this.pixels[j];
      if (color === target) continue;
      let out = 0;
      for (let i = 0; i < 32; i += 8) {
        const c2 = (target >>> i) & 0xff;
        const c1 = (color >>> i) & 0xff;
        let delta = Math.trunc(((c2 - c1) * mappedRate) / 256);
        if (delta === 0) delta = c2 === c1 ? 0 : c2 > c1 ? 1 : -1;
        out |= ((c1 + delta) & 0xff) << i;
      }
      color = out >>> 0;
      this.pixels[j] = color;
    }
  }

  /** fadeToBlackBy(fadeBy): scale every pixel toward black. */
  fadeToBlackBy(fadeBy: number): void {
    if ((fadeBy & 0xff) === 0) return;
    for (let i = 0; i < this.length; i++) {
      this.pixels[i] = fast_color_scale(this.pixels[i], 255 - (fadeBy & 0xff));
    }
  }

  /** blur(amount): 1D box-ish blur, ported from Segment::blur (FastLED-derived). */
  blur(amount: number, smear = false): void {
    const blurAmount = amount & 0xff;
    if (blurAmount === 0) return;
    const keep = smear ? 255 : 255 - blurAmount;
    const seep = blurAmount >> 1;
    let cur = this.pixels[0];
    let carryover = fast_color_scale(cur, seep);
    this.pixels[0] = fast_color_scale(cur, keep);
    for (let i = 1; i < this.length; i++) {
      cur = this.pixels[i];
      const part = fast_color_scale(cur, seep);
      cur = fast_color_scale(cur, keep);
      cur = color_add(cur, carryover);
      this.pixels[i - 1] = color_add(this.pixels[i - 1], part);
      this.pixels[i] = cur;
      carryover = part;
    }
  }

  // --- palette / wheel, ported from Segment (FX_fcn.cpp) --------------------

  /**
   * color_from_palette(i, mapping, moving, mcol, pbri) -- WLED FX_fcn.cpp.
   * For the default palette (0) with mcol<3 it returns the raw segment color;
   * otherwise it samples _currentPalette.
   */
  color_from_palette(
    i: number,
    mapping: boolean,
    moving: boolean,
    mcol: number,
    pbri = 255,
  ): number {
    const color = this.getCurrentColor(mcol);
    if (this.palette === 0 && mcol < 3) {
      return color_fade(color, pbri, true);
    }
    let paletteIndex = i;
    if (mapping)
      paletteIndex = Math.min(Math.trunc((i * 255) / this.length), 255);
    // paletteBlend 0: blend, wrap only when moving.
    let blend = NOBLEND;
    if (PALETTE_BLEND === 0) blend = moving ? LINEARBLEND : LINEARBLEND_NOWRAP;
    const palcol = colorFromPalette(
      this.currentPalette,
      paletteIndex,
      pbri,
      blend,
    );
    return ((palcol & 0x00ffffff) | (W(color) << 24)) >>> 0;
  }

  /** getCurrentColor(mcol): a P/S/T slot; mcol 0-2, else primary. */
  getCurrentColor(mcol: number): number {
    return this.colors[mcol] ?? this.colors[0];
  }

  /** color_wheel(pos): HSV wheel, or palette sample when a palette is set. */
  color_wheel(pos: number): number {
    if (this.palette)
      return this.color_from_palette(pos & 0xff, false, false, 0);
    const w = W(this.getCurrentColor(0));
    const rgb = hsv2rgb_rainbow((pos & 0xff) << 8, 255, 255);
    return ((rgb & 0x00ffffff) | (w << 24)) >>> 0;
  }
}

/** Unpack the segment's pixel buffer into RGB triples (the public frame shape). */
export function readBuffer(seg: Segment): RGB[] {
  const out: RGB[] = new Array(seg.length);
  for (let i = 0; i < seg.length; i++) {
    const c = seg.pixels[i];
    out[i] = [R(c), G(c), B(c)];
  }
  return out;
}
