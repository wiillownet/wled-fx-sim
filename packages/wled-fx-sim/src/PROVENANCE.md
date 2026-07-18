# Provenance ledger

Per-block license provenance for the ported WLED effect simulator. This is the
single source the plan's §5 derives from: per-file license headers,
`THIRD-PARTY-LICENSES.md`, the `WLED_SOURCE_VERSION` constant, the README
compatibility matrix, and the MIT-vs-EUPL package routing.

**Pin:** all upstream ports are against **WLED tag v16.0.0 (commit `4374f01`)**.
FastLED-derived code is against **FastLED 3.6.0** (WLED's bundled `fastled_slim`).

**Method:** license per *block*, not per file. WLED's own convention is that
functions derived from FastLED carry a comment containing "derived from FastLED";
everything unmarked in a WLED-authored file is EUPL-1.2-by-default (WLED repo is
EUPL-1.2-or-later, no CLA). Default-to-restrictive: an ambiguous or unmarked block
routes EUPL.

**Routing target:** `MIT` → `@fastled-math` package · `EUPL` → `@wled-effects`
package (see plan §5, Decision B: one monorepo, two packages).

## Upstream sources

| upstream file | repo | license | notes |
| --- | --- | --- | --- |
| `src/dependencies/fastled_slim/fastled_slim.h` | wled-dev/WLED (from FastLED 3.6.0) | **MIT** | own header: "Licensed under MIT" |
| `wled00/FX.cpp` | wled-dev/WLED | **EUPL-1.2** | EUPL header; 1D + 2D `mode_*` bodies |
| `wled00/FX.h` | wled-dev/WLED | **EUPL-1.2** | EUPL header; struct/const surface |
| `wled00/FXparticleSystem.cpp` | wled-dev/WLED | **EUPL-1.2** | EUPL header; 1D + 2D particle engines |
| `wled00/FXparticleSystem.h` | wled-dev/WLED | **EUPL-1.2** | EUPL header |
| `wled00/FX_2Dfcn.cpp` | wled-dev/WLED | **EUPL-1.2** | EUPL header; 2D matrix helpers |
| `wled00/FX_fcn.cpp` | wled-dev/WLED | **EUPL-1.2** | Segment / SEGENV / loadPalette |
| `wled00/colors.cpp` | wled-dev/WLED | **mixed** | per-function; FastLED-derived fns marked, rest EUPL |
| `wled00/palettes.cpp` | wled-dev/WLED | **mixed** | FastLED-imported palettes MIT (marked), WLED gradients EUPL |
| `wled00/wled_math.cpp` | wled-dev/WLED | **EUPL-1.2** | WLED-original integer trig (replaced FastLED's) |
| `wled00/util.cpp` | wled-dev/WLED | **mixed** | beat/beatsin FastLED-lineage, perlin WLED-original — see below |
| `wled00/prng.h` | wled-dev/WLED | **EUPL-1.2** | WLED-original 16-bit PRNG |
| cpt-city gradient palettes | seaviewsensing.com/pub/cpt-city (via FastLED/WLED) | **third-party, per-palette** | 31 of the baked palettes; "originally from" c3g source; NEW bucket — see flag 1 |
| kitesurfer1404/WS2812FX (2016) | separate repo | **MIT** | ancestor only for the simplest early 1D effects; per-effect diff, not assumed |

## Per sim-file blocks

| sim file | upstream block | license | ws2812fxMatch |
| --- | --- | --- | --- |
| `lib8.ts` | **split — see per-function table below** | mixed | some (MIT primitives) / n/a |
| `segment.ts` | `FX_fcn.cpp` Segment/SEGENV + packed-color helpers | EUPL | n/a |
| `segment-2d.ts` | `FX_2Dfcn.cpp` (blur2D/move/wu_pixel/setPixelColorXY) + `FX.h` 2D surface | EUPL | n/a (WS2812FX is 1D-only) |
| `palettes.ts` | `FX_fcn.cpp` `Segment::loadPalette` | EUPL | n/a |
| `palette-data.generated.ts` | `palettes.cpp` baked table (ids 6-71) | **three-way** — 4 MIT / 31 cpt-city / 16 EUPL (resolved, see flag 1) | n/a |
| `particles-1d.ts` | `FXparticleSystem.cpp/.h` 1D engine + PS-1D effects (fx 202-213) | EUPL | **n/a** — no WS2812FX ancestor |
| `particles-2d.ts` | `FXparticleSystem.cpp/.h` 2D engine + PS-2D effects | EUPL | **n/a** — no WS2812FX ancestor |
| `effects.ts` | `FX.cpp` `mode_*` bodies (1D + 2D) | EUPL (presumptive) | **per-effect diff pending** for the simple early set only |
| `index.ts` | sim-original public surface (no port) | authored | n/a |
| `sim.bench.ts` | sim-original bench harness | authored | n/a |

## `lib8.ts` per-function routing (the critical split)

This one file commingles MIT-derived and EUPL-derived code. To ship a clean MIT
`@fastled-math` package it must be physically split. The MIT subset is **closed**
(these are leaf functions; none call WLED-original code), so the split is clean.

### MIT (→ `@fastled-math`) — FastLED 3.6.0 derived
`qadd8`, `qsub8`, `scale8`, `scale8_video`, `scale16`, `lerp8by8` · `triwave8`,
`triwave16`, `cubicwave8`, `quadwave8`, `ease8InOutCubic` (+ `ease8InOutQuad`) ·
`averageLight` (FastLED `CRGB::getAverageLight`) · `hsv2rgb_rainbow`
(`fastled_slim` rainbow) · `colorFromPalette` (colors.cpp:117, marked "derived
from FastLED") · blend-mode consts `NOBLEND`/`LINEARBLEND`/`LINEARBLEND_NOWRAP`
(FastLED `TBlendType`).

Trivial bit utilities (`rgbw32`, `R`/`G`/`B`/`W`, `pack`, `unpack`, `BLACK`) are
uncopyrightable packing helpers — safe in either package; keep with the MIT kit.

### EUPL (→ `@wled-effects`) — WLED-original
- **Trig:** `sin16_t`, `cos16_t`, `sin8_t`, `cos8_t`, `sin_approx`, `cos_approx`
  — `wled_math.cpp` Bhaskara-I; WLED 16.0 *replaced* FastLED's `sin16`/`sin8`.
- **Beat:** `beat88`, `beat16`, `beat8`, `beatsin8_t`, `beatsin16_t`, `beatsin88_t`
  — `util.cpp`. FastLED lineage, but WLED-reimplemented AND they call the EUPL
  `sin16_t`, so entangled → route EUPL.
- **Color ops:** `color_blend`, `color_add`, `color_fade` (colors.cpp, unmarked),
  `fast_color_scale`, `fast_color_scaleAdd` (WLED/@dedehai), `gamma8`, `gamma8inv`,
  `gamma32inv` (colors.cpp `NeoGammaWLEDMethod`), `hsv2rgb_spectrum` (colors.cpp,
  unmarked → EUPL by default-restrictive).
- **Noise:** `inoise16`, `inoise16xy`, `perlin8`, `inoise8` (+ internal
  `smoothstep`, `perlin2D_raw`) — `util.cpp`, WLED-original Perlin by @dedehai;
  WLED 16.0 replaced FastLED's table noise from scratch.
- **PRNG:** `PRNG` class — `prng.h`, WLED-original.

## Flags — determinations still open

1. **`palette-data.generated.ts` — per-palette split. RESOLVED, with a new
   cpt-city bucket the plan didn't anticipate.** The baked table (ids 6-71) is
   three-way, not two:
   - **4 FastLED-named → MIT:** `CloudColors`, `LavaColors`, `OceanColors`,
     `ForestColors` (`palettes.cpp` header line 15: "imported from FastLED @ 3.6.0
     ... MIT"). Plus FastLED built-ins defined in `fastled_slim` itself
     (`RainbowColors`, `PartyColors`, `HeatColors`) → MIT.
   - **31 cpt-city gradient `*_gp` → third-party, per-palette:** each carries an
     "originally from http://seaviewsensing.com/pub/cpt-city/..." provenance
     comment. These are NOT FastLED-authored and NOT WLED-original — they are
     cpt-city community gradient data, redistributed by *both* MIT-FastLED and
     EUPL-WLED (strong signal they're freely redistributable, but c3g terms vary
     per author: public-domain / CC / Apache). **Legal-consult item:** confirm
     they can ship and under what attribution; do not blanket-label MIT or EUPL.
     List: `ib_jul01`, `es_vintage_57/01`, `es_rivendell_15`, `rgi_15`,
     `retro2_16`, `Analogous_1`, `es_pinksplash_08`, `es_ocean_breeze_036`,
     `departure`, `es_landscape_64/33`, `rainbowsherbet`, `gr65_hult`, `gr64_hult`,
     `GMT_drywet`, `ib15`, `Tertiary_01`, `lava`, `Colorfull`, `Pink_Purple`,
     `Sunset_Real`, `Sunset_Yellow`, `Beech`, `Another_Sunset`, `es_autumn_19`,
     `BlacK_Blue_Magenta_White`, `BlacK_Magenta_Red`, `BlacK_Red_Magenta_Yellow`,
     `Blue_Cyan_Yellow`, `temperature` (all `*_gp`).
   - **16 WLED-authored `*_gp` → EUPL:** no cpt-city provenance; contributed to
     WLED: `fierce_ice`, `retro_clown`, `candy`, `toxy_reaf`, `fairy_reaf`,
     `semi_blue`, `pink_candy`, `red_reaf`, `aqua_flash`, `yelblu_hot`,
     `lite_light`, `red_flash`, `blink_red`, `red_shift`, `red_tide`, `candy2`.
     (`fierce_ice` is borderline — cpt-city "fierce-ice" exists; re-check its
     provenance comment before finalizing.)

   **Routing consequence:** the baked table is 47/51 non-MIT, so it does **not**
   go to the MIT math package. It stays effects-side (EUPL package owns palette
   resolution); cpt-city palettes ship there with cpt-city attribution in
   `THIRD-PARTY-LICENSES.md`. Only FastLED's own named palettes are MIT-clean, and
   they live in `fastled_slim`, not this generated table — so nothing here blocks
   the math package.
2. **`effects.ts` WS2812FX diff (simple early effects only).** For the handful of
   effects plausibly still close to the 2016 kitesurfer1404/WS2812FX MIT original
   (Blink, Static, Breathe, Color Wipe, Rainbow, basic chases), diff the specific
   algorithm against WS2812FX's *current* source; a match → MIT-eligible. Everything
   else in `FX.cpp` is WLED-original → EUPL, no diff needed. Particle + 2D surfaces:
   `ws2812fxMatch: n/a`, skip entirely (no ancestor).
3. **`sin16_t`/`beat*` FastLED-lineage note.** Routed EUPL here on the entanglement
   argument (they depend on WLED-original trig). If the math package ever wants a
   FastLED-faithful `sin16`, that would be a *separate* clean-FastLED port, not a
   reuse of these.
4. **PRNG copyrightability.** A 16-bit xorshift is thin expression; routed EUPL by
   default-restrictive, but a from-scratch reimplementation would carry no WLED
   provenance if the math package ever needs deterministic RNG.

## Math-package extraction manifest (Decision B pilot)

The clean-MIT `@fastled-math` package = the MIT subset of `lib8.ts` (see the
per-function table), extracted into its own file(s), plus the **4 FastLED-named
palette arrays** and FastLED's built-in palettes from `fastled_slim`
(`Rainbow`/`Party`/`Heat`). It does **not** include `palette-data.generated.ts`
(47/51 cpt-city or WLED-authored → effects package). The subset has **zero**
dependency on any EUPL block, so it ships *before* the WLED licensing question
resolves — the Decision B pilot.

## [2026-07-17] Extraction-time corrections (monorepo spinout)

Verified against `.wled-src/palettes.cpp` (v16.0.0) during the split into
`@wiillownet/fastled-math` / `@wiillownet/wled-fx-sim`:

1. **Flag 1's sub-buckets were miscounted; flag 3 (fierce_ice) resolves to
   cpt-city.** The "16 WLED-authored `*_gp`" bucket does not exist as listed:
   all 16 of those palettes carry explicit cpt-city "originally from"
   provenance comments in `palettes.cpp` — WLED renamed them (15 are the
   `bhw1..bhw4` series by cpt-city author "blackheartedwolf"; `fierce_ice` is
   cpt-city `neota/elem/fierce-ice.c3g`). The corrected split of the baked
   table (ids 6-71, 66 palettes):
   - **7 FastLED → MIT** (ids 6-12, incl. the `_gc22` forms; moved to
     `@wiillownet/fastled-math`),
   - **47 cpt-city → third-party, per-palette, PENDING LEGAL CONSULT** (the
     original 31 plus the 16 renamed ones; full id/name/URL table in this
     package's THIRD-PARTY-LICENSES.md),
   - **12 WLED-authored → EUPL** (ids 44-53, 55, 71: Orange & Teal, Tiamat,
     April Night, Orangery, C9, Sakura, Aurora, Atlantica, C9 2, C9 New,
     Aurora 2, Traffic Light — declared `const byte` with "Custom palette by
     Aircoookie"-style comments and no cpt-city provenance; the earlier scan
     missed them because it only matched `const uint8_t` declarations).
   Routing consequence unchanged: the baked table stays effects-side; only
   ids 6-12 are MIT-clean and they now live in the math package.
2. **The `lib8.ts` split is done.** The MIT per-function subset (plus the
   trivial bit utilities and the 7 FastLED palettes) is physically in
   `packages/fastled-math/src/`; the WLED-original remainder stays here and
   re-exports the MIT surface. The math package imports zero EUPL code
   (enforced by CI).
