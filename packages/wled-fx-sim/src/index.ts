/**
 * Public surface of the headless WLED effect simulator (decisions.md,
 * 2026-07-03 "Effect previews become real 1D WLED simulations"; 2026-07-17
 * extended to 2D matrix effects). Pure TS, no DOM/Svelte/canvas -- it produces
 * an RGB pixel buffer per frame; a canvas renderer + Svelte wiring live
 * elsewhere.
 *
 * Frame cadence: WLED effects advance on a fixed ~42fps step (FRAMETIME). A
 * sim catches its internal clock up to the requested `nowMs` in FRAMETIME steps,
 * running the effect body once per step, so stateful effects (fades, spark
 * accumulators) evolve exactly as on-device regardless of how often the renderer
 * calls frame(). Given a fresh reset, frame(t) is deterministic in (fxId, params,
 * t) because all randomness is seeded. Calls should advance monotonically (rAF).
 *
 * 1D effects render over `length` pixels; 2D effects render over a
 * `width`×`height` matrix (row-major buffer, length = width*height). Matrix
 * dimensions sync to the connected device's 2D setup; 16×16 is the canonical
 * offline default (decisions.md, 2026-07-17).
 */
import { Segment, readBuffer } from './segment.js';
import { Segment2D } from './segment-2d.js';
import { EFFECT_SIMS, EFFECT_SIMS_2D, FRAMETIME } from './effects.js';
import type { RGB } from './lib8.js';
import { pack } from './lib8.js';

export type { RGB } from './lib8.js';
export { FRAMETIME } from './effects.js';

/** Offline default matrix dimensions for 2D previews. */
export const DEFAULT_MATRIX_WIDTH = 16;
export const DEFAULT_MATRIX_HEIGHT = 16;

export interface EffectSimParams {
  /** Strip length in pixels (device LED count when connected; a default offline). 1D only. */
  length: number;
  /** Matrix width for 2D effects (device width when connected; 16 offline). */
  width?: number;
  /** Matrix height for 2D effects (device height when connected; 16 offline). */
  height?: number;
  /** Speed slider `sx` (0-255). */
  sx?: number;
  /** Intensity slider `ix` (0-255). */
  ix?: number;
  /** Palette id `pal`. */
  pal?: number;
  /** P/S/T colors as [r,g,b] triples; only the ones the effect uses matter. */
  colors?: RGB[];
  /** Effect checkboxes o1/o2/o3. */
  check1?: boolean;
  check2?: boolean;
  check3?: boolean;
  /** Custom sliders c1/c2/c3 (0-255); effect-specific meaning. */
  custom1?: number;
  custom2?: number;
  custom3?: number;
  /** PRNG seed -- fix it for a reproducible preview (default matches WLED's). */
  seed?: number;
}

export interface EffectSim {
  /** The fx id this sim runs. */
  readonly fxId: number;
  /** Total pixels per frame (strip length, or width*height for 2D). */
  readonly length: number;
  /** Frame width in pixels (equals `length` for a 1D effect). */
  readonly width: number;
  /** Frame height in pixels (1 for a 1D effect). */
  readonly height: number;
  /** Render at show time `nowMs`; returns `length` RGB triples (row-major for 2D). */
  frame(nowMs: number): RGB[];
  /** Reset scratch state + PRNG to frame 0 (e.g. when params change). */
  reset(): void;
}

const DEFAULT_COLORS: RGB[] = [
  [255, 160, 0], // primary
  [0, 0, 0], // secondary
  [0, 0, 0], // tertiary
];

/** True if a real simulation (1D or 2D) exists for this fx id (else: fall back to CSS). */
export function isPorted(fxId: number): boolean {
  return fxId in EFFECT_SIMS || fxId in EFFECT_SIMS_2D;
}

/** True if `fxId` is simulated on a 2D matrix (its frames are width×height). */
export function is2DEffect(fxId: number): boolean {
  return fxId in EFFECT_SIMS_2D;
}

