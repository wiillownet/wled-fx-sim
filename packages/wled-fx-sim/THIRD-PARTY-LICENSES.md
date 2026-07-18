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

## cpt-city gradient palettes — terms researched per collection, PENDING LEGAL CONSULT

> **Status (researched 2026-07-17 against the cpt-city archive's own
> per-collection `COPYING.yaml` records, archive v3.3.2, now hosted at
> https://phillips.shef.ac.uk/pub/cpt-city/).** The archive's general rule:
> "The gradients on cpt-city are copyrighted by their authors" and "If the
> author has not specified a licence then you do not have permission to
> distribute the gradients." Terms below are per-author. No license is
> asserted for this data here; groups B and D remain a legal-consult item.
> Mitigating context for all groups: this exact data has been redistributed
> for years by MIT-licensed FastLED and EUPL-licensed WLED, and a 16-stop
> color list is thin expression.

### Group A — CC-BY-3.0 (redistributable with attribution)

The `bhw` collection ("Art gradients by Blackheartedwolf", 2011) is
licensed **Creative Commons Attribution 3.0**
(http://creativecommons.org/licenses/by/3.0/). Redistribution is permitted
with attribution; WLED's friendly names below are renames of the original
`bhw*` gradients (attribution note: gradients by Blackheartedwolf, via
cpt-city, CC-BY-3.0; converted to 16-entry palettes).

| WLED id | WLED name | cpt-city gradient | collection | originally from |
| --- | --- | --- | --- | --- |
| 56 | Retro Clown | `bhw1_01_gp` | bhw | http://seaviewsensing.com/pub/cpt-city/bhw/bhw1/bhw1_01.c3g |
| 57 | Candy | `bhw1_04_gp` | bhw | http://seaviewsensing.com/pub/cpt-city/bhw/bhw1/bhw1_04.c3g |
| 58 | Toxy Reaf | `bhw1_05_gp` | bhw | http://seaviewsensing.com/pub/cpt-city/bhw/bhw1/bhw1_05.c3g |
| 59 | Fairy Reaf | `bhw1_06_gp` | bhw | http://seaviewsensing.com/pub/cpt-city/bhw/bhw1/bhw1_06.c3g |
| 60 | Semi Blue | `bhw1_14_gp` | bhw | http://seaviewsensing.com/pub/cpt-city/bhw/bhw1/bhw1_14.c3g |
| 61 | Pink Candy | `bhw1_three_gp` | bhw | http://seaviewsensing.com/pub/cpt-city/bhw/bhw1/bhw1_three.c3g |
| 62 | Red Reaf | `bhw1_w00t_gp` | bhw | http://seaviewsensing.com/pub/cpt-city/bhw/bhw1/bhw1_w00t.c3g |
| 63 | Aqua Flash | `bhw2_23_gp` | bhw | http://seaviewsensing.com/pub/cpt-city/bhw/bhw2/bhw2_23.c3g |
| 64 | Yelblu Hot | `bhw2_xc_gp` | bhw | http://seaviewsensing.com/pub/cpt-city/bhw/bhw2/bhw2_xc.c3g |
| 65 | Lite Light | `bhw2_45_gp` | bhw | http://seaviewsensing.com/pub/cpt-city/bhw/bhw2/bhw2_45.c3g |
| 66 | Red Flash | `bhw2_22_gp` | bhw | http://seaviewsensing.com/pub/cpt-city/bhw/bhw2/bhw2_22.c3g |
| 67 | Blink Red | `bhw3_40_gp` | bhw | http://seaviewsensing.com/pub/cpt-city/bhw/bhw3/bhw3_40.c3g |
| 68 | Red Shift | `bhw3_52_gp` | bhw | http://seaviewsensing.com/pub/cpt-city/bhw/bhw3/bhw3_52.c3g |
| 69 | Red Tide | `bhw4_097_gp` | bhw | http://seaviewsensing.com/pub/cpt-city/bhw/bhw4/bhw4_097.c3g |
| 70 | Candy2 | `bhw4_017_gp` | bhw | http://seaviewsensing.com/pub/cpt-city/bhw/bhw4/bhw4_017.c3g |

### Group B — GPL-family (copyleft; compatibility with this package's EUPL-1.2 UNRESOLVED)

`nd` (Nevit Dilmen, 2007): the author's statement reads "Permission is
granted to copy, distribute and/or modify this package under the terms of
the GNU Free License, Version 1.2 or any later version published by the
Free Software Foundation" — the archive files this informally as "GPL", but
the quoted text matches GFDL 1.2 wording; which license applies is itself
ambiguous. `gmt` (Generic Mapping Tools palettes, Wessel/Smith/Trawoeger):
**GPLv2**. Copyleft data inside an EUPL-1.2 package is the open question:
EUPL Art. 5 lists GPL-2.0/3.0 as compatible *downstream* licences, but the
required direction here (GPL-licensed data carried *inside* an EUPL work)
is exactly what the legal consult must answer.

| WLED id | WLED name | cpt-city gradient | collection | originally from |
| --- | --- | --- | --- | --- |
| 13 | Sunset | `Sunset_Real_gp` | nd | http://seaviewsensing.com/pub/cpt-city/nd/atmospheric/Sunset_Real.c3g |
| 18 | Analogous | `Analogous_1_gp` | nd | http://seaviewsensing.com/pub/cpt-city/nd/red/Analogous_1.c3g |
| 20 | Pastel | `Sunset_Yellow_gp` | nd | http://seaviewsensing.com/pub/cpt-city/nd/atmospheric/Sunset_Yellow.c3g |
| 21 | Sunset2 | `Another_Sunset_gp` | nd | http://seaviewsensing.com/pub/cpt-city/nd/atmospheric/Another_Sunset.c3g |
| 22 | Beech | `Beech_gp` | nd | http://seaviewsensing.com/pub/cpt-city/nd/atmospheric/Beech.c3g |
| 30 | Drywet | `GMT_drywet_gp` | gmt | http://seaviewsensing.com/pub/cpt-city/gmt/GMT_drywet.c3g |
| 34 | Tertiary | `Tertiary_01_gp` | nd | http://seaviewsensing.com/pub/cpt-city/nd/vermillion/Tertiary_01.c3g |
| 37 | Cyane | `Colorfull_gp` | nd | http://seaviewsensing.com/pub/cpt-city/nd/atmospheric/Colorfull.c3g |
| 38 | Light Pink | `Pink_Purple_gp` | nd | http://seaviewsensing.com/pub/cpt-city/nd/atmospheric/Pink_Purple.c3g |
| 40 | Magenta | `BlacK_Blue_Magenta_White_gp` | nd | http://seaviewsensing.com/pub/cpt-city/nd/basic/BlacK_Blue_Magenta_White.c3g |
| 41 | Magred | `BlacK_Magenta_Red_gp` | nd | http://seaviewsensing.com/pub/cpt-city/nd/basic/BlacK_Magenta_Red.c3g |
| 42 | Yelmag | `BlacK_Red_Magenta_Yellow_gp` | nd | http://seaviewsensing.com/pub/cpt-city/nd/basic/BlacK_Red_Magenta_Yellow.c3g |
| 43 | Yelblu | `Blue_Cyan_Yellow_gp` | nd | http://seaviewsensing.com/pub/cpt-city/nd/basic/Blue_Cyan_Yellow.c3g |

### Group C — informal grant, credit required (redistributable per author statement)

`es` (ElvenSword, 2008): "My resources are free for personal or
commercial arts works" and "okay distributing my resources with credit,
for good, for free" — distribution explicitly permitted with credit, via an
informal DeviantArt statement, author-approved for cpt-city inclusion in
2009. `arendal` (GRID-Arendal): "Using this graphic and referring to it is
encouraged ... please include the link to this page and give the
cartographer/designer credit." Informal but affirmative grants; ship with
credit lines.

| WLED id | WLED name | cpt-city gradient | collection | originally from |
| --- | --- | --- | --- | --- |
| 14 | Rivendell | `es_rivendell_15_gp` | es | http://seaviewsensing.com/pub/cpt-city/es/rivendell/es_rivendell_15.c3g |
| 15 | Breeze | `es_ocean_breeze_036_gp` | es | http://seaviewsensing.com/pub/cpt-city/es/ocean_breeze/es_ocean_breeze_036.c3g |
| 19 | Splash | `es_pinksplash_08_gp` | es | http://seaviewsensing.com/pub/cpt-city/es/pink_splash/es_pinksplash_08.c3g |
| 23 | Vintage | `es_vintage_01_gp` | es | http://seaviewsensing.com/pub/cpt-city/es/vintage/es_vintage_01.c3g |
| 25 | Landscape | `es_landscape_64_gp` | es | http://seaviewsensing.com/pub/cpt-city/es/landscape/es_landscape_64.c3g |
| 26 | Beach | `es_landscape_33_gp` | es | http://seaviewsensing.com/pub/cpt-city/es/landscape/es_landscape_33.c3g |
| 32 | Grintage | `es_vintage_57_gp` | es | http://seaviewsensing.com/pub/cpt-city/es/vintage/es_vintage_57.c3g |
| 39 | Autumn | `es_autumn_19_gp` | es | http://seaviewsensing.com/pub/cpt-city/es/autumn/es_autumn_19.c3g |
| 54 | Temperature | `temperature_gp` | arendal | http://seaviewsensing.com/pub/cpt-city/arendal/temperature.c3g |

### Group D — "free to use" only, NO explicit distribution grant (highest-risk group)

`ds` (Diane Simoni), `hult` (Hult), `ing` (Ingerlise), `ma` (Michele
Albert), `mjf` (Mark J. Fenbers), `neota` (David Gowers): each collection's
record says only "Free to use" (ds adds "link requested"), with no
statement about redistribution. Under the archive's own default rule,
distribution permission is NOT established for these 10 palettes. Options
if the consult can't clear them: drop them from the baked table (the
effects still run; the palette ids fall back) or seek per-author
permission.

| WLED id | WLED name | cpt-city gradient | collection | originally from |
| --- | --- | --- | --- | --- |
| 16 | Red & Blue | `rgi_15_gp` | ds | http://seaviewsensing.com/pub/cpt-city/ds/rgi/rgi_15.c3g |
| 17 | Yellowout | `retro2_16_gp` | ma | http://seaviewsensing.com/pub/cpt-city/ma/retro2/retro2_16.c3g |
| 24 | Departure | `departure_gp` | mjf | http://seaviewsensing.com/pub/cpt-city/mjf/departure.c3g |
| 27 | Sherbet | `rainbowsherbet_gp` | ma | http://seaviewsensing.com/pub/cpt-city/ma/icecream/rainbowsherbet.c3g |
| 28 | Hult | `gr65_hult_gp` | hult | http://seaviewsensing.com/pub/cpt-city/hult/gr65_hult.c3g |
| 29 | Hult64 | `gr64_hult_gp` | hult | http://seaviewsensing.com/pub/cpt-city/hult/gr64_hult.c3g |
| 31 | Jul | `ib_jul01_gp` | ing | http://seaviewsensing.com/pub/cpt-city/ing/xmas/ib_jul01.c3g |
| 33 | Rewhi | `ib15_gp` | ing | http://seaviewsensing.com/pub/cpt-city/ing/general/ib15.c3g |
| 35 | Fire | `lava_gp` | neota | http://seaviewsensing.com/pub/cpt-city/neota/elem/lava.c3g |
| 36 | Icefire | `fierce-ice_gp` | neota | http://seaviewsensing.com/pub/cpt-city/neota/elem/fierce-ice.c3g |

The 12 remaining gradient palettes (WLED ids 44-53, 55, 71: Orange & Teal,
Tiamat, April Night, Orangery, C9, Sakura, Aurora, Atlantica, C9 2, C9 New,
Aurora 2, Traffic Light) carry no cpt-city provenance and are WLED-authored
("Custom palette by Aircoookie" et al.) — they are covered by the WLED
EUPL-1.2 section above, not by this cpt-city section.
