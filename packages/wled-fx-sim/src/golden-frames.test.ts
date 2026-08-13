// SPDX-License-Identifier: EUPL-1.2
// Test code original to this package.
import { describe, expect, it } from 'vitest';
import {
  createEffectSim,
  portedFxIds,
  supports1D,
  supports2D,
} from './index.js';

// Golden-frame snapshots: one fixed frame per ported effect at a canonical
// parameter set + seed. Guards against silent behavioral drift (a refactor
// that changes pixels without failing a unit test). Frames are deterministic
// (seeded PRNG), so these are exact, not fuzzy. Regenerate deliberately with
// `vitest run -u` after an intentional behavioral change.
//
// This block supplies width+height, so a dual id resolves to its 2D body here.
// The 1D bodies of those same ids are covered by the second block below --
// without it, half of every dual effect would sit unguarded.
describe('golden frames (seed 0x1234, sx=180, ix=200, pal=11, t=500ms)', () => {
  for (const fxId of portedFxIds()) {
    it(`fx ${fxId}`, () => {
      const sim = createEffectSim(fxId, {
        length: 16,
        width: 8,
        height: 8,
        sx: 180,
        ix: 200,
        pal: 11,
        seed: 0x1234,
      });
      expect(sim.frame(500)).toMatchSnapshot();
    });
  }
});

// The 1D branch of every dual effect (one WLED mode_* ported as both bodies).
// Derived, not hard-coded, so porting another dual body extends the guard by
// itself instead of silently leaving a strip render untested.
describe('golden frames, 1D branch of dual effects (same params, no matrix)', () => {
  const dualFxIds = portedFxIds().filter(
    (id) => supports1D(id) && supports2D(id),
  );

  it('there is at least one dual effect to cover', () => {
    expect(dualFxIds.length).toBeGreaterThan(0);
  });

  for (const fxId of dualFxIds) {
    it(`fx ${fxId} (1D)`, () => {
      const sim = createEffectSim(fxId, {
        length: 16,
        dimensions: '1d',
        sx: 180,
        ix: 200,
        pal: 11,
        seed: 0x1234,
      });
      expect(sim.height).toBe(1);
      expect(sim.width).toBe(16);
      expect(sim.frame(500)).toMatchSnapshot();
    });
  }
});
