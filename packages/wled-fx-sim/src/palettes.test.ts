import { describe, expect, it } from 'vitest';
import { pack } from './lib8.js';
import { FIXED_PALETTES } from './palette-data.generated.js';
import { hasPaletteData, loadPalette } from './palettes.js';

const RED = pack([255, 0, 0]);
const GREEN = pack([0, 255, 0]);
const BLUE = pack([0, 0, 255]);

describe('FIXED_PALETTES table', () => {
  it('covers the 66 fixed palettes (ids 6-71), 16 valid RGB entries each', () => {
    const ids = Object.keys(FIXED_PALETTES).map(Number);
    expect(ids.length).toBe(66);
    expect(Math.min(...ids)).toBe(6);
    expect(Math.max(...ids)).toBe(71);
    for (const id of ids) {
      const pal = FIXED_PALETTES[id];
      expect(pal).toHaveLength(16);
      for (const [r, g, b] of pal) {
        for (const ch of [r, g, b]) {
          expect(Number.isInteger(ch)).toBe(true);
          expect(ch).toBeGreaterThanOrEqual(0);
          expect(ch).toBeLessThanOrEqual(255);
        }
      }
    }
  });
});

describe('loadPalette (dynamic 0-5)', () => {
  it('palette 2 is the primary color, solid', () => {
    const pal = loadPalette(2, RED, GREEN, BLUE);
    expect(pal.every((e) => e[0] === 255 && e[1] === 0 && e[2] === 0)).toBe(
      true,
    );
  });

  it('palette 4 spans all three colors', () => {
    const pal = loadPalette(4, RED, GREEN, BLUE);
    const flat = pal.map((e) => e.join(','));
    // tertiary(blue) at the start, secondary(green) mid, primary(red) later
    expect(flat[0]).toBe('0,0,255');
    expect(pal.some((e) => e[1] > 200)).toBe(true); // green present
    expect(pal.some((e) => e[0] > 200)).toBe(true); // red present
  });

  it('palettes 0 and 1 fall back to the default (Party) table', () => {
    expect(loadPalette(0, RED, GREEN, BLUE)).toBe(FIXED_PALETTES[6]);
    expect(loadPalette(1, RED, GREEN, BLUE)).toBe(FIXED_PALETTES[6]);
  });

  it('fixed ids pass through; unknown ids fall back to default', () => {
    expect(loadPalette(35, RED, GREEN, BLUE)).toBe(FIXED_PALETTES[35]);
    expect(loadPalette(500, RED, GREEN, BLUE)).toBe(FIXED_PALETTES[6]);
  });
});

describe('hasPaletteData', () => {
  it('true for 0-71, false for custom/usermod ids', () => {
    expect(hasPaletteData(0)).toBe(true);
    expect(hasPaletteData(35)).toBe(true);
    expect(hasPaletteData(71)).toBe(true);
    expect(hasPaletteData(100)).toBe(false);
  });
});
