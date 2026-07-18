# @wiillownet/wled-fx-sim

Headless TypeScript preview simulator of WLED's LED effects: the FX.cpp
`mode_*` bodies (1D + 2D), the 1D and 2D particle-system engines, segment and
matrix surfaces, and palette resolution. Produces RGB pixel buffers per frame;
rendering is up to you. **Preview-only — this package does not drive
hardware.**

**Unofficial. Not affiliated with or endorsed by the WLED/FastLED projects.**

## Compatibility

Ported from **WLED v16.0.0** (commit `4374f01`); FastLED-derived math comes
from **FastLED 3.6.0** via [`@wiillownet/fastled-math`](../fastled-math). The
exported `WLED_SOURCE_VERSION` constant carries the pin at runtime. Accuracy
target is perceptual (same motion, same character), not bit-for-bit frame
parity: randomness is routed through a seeded PRNG so previews are
deterministic, where real firmware uses a hardware RNG.

```ts
import { createEffectSim, isPorted } from '@wiillownet/wled-fx-sim';

if (isPorted(89)) {
  const sim = createEffectSim(89, { length: 60, sx: 180, ix: 200 });
  const frame = sim.frame(performance.now()); // 60 [r,g,b] triples
}
```

2D effects render on a `width`×`height` matrix (row-major buffer; 16×16
default). `portedFxIds()` lists everything available.

## License: EUPL-1.2

This package is a derivative of WLED and inherits its **EUPL-1.2** license.
What that means for you as a consumer:

**Using this package from your own code.** Two distinct mechanisms are
relevant, and they are not the same argument:

1. **The EU interoperability exception** (Directive 2009/24/EC, as read by
   the CJEU in C-406/10 *SAS Institute*): linking against and calling a
   library through its API is not itself a derivative work of that library.
   On this reading, a tool that just imports and calls this package is not a
   covered derivative and does not itself have to be EUPL. Note honestly:
   the European Commission extends this reading to open-source consumers as
   its own interpretation — C-406/10 was a proprietary-vendor
   interoperability case, and this extension is well-grounded but **not
   settled precedent** for this scenario.
2. **EUPL Article 5's compatible-licence clause** is a separate, textual
   mechanism: if you merge this code into a work under a listed compatible
   licence (GPL-2.0+, GPL-3.0, AGPL-3.0, MPL-2.0, and others), you may
   distribute the merged work under that licence. It only matters if
   mechanism 1 doesn't apply to your situation, and it never yields MIT or
   Apache.

**Automated license gates.** FOSSA, `license-checker` allowlists, and similar
tools hard-block EUPL at the package level regardless of what the file
headers or this README say. If your organization runs such a gate, expect
this package to be flagged; the MIT-only
[`@wiillownet/fastled-math`](../fastled-math) passes them.

**If you copy code out of this package** (rather than importing it), EUPL
obligations attach to what you copied. Palette data from the cpt-city archive
is under separate, pending terms — see `THIRD-PARTY-LICENSES.md`.

## Provenance

Per-block license provenance (which upstream file each module ports, and the
per-function MIT/EUPL split of the math layer) is maintained in
[`src/PROVENANCE.md`](src/PROVENANCE.md).
