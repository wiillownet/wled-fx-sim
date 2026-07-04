/**
 * Micro-benchmarks for the headless 1D effect simulator. Answers "how expensive
 * is one preview strip's per-frame sim work?" across a spread of ported effects
 * — a cheap static one (Solid) through stateful spark/fire accumulators. Pure
 * node, no DOM. Run with `pnpm bench`.
 *
 * Each case advances the sim one FRAMETIME step per iteration (the real render
 * cadence), so the number is per-frame sim cost at a realistic strip length.
 */
import { bench, describe } from 'vitest';
import { createEffectSim, FRAMETIME } from './index.js';

const LENGTH = 150; // representative strip; device LED counts cluster here

// A spread: 0 Solid (trivial), 42 Fireworks (spark accumulator), 66 Fire 2012
// (heat diffusion), 87 (flow) — cheap → stateful, so a regression in any class
// of effect shows up. Kept to ids known ported (see EFFECT_SIMS).
const CASES: Array<[number, string]> = [
  [0, 'Solid'],
  [42, 'Fireworks'],
  [66, 'Fire 2012'],
  [87, 'Flow'],
];

describe('sim frame() per-frame cost @150px', () => {
  for (const [fxId, name] of CASES) {
    const sim = createEffectSim(fxId, { length: LENGTH });
    let t = 0;
    bench(`fx ${fxId} ${name}`, () => {
      t += FRAMETIME;
      sim.frame(t);
    });
  }
});
