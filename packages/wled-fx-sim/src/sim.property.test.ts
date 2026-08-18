// SPDX-License-Identifier: EUPL-1.2
// Test code original to this package.
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  createEffectSim,
  type EffectSimParams,
  is2DEffect,
  portedFxIds,
  supports1D,
  supports2D,
  type RGB,
} from './index.js';

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

// Short/odd/prime lengths were a total blind spot: every length literal in the
// suites was one of {1,6,10,12,16,20,30,32,40,50,60,64}.
describe('every ported effect: short and prime segment lengths render clean', () => {
  for (const fxId of portedFxIds().filter((id) => supports1D(id))) {
    it(`fx ${fxId}`, () => {
      for (const length of [2, 3, 7, 13]) {
        const sim = createEffectSim(fxId, {
          length,
          dimensions: '1d',
          sx: 180,
          ix: 200,
        });
        expectValidFrame(sim.frame(0), sim.length);
        expectValidFrame(sim.frame(1000), sim.length);
      }
    });
  }
});

// The 4-9 pixel window (both dims >= 2) is where the fx 201 particle-count
// floor used to divide down to zero particles and throw.
describe('every 2D effect: tiny matrices render clean', () => {
  for (const fxId of portedFxIds().filter((id) => supports2D(id))) {
    it(`fx ${fxId}`, () => {
      for (const [width, height] of [
        [2, 2],
        [2, 3],
        [3, 2],
        [2, 4],
        [3, 3],
        [5, 2],
      ]) {
        const sim = createEffectSim(fxId, {
          length: width * height,
          width,
          height,
          dimensions: '2d',
          sx: 180,
          ix: 200,
        });
        expectValidFrame(sim.frame(0), sim.length);
        expectValidFrame(sim.frame(1000), sim.length);
      }
    });
  }
});

// The extremes block above moves custom1-3 in lockstep with sx/ix, so a custom
// slider only ever sees its extreme alongside an extreme sx/ix. Sweep them
// independently against mid-range sx/ix.
describe('every ported effect: custom1-3 extremes against mid-range sx/ix', () => {
  for (const fxId of portedFxIds()) {
    it(`fx ${fxId}`, () => {
      const base: EffectSimParams = is2DEffect(fxId)
        ? { length: 256, width: 16, height: 16, dimensions: '2d' }
        : { length: 30, dimensions: '1d' };
      for (const v of [0, 255]) {
        for (const slot of [
          { custom1: v },
          { custom2: v },
          { custom3: v },
        ]) {
          const sim = createEffectSim(fxId, {
            ...base,
            sx: 128,
            ix: 128,
            ...slot,
          });
          expectValidFrame(sim.frame(0), sim.length);
          expectValidFrame(sim.frame(1000), sim.length);
        }
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