/** The ported effect ids (1D + 2D), ascending. */
export function portedFxIds(): number[] {
  return [...Object.keys(EFFECT_SIMS), ...Object.keys(EFFECT_SIMS_2D)]
    .map(Number)
    .sort((a, b) => a - b);
}

/** The 1D effect body for `fxId`, or undefined if unported (2D bodies are internal). */
export function getEffectSim(
  fxId: number,
): ((seg: Segment) => void) | undefined {
  return EFFECT_SIMS[fxId];
}

/**
 * Build a stateful simulator for one effect + parameter set. Throws if `fxId`
 * has no port -- callers should gate on isPorted() and fall back to the CSS
 * preview family for unported ids (they are reported, never faked).
 */
export function createEffectSim(
  fxId: number,
  params: EffectSimParams,
): EffectSim {
  const run2d = EFFECT_SIMS_2D[fxId];
  const run1d = EFFECT_SIMS[fxId];
  if (!run1d && !run2d) {
    throw new Error(
      `No simulation ported for fx id ${fxId}; gate on isPorted() and fall back to the CSS preview.`,
    );
  }

  const is2d = !!run2d;
  const width = is2d
    ? Math.max(1, (params.width ?? DEFAULT_MATRIX_WIDTH) | 0)
    : Math.max(1, params.length | 0);
  const height = is2d
    ? Math.max(1, (params.height ?? DEFAULT_MATRIX_HEIGHT) | 0)
    : 1;
  const length = width * height;
  const seed = params.seed ?? 0x1234;

  const applyParams = (seg: Segment): void => {
    seg.speed = clamp8(params.sx ?? 128);
    seg.intensity = clamp8(params.ix ?? 128);
    seg.palette = params.pal ?? 0;
    const cols = params.colors ?? DEFAULT_COLORS;
    seg.colors = [
      pack(cols[0] ?? DEFAULT_COLORS[0]),
      pack(cols[1] ?? DEFAULT_COLORS[1]),
      pack(cols[2] ?? DEFAULT_COLORS[2]),
    ];
    seg.check1 = params.check1 ?? false;
    seg.check2 = params.check2 ?? false;
    seg.check3 = params.check3 ?? false;
    seg.custom1 = clamp8(params.custom1 ?? 0);
    seg.custom2 = clamp8(params.custom2 ?? 0);
    seg.custom3 = clamp8(params.custom3 ?? 0);
  };

  const build = (): { seg: Segment; run: (seg: Segment) => void } => {
    if (is2d) {
      const seg2d = new Segment2D(width, height, seed);
      return { seg: seg2d, run: (s) => run2d(s as Segment2D) };
    }
    return { seg: new Segment(length, seed), run: run1d };
  };

  let { seg, run } = build();
  applyParams(seg);
  // internal fixed-step clock; -FRAMETIME so the first frame(0) runs step 0.
  let steppedTo = -FRAMETIME;

  const reset = (): void => {
    ({ seg, run } = build());
    applyParams(seg);
    steppedTo = -FRAMETIME;
  };

  const frame = (nowMs: number): RGB[] => {
    const target = Math.max(0, Math.floor(nowMs));
    // Bound catch-up work: a huge jump (e.g. a fresh sim asked for a far time)
    // fast-forwards the clock rather than looping millions of steps. Preview
    // accuracy is perceptual, so a bounded warm-up is acceptable.
    const MAX_STEPS = 4096;
    if (Math.floor((target - steppedTo) / FRAMETIME) > MAX_STEPS) {
      steppedTo = target - MAX_STEPS * FRAMETIME;
    }
    while (steppedTo + FRAMETIME <= target) {
      steppedTo += FRAMETIME;
      seg.now = steppedTo;
      seg.refreshPalette();
      run(seg);
      seg.call++;
    }
    return readBuffer(seg);
  };

  return {
    fxId,
    length,
    width,
    height,
    frame,
    reset,
  };
}

function clamp8(v: number): number {
  const n = v | 0;
  return n < 0 ? 0 : n > 255 ? 255 : n;
}
