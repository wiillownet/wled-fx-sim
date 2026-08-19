# @wiillownet/wled-fx-sim

## 0.5.0

### Minor Changes

- A fidelity pass against WLED v16.0.0 (commit `4374f01`). No API change, but
  rendered output moves for a few dozen effects, so this is a minor rather than a
  patch: anyone holding their own reference frames should expect churn.

  **One input-contract change.** `custom3` is now clamped to 0-31, not 0-255.
  `FX.h:454` declares it `uint8_t custom3 : 5`, so the firmware slider cannot
  present anything higher, and several ported bodies already read it as
  `map(custom3, 0, 31, ...)`. Callers passing a larger value were driving effects
  into states the device cannot reach. PS Sonic Boom (215) uses `custom3 >> 1` to
  index a 16-bin FFT array, so it read off the end and rendered black. `palette`
  is likewise narrowed to `uint8_t` at the boundary.

  **The show clock now wraps at 2^32 ms, as `millis()` does.** `strip.now` is
  `uint32_t` on device and every body in `FX.cpp` is written against that, but the
  sim took the caller's `nowMs` unfolded. This is not just a 49.7-day-uptime
  concern: `Date.now()` is the obvious thing to pass, and it lands 417x outside
  the range a device can represent. Effects that divide the clock rather than
  masking it diverged there: Twinkleup's palette index read 3345 instead of 3517.

  **Effects that were rendering the wrong thing at every setting:**

  - **Shimmer (161) was missing its entire "Granular" branch.** The per-pixel
    modulator that `custom2` gates (a sine under "Zebra", otherwise a `perlin16`
    sample, both flowing at `custom3`) was never ported, so three sliders and a
    checkbox were inert and only the bare gradient drew.
  - **Waving Cell (2D) lost its inner sine.** The body nests two
    (`sin8_t(x*aX + sin8_t(...))`); the port fed the raw shifted product to the
    outer one, so the temporal term entered as a ramp mod 256 instead of a sine.
  - **Multi Comet (59) faded to black instead of toward the background.**
    `fade_out` walks each channel toward `SEGCOLOR(1)` with a minimum one-step
    delta: a different curve from `fadeToBlackBy`, and the wrong target entirely
    whenever the secondary colour is not black.
  - **Soap (2D) started at full palette instead of black.** Firmware's init paints
    only the segment buffer, leaving the advected `pixels` array zeroed, so the
    first frames are dark and colour bleeds in.
  - **PS Balance (209) got 2D noise where firmware asks for 1D.** `perlin8(x)` and
    `perlin8(x, 0)` are different functions upstream.
  - **Several bodies were missing their degenerate-segment fallback.** The five
    audio 2D effects (GEQ, Funky Plank, Swirl, Waverly, Akemi) drop their
    `is2D()` guard onto a 1xN segment, and seven more (Fade, Strobe Rainbow, Fire
    Flicker, Solid Pattern Tri, and the 2D branches of Ripple, Exploding Fireworks
    and Ripple Rainbow) are missing `SEGLEN <= 1`. All of them ran the effect body
    where firmware fills with the primary colour; GEQ additionally hit a zero-span
    `map()`. `Segment2D.blur` had the matching gap and now takes the 1D path off a
    matrix, as `Segment::blur` does.

  **Colour and brightness:**

  - **`CRGB::operator|=` is a per-channel maximum, not a bitwise or.** An or
    lights bits neither operand set. Juggle (64) came out ~5% brighter than
    firmware draws it and Pacifica (101) ~10%, since Pacifica's `CRGB(2,5,7)`
    floor lands exactly where the difference shows.
  - **Aurora (38) inverted its own falloff.** Its brightness products reach ~2^32
    before being shifted back down, and a signed shift reads that as negative, so
    a pixel in the inner half of a mid-life wave came out _brighter_ instead of
    dimmer.
  - Palette indices that firmware wraps and the port did not: Tetrix (44) after
    ~33 stacks, Wavesins (184) whenever both custom sliders are up, Frizzles (177)
    below intensity 64, and Colored Bursts / DNA Spiral on any matrix past 128
    pixels wide. Colorwaves (67) and Pride 2015 (63) carried a fraction between
    two integer divisions, shifting roughly one channel in 1400 by a step.

  **Motion and geometry:** Oscillate (62) seeded two of three bars a pixel off on
  lengths not divisible by 4; Bouncing Balls (91) moved a ball a frame early on
  long strips and Popcorn (95) started its kernels on the floor rather than
  inactive; Rain (43) restarted its spark at column 0 where firmware walks it down
  the last column; Chase Flash (31) and PacMan (151) desynchronised after ~30
  minutes; Drift Rose (123) folded off-matrix coordinates back onto column 0; and
  the 1D particle engine carried a fraction in its collision mass ratio that the
  2D engine already truncated (visible in fx 211).

  **Long-running previews.** The substituted `micros()` clock now rolls over at
  2^32 µs (~71.6 min) across all seven audio effects that read it, and ~15 further
  sites now fold their `uint32` time products where firmware does, rather than
  after: a divide, unlike a mask, cannot recover a wrap that never happened.
  Affected: Perlin Move (147) at ~9.3 h, Twinkleup (106) at ~3.1 days, Sinewave
  (108) at ~6 days, Plasma Ball (178) at ~6.2 days, Noise 2 (71) at ~4.6 days,
  Noise 1 (70) at ~74 days, Color Clouds (218) at ~4.7 h, Polar Lights (2D) at
  ~25 min on a large matrix, plus Noise 4, Twinklefox/Twinklecat and the two wipes.

  **Device memory caps** now apply to Starburst (89) and Exploding Fireworks 1D
  (90), matching the other budget-sized effects. They bite from 1088px and 808px
  respectively. The firmware source's own "640 bytes for ESP32" comments are
  stale and predate a 64k bump, so the real per-segment budget is 8192.

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
