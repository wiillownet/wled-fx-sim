# @wiillownet/fastled-math

## 0.1.1

### Patch Changes

- Fix `colorFromPalette` applying the `LINEARBLEND_NOWRAP` remap to an
  already-narrowed index.

  Upstream (`colors.cpp:118`) remaps the full unsigned palette index and narrows
  it to a byte only afterward; this narrowed first. The two agreed for indices up
  to 255 and diverged above it: at index 510 the lookup landed on palette entry 14
  where firmware uses 13, and at 5000 on entry 7 where firmware uses 4.

  `LINEARBLEND_NOWRAP` is the default blend mode whenever the palette is not
  moving, so this was the common path rather than an edge case. Any caller passing
  an index above 255 was affected — a time-driven counter, or a raw 16-bit noise
  value.

  This is a behavior change rather than an API change: affected palette lookups
  now return different colors.

## 0.1.0

### Minor Changes

- 27ad74f: Initial release: extracted from the wled-sequencer app's effect simulator.

  `@wiillownet/fastled-math` — FastLED-derived (3.6.0, MIT) 8/16-bit fixed-point
  math, easing/wave functions, packed-color utilities, `colorFromPalette`,
  `hsv2rgb_rainbow`, and the 7 named FastLED palettes.

  `@wiillownet/wled-fx-sim` — headless TypeScript preview ports of WLED
  v16.0.0's effects (FX.cpp 1D + 2D bodies, 1D/2D particle engines, segment and
  matrix surfaces, palette resolution), EUPL-1.2.
