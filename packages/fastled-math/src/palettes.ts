/**
 * FastLED's named 16-entry palettes, as WLED v16.0.0 ships them
 * (wled00/palettes.cpp "FastLED Palettes" section: "Palettes imported from
 * FastLED @ 3.6.0 ... are licensed under the MIT license").
 *
 * Party / Rainbow / RainbowStripe are WLED's `_gc22` forms: the original
 * FastLED values with an inverse gamma of 2.2 pre-applied ("corrected with
 * inverse gamma of 2.2 to match original looks") -- a mechanical transform of
 * the MIT data, kept because it is what WLED palette ids 6-12 actually load.
 */
import type { RGB } from './lib8.js';

/** WLED palette id 6 -- FastLED PartyColors (WLED PartyColors_gc22). */
export const PartyColors: RGB[] = [
  [155, 0, 213],
  [189, 0, 184],
  [218, 0, 146],
  [243, 0, 92],
  [244, 85, 0],
  [220, 143, 0],
  [213, 180, 0],
  [213, 213, 0],
  [213, 155, 0],
  [239, 102, 0],
  [249, 0, 68],
  [225, 0, 134],
  [196, 0, 176],
  [163, 0, 207],
  [118, 0, 232],
  [0, 50, 252],
];

/** WLED palette id 7 -- FastLED CloudColors_p. */
export const CloudColors: RGB[] = [
  [0, 0, 255],
  [0, 0, 139],
  [0, 0, 139],
  [0, 0, 139],
  [0, 0, 139],
  [0, 0, 139],
  [0, 0, 139],
  [0, 0, 139],
  [0, 0, 255],
  [0, 0, 139],
  [135, 206, 235],
  [135, 206, 235],
  [173, 216, 230],
  [255, 255, 255],
  [173, 216, 230],
  [135, 206, 235],
];

/** WLED palette id 8 -- FastLED LavaColors_p. */
export const LavaColors: RGB[] = [
  [0, 0, 0],
  [128, 0, 0],
  [0, 0, 0],
  [128, 0, 0],
  [139, 0, 0],
  [139, 0, 0],
  [128, 0, 0],
  [139, 0, 0],
  [139, 0, 0],
  [139, 0, 0],
  [255, 0, 0],
  [255, 165, 0],
  [255, 255, 255],
  [255, 165, 0],
  [255, 0, 0],
  [139, 0, 0],
];

/** WLED palette id 9 -- FastLED OceanColors_p. */
export const OceanColors: RGB[] = [
  [25, 25, 112],
  [0, 0, 139],
  [25, 25, 112],
  [0, 0, 128],
  [0, 0, 139],
  [0, 0, 205],
  [46, 139, 87],
  [0, 128, 128],
  [95, 158, 160],
  [0, 0, 255],
  [0, 139, 139],
  [100, 149, 237],
  [127, 255, 212],
  [46, 139, 87],
  [0, 255, 255],
  [135, 206, 250],
];

/** WLED palette id 10 -- FastLED ForestColors_p. */
export const ForestColors: RGB[] = [
  [0, 100, 0],
  [0, 100, 0],
  [85, 107, 47],
  [0, 100, 0],
  [0, 128, 0],
  [34, 139, 34],
  [107, 142, 35],
  [0, 128, 0],
  [46, 139, 87],
  [102, 205, 170],
  [50, 205, 50],
  [154, 205, 50],
  [144, 238, 144],
  [124, 252, 0],
  [102, 205, 170],
  [34, 139, 34],
];

/** WLED palette id 11 -- FastLED RainbowColors (WLED RainbowColors_gc22). */
export const RainbowColors: RGB[] = [
  [255, 0, 0],
  [235, 112, 0],
  [213, 155, 0],
  [213, 186, 0],
  [213, 213, 0],
  [156, 235, 0],
  [0, 255, 0],
  [0, 235, 112],
  [0, 213, 155],
  [0, 156, 212],
  [0, 0, 255],
  [112, 0, 235],
  [155, 0, 213],
  [186, 0, 187],
  [213, 0, 155],
  [235, 0, 114],
];

/** WLED palette id 12 -- FastLED RainbowStripeColors (WLED RainbowStripeColors_gc22). */
export const RainbowStripeColors: RGB[] = [
  [255, 0, 0],
  [0, 0, 0],
  [213, 155, 0],
  [0, 0, 0],
  [213, 213, 0],
  [0, 0, 0],
  [0, 255, 0],
  [0, 0, 0],
  [0, 213, 155],
  [0, 0, 0],
  [0, 0, 255],
  [0, 0, 0],
  [155, 0, 213],
  [0, 0, 0],
  [213, 0, 155],
  [0, 0, 0],
];

/** The 7 FastLED palettes keyed by their WLED palette id (6-12). */
export const FASTLED_PALETTES: Record<number, RGB[]> = {
  6: PartyColors,
  7: CloudColors,
  8: LavaColors,
  9: OceanColors,
  10: ForestColors,
  11: RainbowColors,
  12: RainbowStripeColors,
};
