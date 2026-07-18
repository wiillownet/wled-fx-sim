# @wiillownet/fastled-math

FastLED-derived 8/16-bit fixed-point math, color, and palette kit in
TypeScript. Zero dependencies, pure functions, ESM + CJS.

**Unofficial. Not affiliated with or endorsed by the WLED/FastLED projects.**

Ported from **FastLED 3.6.0** as bundled by WLED v16.0.0 (`fastled_slim`).
The port is faithful to the integer math: values wrap and truncate exactly
where the C `uint8_t`/`uint16_t` types do, because downstream animation
motion depends on it.

## What's in it

- **Scaling/saturation:** `scale8`, `scale8_video`, `scale16`, `qadd8`,
  `qsub8`, `lerp8by8`
- **Waves + easing:** `triwave8`, `triwave16`, `cubicwave8`, `quadwave8`,
  `ease8InOutCubic`
- **Packed color (uint32 `0xWWRRGGBB`):** `rgbw32`, `R`/`G`/`B`/`W`, `pack`,
  `unpack`, `BLACK`, `averageLight`
- **Palettes:** `colorFromPalette` (16-entry palette lookup with
  `NOBLEND`/`LINEARBLEND`/`LINEARBLEND_NOWRAP`), plus the 7 named FastLED
  palettes (`PartyColors`, `CloudColors`, `LavaColors`, `OceanColors`,
  `ForestColors`, `RainbowColors`, `RainbowStripeColors`) and
  `FASTLED_PALETTES` keyed by WLED palette id (6-12)
- **HSV:** `hsv2rgb_rainbow` (FastLED's perceptually-weighted rainbow mapping)
- `FASTLED_SOURCE_VERSION` — the FastLED release this is derived from

```ts
import { colorFromPalette, LavaColors, scale8 } from '@wiillownet/fastled-math';

const c = colorFromPalette(LavaColors, 190, scale8(200, 255));
```

## License

MIT. Derived from FastLED 3.6.0 (MIT); see `THIRD-PARTY-LICENSES.md` for the
upstream notice. This package deliberately contains **only** FastLED-derived
code — the WLED-original math (integer trig, beat functions, gradient noise,
gamma) lives in the EUPL-licensed companion package
`@wiillownet/wled-fx-sim`, and CI enforces that nothing here imports it.
