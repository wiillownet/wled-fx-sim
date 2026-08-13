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

### 1D, 2D, and effects that are both

Most ids render one way: `supports1D(id)` and `supports2D(id)` say which.
`is2DEffect(id)` is the narrower question — matrix-*only*, no strip body — and is
the one to ask when picking a renderer.

A handful of WLED `mode_*` bodies branch on `SEGMENT.is2D()` internally and are
ported here as **both** bodies (Fireworks 42, Rain 43, Palette 65, Ripple 79,
Halloween Eyes 82, Fireworks 1D 90, Ripple Rainbow 99). Firmware picks by the
segment's own dimensionality, so for those the caller picks:

```ts
createEffectSim(42, { length: 60 });                    // strip body
createEffectSim(42, { length: 60, width: 16, height: 16 }); // matrix body
createEffectSim(42, { length: 60, width: 16, height: 16, dimensions: '1d' }); // strip, explicitly
```

Supplying both `width` and `height` selects the 2D body; `dimensions` overrides
that either way. An id with only one body ignores the request — this package does
not model firmware expanding a 1D effect across a 2D segment.

### Audio-reactive effects

Nine 2D effects (GEQ 139, Funky Plank 160, Waverly 165, Swirl 175, Akemi 186, and
PS Spray/GEQ 2D/GEQ Nova/Blobs 197-201) read WLED's audio globals on device. This
package performs **no audio analysis** — no microphone, no FFT, no beat detection,
and no way to feed it real audio. It drives those bodies from a built-in synthetic
fixture instead: a deterministic, looping 4-second 120 BPM drum-and-bass phrase
standing in for `volumeSmth` and the 16-band `fftResult`.

So they animate, and they animate *plausibly*, but they are reacting to a canned
pattern rather than to anything you played. Treat those previews as a
representative look, not a signal path. Frames stay deterministic in `(fxId,
params, t)` like every other effect here.

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
