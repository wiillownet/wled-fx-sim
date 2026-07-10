/**
 * Public surface of the headless WLED 1D effect simulator (decisions.md,
 * 2026-07-03 "Effect previews become real 1D WLED simulations"). Pure TS, no
 * DOM/Svelte/canvas -- it produces an RGB pixel buffer per frame; a canvas
 * renderer + Svelte wiring live elsewhere.
 *
 * Frame cadence: WLED effects advance on a fixed ~42fps step (FRAMETIME). A
 * sim catches its internal clock up to the requested `nowMs` in FRAMETIME steps,
 * running the effect body once per step, so stateful effects (fades, spark
 * accumulators) evolve exactly as on-device regardless of how often the renderer
 * calls frame(). Given a fresh reset, frame(t) is deterministic in (fxId, params,
 * t) because all randomness is seeded. Calls should advance monotonically (rAF).
 */
import { Segment, readBuffer } from './segment.js';
import { EFFECT_SIMS, FRAMETIME } from './effects.js';
import type { RGB } from './lib8.js';
import { pack } from './lib8.js';

export type { RGB } from './lib8.js';
export { FRAMETIME } from './effects.js';

export interface EffectSimParams {
  /** Strip length in pixels (device LED count when connected; a default offline). */
  length: number;
  /** Speed slider `sx` (0-255). */
  sx?: number;
  /** Intensity slider `ix` (0-255). */
  ix?: number;
  /** Palette id `pal`. */
  pal?: number;
  /** P/S/T colors as [r,g,b] triples; only the ones the effect uses matter. */
  colors?: RGB[];
  /** Effect checkboxes o1/o2/o3 (few 1D effects use these). */
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
  /** Strip length (pixels per frame). */
  readonly length: number;
  /** Render the strip at show time `nowMs`; returns `length` RGB triples. */
  frame(nowMs: number): RGB[];
  /** Reset scratch state + PRNG to frame 0 (e.g. when params change). */
  reset(): void;
}

const DEFAULT_COLORS: RGB[] = [
  [255, 160, 0], // primary
  [0, 0, 0], // secondary
  [0, 0, 0], // tertiary
];

/** True if a real 1D simulation exists for this fx id (else: fall back to CSS). */
export function isPorted(fxId: number): boolean {
  return fxId in EFFECT_SIMS;
}

/** The ported effect ids, ascending. */
export function portedFxIds(): number[] {
  return Object.keys(EFFECT_SIMS)
    .map(Number)
    .sort((a, b) => a - b);
}

/** The effect body for `fxId`, or undefined if unported. */
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
  const run = EFFECT_SIMS[fxId];
  if (!run) {
    throw new Error(
      `No 1D simulation ported for fx id ${fxId}; gate on isPorted() and fall back to the CSS preview.`,
    );
  }

  const length = Math.max(1, params.length | 0);
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

  let seg = new Segment(length, seed);
  applyParams(seg);
  // internal fixed-step clock; -FRAMETIME so the first frame(0) runs step 0.
  let steppedTo = -FRAMETIME;

  const reset = (): void => {
    seg = new Segment(length, seed);
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
    frame,
    reset,
  };
}

function clamp8(v: number): number {
  const n = v | 0;
  return n < 0 ? 0 : n > 255 ? 255 : n;
}
