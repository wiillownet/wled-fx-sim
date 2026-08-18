# @wiillownet/wled-fx-sim

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
