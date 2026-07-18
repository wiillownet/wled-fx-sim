# Third-party licenses

This package is a TypeScript port; it redistributes no upstream source files,
but its algorithms and palette data derive from the following works. All ports
are against WLED tag v16.0.0 (commit 4374f01).

## WLED (EUPL-1.2)

The effect implementations (`effects.ts`), segment/engine layer (`segment.ts`,
`segment-2d.ts`, `palettes.ts`), particle systems (`particles-1d.ts`,
`particles-2d.ts`), and the WLED-original math in `lib8.ts` (integer trig,
beat/beatsin, color ops, gamma, spectrum HSV, PRNG, gradient noise) are ported
from WLED (https://github.com/wled-dev/WLED):

    Copyright (c) 2016-present Christian Schwinne and individual WLED
    contributors
    Licensed under the EUPL v. 1.2 or later

The full EUPL-1.2 text is this package's LICENSE file.

## FastLED (MIT)

Some WLED-derived code in this package is itself derived from FastLED 3.6.0
(https://github.com/FastLED/FastLED, MIT, Copyright (c) 2013 FastLED) via
WLED's bundled `fastled_slim`. The cleanly separable FastLED-derived subset
lives in the companion package `@wiillownet/fastled-math`; see that package's
THIRD-PARTY-LICENSES.md for the full MIT text.

## cpt-city gradient palettes — PENDING LEGAL CONSULT

> **PENDING LEGAL CONSULT.** The 47 baked gradient palettes below originate
> from the cpt-city archive (http://seaviewsensing.com/pub/cpt-city/).
> cpt-city hosts community gradient data under varied per-author terms
> (public domain / Creative Commons / Apache and others). They are
> redistributed by both MIT-licensed FastLED and EUPL-licensed WLED, which is
> a strong signal they are freely redistributable, but their exact license
> and required attribution have not been confirmed per palette. No license is
> asserted for this data here. Do not treat this section as a grant; it is a
> provenance record awaiting per-palette confirmation.

Each palette below is baked into `palette-data.generated.ts` (expanded to a
16-entry palette) under its WLED palette id. "Originally from" URLs are
reproduced from WLED's `wled00/palettes.cpp` provenance comments. WLED renamed
16 of these (e.g. the `bhw*` series by "blackheartedwolf", and `fierce-ice`);
the original cpt-city gradient name is kept in the third column.

| WLED id | WLED name | cpt-city gradient | originally from |
| --- | --- | --- | --- |
| 13 | Sunset | `Sunset_Real_gp` | http://seaviewsensing.com/pub/cpt-city/nd/atmospheric/Sunset_Real.c3g |
| 14 | Rivendell | `es_rivendell_15_gp` | http://seaviewsensing.com/pub/cpt-city/es/rivendell/es_rivendell_15.c3g |
| 15 | Breeze | `es_ocean_breeze_036_gp` | http://seaviewsensing.com/pub/cpt-city/es/ocean_breeze/es_ocean_breeze_036.c3g |
| 16 | Red & Blue | `rgi_15_gp` | http://seaviewsensing.com/pub/cpt-city/ds/rgi/rgi_15.c3g |
| 17 | Yellowout | `retro2_16_gp` | http://seaviewsensing.com/pub/cpt-city/ma/retro2/retro2_16.c3g |
| 18 | Analogous | `Analogous_1_gp` | http://seaviewsensing.com/pub/cpt-city/nd/red/Analogous_1.c3g |
| 19 | Splash | `es_pinksplash_08_gp` | http://seaviewsensing.com/pub/cpt-city/es/pink_splash/es_pinksplash_08.c3g |
| 20 | Pastel | `Sunset_Yellow_gp` | http://seaviewsensing.com/pub/cpt-city/nd/atmospheric/Sunset_Yellow.c3g |
| 21 | Sunset2 | `Another_Sunset_gp` | http://seaviewsensing.com/pub/cpt-city/nd/atmospheric/Another_Sunset.c3g |
| 22 | Beech | `Beech_gp` | http://seaviewsensing.com/pub/cpt-city/nd/atmospheric/Beech.c3g |
| 23 | Vintage | `es_vintage_01_gp` | http://seaviewsensing.com/pub/cpt-city/es/vintage/es_vintage_01.c3g |
| 24 | Departure | `departure_gp` | http://seaviewsensing.com/pub/cpt-city/mjf/departure.c3g |
| 25 | Landscape | `es_landscape_64_gp` | http://seaviewsensing.com/pub/cpt-city/es/landscape/es_landscape_64.c3g |
| 26 | Beach | `es_landscape_33_gp` | http://seaviewsensing.com/pub/cpt-city/es/landscape/es_landscape_33.c3g |
| 27 | Sherbet | `rainbowsherbet_gp` | http://seaviewsensing.com/pub/cpt-city/ma/icecream/rainbowsherbet.c3g |
| 28 | Hult | `gr65_hult_gp` | http://seaviewsensing.com/pub/cpt-city/hult/gr65_hult.c3g |
| 29 | Hult64 | `gr64_hult_gp` | http://seaviewsensing.com/pub/cpt-city/hult/gr64_hult.c3g |
| 30 | Drywet | `GMT_drywet_gp` | http://seaviewsensing.com/pub/cpt-city/gmt/GMT_drywet.c3g |
| 31 | Jul | `ib_jul01_gp` | http://seaviewsensing.com/pub/cpt-city/ing/xmas/ib_jul01.c3g |
| 32 | Grintage | `es_vintage_57_gp` | http://seaviewsensing.com/pub/cpt-city/es/vintage/es_vintage_57.c3g |
| 33 | Rewhi | `ib15_gp` | http://seaviewsensing.com/pub/cpt-city/ing/general/ib15.c3g |
| 34 | Tertiary | `Tertiary_01_gp` | http://seaviewsensing.com/pub/cpt-city/nd/vermillion/Tertiary_01.c3g |
| 35 | Fire | `lava_gp` | http://seaviewsensing.com/pub/cpt-city/neota/elem/lava.c3g |
| 36 | Icefire | `fierce-ice_gp` | http://seaviewsensing.com/pub/cpt-city/neota/elem/fierce-ice.c3g |
| 37 | Cyane | `Colorfull_gp` | http://seaviewsensing.com/pub/cpt-city/nd/atmospheric/Colorfull.c3g |
| 38 | Light Pink | `Pink_Purple_gp` | http://seaviewsensing.com/pub/cpt-city/nd/atmospheric/Pink_Purple.c3g |
| 39 | Autumn | `es_autumn_19_gp` | http://seaviewsensing.com/pub/cpt-city/es/autumn/es_autumn_19.c3g |
| 40 | Magenta | `BlacK_Blue_Magenta_White_gp` | http://seaviewsensing.com/pub/cpt-city/nd/basic/BlacK_Blue_Magenta_White.c3g |
| 41 | Magred | `BlacK_Magenta_Red_gp` | http://seaviewsensing.com/pub/cpt-city/nd/basic/BlacK_Magenta_Red.c3g |
| 42 | Yelmag | `BlacK_Red_Magenta_Yellow_gp` | http://seaviewsensing.com/pub/cpt-city/nd/basic/BlacK_Red_Magenta_Yellow.c3g |
| 43 | Yelblu | `Blue_Cyan_Yellow_gp` | http://seaviewsensing.com/pub/cpt-city/nd/basic/Blue_Cyan_Yellow.c3g |
| 54 | Temperature | `temperature_gp` | http://seaviewsensing.com/pub/cpt-city/arendal/temperature.c3g |
| 56 | Retro Clown | `bhw1_01_gp` | http://seaviewsensing.com/pub/cpt-city/bhw/bhw1/bhw1_01.c3g |
| 57 | Candy | `bhw1_04_gp` | http://seaviewsensing.com/pub/cpt-city/bhw/bhw1/bhw1_04.c3g |
| 58 | Toxy Reaf | `bhw1_05_gp` | http://seaviewsensing.com/pub/cpt-city/bhw/bhw1/bhw1_05.c3g |
| 59 | Fairy Reaf | `bhw1_06_gp` | http://seaviewsensing.com/pub/cpt-city/bhw/bhw1/bhw1_06.c3g |
| 60 | Semi Blue | `bhw1_14_gp` | http://seaviewsensing.com/pub/cpt-city/bhw/bhw1/bhw1_14.c3g |
| 61 | Pink Candy | `bhw1_three_gp` | http://seaviewsensing.com/pub/cpt-city/bhw/bhw1/bhw1_three.c3g |
| 62 | Red Reaf | `bhw1_w00t_gp` | http://seaviewsensing.com/pub/cpt-city/bhw/bhw1/bhw1_w00t.c3g |
| 63 | Aqua Flash | `bhw2_23_gp` | http://seaviewsensing.com/pub/cpt-city/bhw/bhw2/bhw2_23.c3g |
| 64 | Yelblu Hot | `bhw2_xc_gp` | http://seaviewsensing.com/pub/cpt-city/bhw/bhw2/bhw2_xc.c3g |
| 65 | Lite Light | `bhw2_45_gp` | http://seaviewsensing.com/pub/cpt-city/bhw/bhw2/bhw2_45.c3g |
| 66 | Red Flash | `bhw2_22_gp` | http://seaviewsensing.com/pub/cpt-city/bhw/bhw2/bhw2_22.c3g |
| 67 | Blink Red | `bhw3_40_gp` | http://seaviewsensing.com/pub/cpt-city/bhw/bhw3/bhw3_40.c3g |
| 68 | Red Shift | `bhw3_52_gp` | http://seaviewsensing.com/pub/cpt-city/bhw/bhw3/bhw3_52.c3g |
| 69 | Red Tide | `bhw4_097_gp` | http://seaviewsensing.com/pub/cpt-city/bhw/bhw4/bhw4_097.c3g |
| 70 | Candy2 | `bhw4_017_gp` | http://seaviewsensing.com/pub/cpt-city/bhw/bhw4/bhw4_017.c3g |
The 12 remaining gradient palettes (WLED ids 44-53, 55, 71: Orange & Teal,
Tiamat, April Night, Orangery, C9, Sakura, Aurora, Atlantica, C9 2, C9 New,
Aurora 2, Traffic Light) carry no cpt-city provenance and are WLED-authored
("Custom palette by Aircoookie" et al.) — they are covered by the WLED
EUPL-1.2 section above, not by this cpt-city section.
