// SPDX-License-Identifier: EUPL-1.2
// Test code original to this package.
import { describe, expect, it } from 'vitest';
import { createEffectSim, portedFxIds } from './index.js';

// Golden-frame snapshots: one fixed frame per ported effect at a canonical
// parameter set + seed. Guards against silent behavioral drift (a refactor
// that changes pixels without failing a unit test). Frames are deterministic
// (seeded PRNG), so these are exact, not fuzzy. Regenerate deliberately with
// `vitest run -u` after an intentional behavioral change.
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
