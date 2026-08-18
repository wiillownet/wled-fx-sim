# @wiillownet/wled-fx-sim

## 0.4.0

### Minor Changes

- **Breaking: `getEffectSim` is no longer exported.** It was undocumented, unused
  internally, and its return type leaked the internal `Segment` class into the
  published type definitions, so consumers got back a value typed against a class
  they could not name from the package root. Use `createEffectSim`, the documented
  entry point, which covers the same ground. `Segment` itself is still reachable
  via the `./segment` subpath export.

  Effect fixes, each verified against WLED v16.0.0 (commit `4374f01`):

  - **fx 201 "PS Blobs" crashed on small matrices.** Any matrix with both
    dimensions at least 2 and at most 9 pixels total threw a `TypeError` on the
    first frame, at every slider position. The 2D particle init was missing
    firmware's floor that refuses to allocate below 5 particles and falls back to
    a static render.
  - **Meteor (76) was missing its entire "Smooth" trail mode.** The `check3`
    branch — a different start position, a per-pixel trail decay, and its own draw
    — was never ported, leaving the checkbox inert.
  - **2D Drift (164) rotated at the wrong phase and rate** on any matrix whose
    larger dimension is odd. The halved dimension truncates to an integer upstream
    but was computed as a float here, which also drew two extra rings.
  - **Ghost Rider (120) drifted slower than firmware** in the -x/-y directions.
    Position updates truncated the product rather than the sum, losing up to a
    pixel per frame and skipping sub-unit steps entirely.
  - **Noisefire (143) settled on the wrong fire column after long runtimes.** Its
    noise coordinate is unsigned 32-bit on device and has to fold at each
    multiply; a trailing mask cannot recover bits that were never wrapped.
  - Narrower integer-width corrections: logical rather than signed shifts in Scan,
    Chase and Comet, a `uint8_t` narrow on Fire2012's ignition area, and one on PS
    Spray's initial hue.

  Palette lookups also change for indices above 255 — see the
  `@wiillownet/fastled-math` patch in this release for what moved and why.

  Internal, no API change:

  - The four particle-physics helpers shared by the 1D and 2D engines are defined
    once now rather than duplicated per engine, matching upstream.
  - The baked fixed-palette table is frozen. `loadPalette` hands entries out by
    reference, so a stray in-place write would previously have corrupted that
    palette for every simulator using the id.
  - The 1D particle caps now use WLED's default (generic ESP32) tier, matching the
    2D engine, which affects only segments longer than roughly 1787 pixels.

### Patch Changes

- Updated dependencies
  - @wiillownet/fastled-math@0.1.1

## 0.3.0

### Minor Changes

- 6dec2b3: Port the 28 remaining audio-reactive 1D effect bodies into `EFFECT_SIMS`, and
  widen the synthetic audio fixture to the channels they need.

  **Effects.** Pixels 128, Pixelwave 129, Juggles 130, Matripix 131, Gravimeter
  132, Plasmoid 133, Puddles 134, Midnoise 135, Noisemeter 136, Freqwave 137,
  Freqmatrix 138, Waterfall 140, Freqpixels 141, Noisefire 143, Puddlepeak 144,
  Noisemove 145, Ripple Peak 148, Freqmap 155, Gravcenter 156, Gravcentric 157,
  Gravfreq 158, DJ Light 159, Blurz 163, Rocktaves 185, PS GEQ 1D 212, PS Sonic
  Stream 214, PS Sonic Boom 215, PS Springy 216. Where firmware shares one body
  between several ids it is shared here too: `mode_gravcenter_base` backs
  132/156/157/158 and `mode_puddles_base` backs 134/144, each registered as
  wrappers exactly as upstream does.

  There is still no audio analysis in this package, and no way to feed it real
  audio. These previews react to the same canned, deterministic 4-second 120 BPM
  phrase the audio-reactive 2D effects already use.

  **Fixture.** `sampleSyntheticAudio()` previously returned only `volumeSmth` and
  a 16-band `fftResult`. It now also returns `volumeRaw`, `samplePeak`,
  `fftMajorPeak` and `myMagnitude` (`um_data` slots 1, 3, 4 and 5), still as a
  pure function of elapsed ms and still looping on the same phrase. `samplePeak`
  is defined as a beat landing in the current frame's `FRAMETIME`-wide window, so
  on the sim's fixed-step clock each beat fires on exactly one frame.

  **Behaviour change.** The two already-ported 2D bodies that wanted `volumeRaw`
  (Swirl 175, PS Spray 197) were reading `volumeSmth` in its place, because no
  raw channel existed. They now read the real channel, so their output moves.
  Those are the only two ids whose rendering changes.

  The fixture is still not exported; that stays open.

## 0.2.0

### Minor Changes

- 443d9a3: Port 16 more 2D effect bodies into `EFFECT_SIMS_2D` (43 -> 59), and let the
  caller choose the branch for effects that have both.

  **Dual effects.** The 7 WLED `mode_*` bodies that branch on `SEGMENT.is2D()`
  (Fireworks 42, Rain 43, Palette 65, Ripple 79, Halloween Eyes 82, Fireworks 1D
  90, Ripple Rainbow 99) now have their matrix branch ported alongside the
  existing 1D one. Firmware routes by the segment's own dimensionality, so these
  ids are no longer answerable from the registry alone:

  - New `EffectSimParams.dimensions?: '1d' | '2d'`. Default is `'2d'` when both
    `width` and `height` are supplied, else `'1d'`. An effect with only one body
    ignores it.
  - New `supports1D(fxId)` / `supports2D(fxId)` capability queries.
  - `is2DEffect(fxId)` now means matrix-_only_ (a 2D body and no 1D one), so a
    dual id answers `false`. This keeps the answer identical for every id that
    existed before -- no id shipped in 0.1.0 had both bodies -- and keeps it
    useful for its actual job, picking a renderer. Read `width`/`height` off the
    built `EffectSim` if you want what was really constructed.
  - `portedFxIds()` dedupes, since a dual id is a key in both registries.

  **Audio-reactive effects.** 9 audio-reactive 2D effects (GEQ 139, Funky Plank
  160, Waverly 165, Swirl 175, Akemi 186, PS Spray 197, PS GEQ 2D 198, PS GEQ Nova
  199, PS Blobs 201) are wired to a new internal synthetic band-energy fixture
  standing in for WLED's `um_data`: a deterministic, looping 4-second 120 BPM
  phrase. There is still no audio analysis in this package, and no way to feed it
  real audio -- those previews react to a canned pattern, which the README now
  states plainly. The fixture is not exported; that stays open.

## 0.1.0

### Minor Changes

- 27ad74f: Initial release: extracted from the wled-sequencer app's effect simulator.

  `@wiillownet/fastled-math` — FastLED-derived (3.6.0, MIT) 8/16-bit fixed-point
  math, easing/wave functions, packed-color utilities, `colorFromPalette`,
  `hsv2rgb_rainbow`, and the 7 named FastLED palettes.

  `@wiillownet/wled-fx-sim` — headless TypeScript preview ports of WLED
  v16.0.0's effects (FX.cpp 1D + 2D bodies, 1D/2D particle engines, segment and
  matrix surfaces, palette resolution), EUPL-1.2.

### Patch Changes

- Updated dependencies [27ad74f]
  - @wiillownet/fastled-math@0.1.0
