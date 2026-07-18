// SPDX-License-Identifier: EUPL-1.2
// Test code original to this package.
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { createEffectSim, portedFxIds, type RGB } from './index.js';

// A cheap-but-representative spread of effects across families: classic 1D,
// noise, particle 1D, 2D direct, particle 2D. Running every ported id through
// fast-check would take minutes; the full registry is covered by the (fast)
// determinism + range sweep below.
const SAMPLED_FX = [0, 1, 9, 42, 70, 89, 108, 202, 208].filter((id) =>
  portedFxIds().includes(id),
);

const u8Arb = fc.integer({ min: 0, max: 255 });

function expectValidFrame(frame: RGB[], len: number): void {
  expect(frame).toHaveLength(len);
  for (const [r, g, b] of frame) {
    for (const ch of [r, g, b]) {
      expect(Number.isInteger(ch)).toBe(true);
      expect(ch).toBeGreaterThanOrEqual(0);
      expect(ch).toBeLessThanOrEqual(255);
    }
  }
}

describe('sampled effects: no throw / no NaN / in-range at arbitrary params', () => {
  for (const fxId of SAMPLED_FX) {
    it(`fx ${fxId}`, () => {
      fc.assert(
        fc.property(u8Arb, u8Arb, u8Arb, fc.integer({ min: 0, max: 71 }), (sx, ix, seedByte, pal) => {
          const sim = createEffectSim(fxId, {
            length: 30,
            sx,
            ix,
            pal,
            seed: 0x1000 + seedByte,
          });
          expectValidFrame(sim.frame(0), sim.length);
          expectValidFrame(sim.frame(500), sim.length);
        }),
        { numRuns: 25 },
      );
    });
  }
});

describe('every ported effect: parameter extremes 0/255 render clean frames', () => {
  for (const fxId of portedFxIds()) {
    it(`fx ${fxId}`, () => {
      for (const v of [0, 255]) {
        const sim = createEffectSim(fxId, {
          length: 30,
          sx: v,
          ix: v,
          custom1: v,
          custom2: v,
          custom3: v,
          check1: v === 255,
          check2: v === 255,
          check3: v === 255,
        });
        expectValidFrame(sim.frame(0), sim.length);
        expectValidFrame(sim.frame(1000), sim.length);
      }
    });
  }
});

describe('determinism given seed', () => {
  for (const fxId of portedFxIds()) {
    it(`fx ${fxId} reproduces frames exactly for a fixed seed`, () => {
      const mk = () => createEffectSim(fxId, { length: 30, sx: 180, ix: 200, seed: 0xbeef });
      const a = mk();
      const b = mk();
      for (const t of [0, 250, 1000]) {
        expect(a.frame(t)).toEqual(b.frame(t));
      }
    });
  }
});
