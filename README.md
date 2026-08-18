# wled-fx-sim

Headless TypeScript ports of WLED's LED effects for previewing, plus the
FastLED-derived math kit they build on. Runs anywhere TS runs (browser, Node);
produces RGB pixel buffers per frame. Preview-only: this does not drive
hardware.

**Unofficial. Not affiliated with or endorsed by the WLED/FastLED projects.**

Ported from **WLED v16.0.0** (commit `4374f01`) and **FastLED 3.6.0** (WLED's
bundled `fastled_slim`).

## Packages

| package | license | what |
| --- | --- | --- |
| [`@wiillownet/fastled-math`](packages/fastled-math) | **MIT** | FastLED-derived 8/16-bit fixed-point math, easing/wave functions, packed-color utilities, `colorFromPalette`, `hsv2rgb_rainbow`, and the 7 named FastLED palettes. Zero dependencies. |
| [`@wiillownet/wled-fx-sim`](packages/wled-fx-sim) | **EUPL-1.2** | The WLED effect ports: FX.cpp `mode_*` bodies (1D + 2D), the 1D/2D particle engines, segment/matrix surfaces, and palette resolution. Depends on the math package. |

## Licensing

This is a deliberately split monorepo: there is no single repository license.
The math package is MIT because every function in it derives from
MIT-licensed FastLED code (verified per-function; see
`packages/wled-fx-sim/src/PROVENANCE.md`). The effects package is EUPL-1.2
because WLED is. The boundary is enforced in CI: `fastled-math` importing
anything from `wled-fx-sim` fails the build.

Baked gradient-palette data originating from the cpt-city archive is
documented separately in `packages/wled-fx-sim/THIRD-PARTY-LICENSES.md`,
with terms researched per collection: 37 of the 47 palettes carry cited
licenses (CC-BY-3.0, EUPL-compatible copyleft, or an author's informal
grant), and the remaining 10 are retained under the good-faith rationale
documented in that file.

## Development

pnpm workspace. `pnpm install`, then:

```bash
pnpm -r build       # tsup (esm + cjs + dts)
pnpm -r test        # vitest
pnpm typecheck      # tsc, both packages
```
