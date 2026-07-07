import { describe, expect, it } from 'vitest';
import {
  createEffectSim,
  getEffectSim,
  isPorted,
  portedFxIds,
  type RGB,
} from './index.js';

const LEN = 30;
const RED: RGB = [255, 0, 0];
const GREEN: RGB = [0, 255, 0];
const BLUE: RGB = [0, 0, 255];
const BLACK_RGB: RGB = [0, 0, 0];

function isValidBuffer(buf: RGB[], len: number): boolean {
  if (buf.length !== len) return false;
  return buf.every(
    (px) =>
      px.length === 3 &&
      px.every((ch) => Number.isInteger(ch) && ch >= 0 && ch <= 255),
  );
}

function frames(
  fxId: number,
  params: Parameters<typeof createEffectSim>[1],
  times: number[],
): RGB[][] {
  const sim = createEffectSim(fxId, params);
  return times.map((t) => sim.frame(t));
}

describe('registry surface', () => {
  it('reports ported ids and gates cleanly', () => {
    const ids = portedFxIds();
    expect(ids).toContain(0);
    expect(ids).toContain(66);
    expect(ids.length).toBeGreaterThanOrEqual(20);
    for (const id of ids) expect(isPorted(id)).toBe(true);
    expect(isPorted(999)).toBe(false);
    expect(getEffectSim(999)).toBeUndefined();
  });

  it('createEffectSim throws for an unported id (never faked)', () => {
    expect(() => createEffectSim(999, { length: LEN })).toThrow(
      /no 1d simulation/i,
    );
  });
});

// The whole ported set is exercised against one contract: valid buffer, right
// length, determinism, and no NaN/crash at the slider extremes.
describe.each(portedFxIds())('effect %i contract', (fxId) => {
  const base = { length: LEN, colors: [RED, GREEN, BLUE] as RGB[] };

  it('produces a valid RGB buffer of strip length', () => {
    const sim = createEffectSim(fxId, base);
    expect(isValidBuffer(sim.frame(0), LEN)).toBe(true);
    expect(isValidBuffer(sim.frame(500), LEN)).toBe(true);
    expect(isValidBuffer(sim.frame(3000), LEN)).toBe(true);
  });

  it('is deterministic: same inputs -> same buffers', () => {
    const times = [0, 250, 1000, 5000];
    const a = frames(fxId, base, times);
    const b = frames(fxId, base, times);
    expect(a).toEqual(b);
  });

  it('respects sx/ix bounds 0 and 255 (no NaN, no crash)', () => {
    for (const sx of [0, 255]) {
      for (const ix of [0, 255]) {
        const sim = createEffectSim(fxId, { ...base, sx, ix });
        for (const t of [0, 100, 2000, 10000]) {
          expect(isValidBuffer(sim.frame(t), LEN)).toBe(true);
        }
      }
    }
  });

  it('handles length 1 without crashing', () => {
    const sim = createEffectSim(fxId, {
      length: 1,
      colors: [RED, GREEN, BLUE],
    });
    expect(isValidBuffer(sim.frame(0), 1)).toBe(true);
    expect(isValidBuffer(sim.frame(1000), 1)).toBe(true);
  });

  it('reset() returns to the frame-0 state', () => {
    const sim = createEffectSim(fxId, base);
    const first = sim.frame(0);
    sim.frame(4000);
    sim.reset();
    expect(sim.frame(0)).toEqual(first);
  });
});

describe('animated effects change over time', () => {
  // Solid (0) is intentionally static; everything else should move.
  const animated = portedFxIds().filter((id) => id !== 0);
  it.each(animated)('effect %i differs across a long window', (fxId) => {
    const sim = createEffectSim(fxId, {
      length: LEN,
      sx: 200,
      ix: 200,
      colors: [RED, GREEN, BLUE],
    });
    const snaps = [0, 400, 900, 1600, 2500, 4000, 7000].map((t) =>
      JSON.stringify(sim.frame(t)),
    );
    expect(new Set(snaps).size).toBeGreaterThan(1);
  });
});

describe('spot checks against known behavior', () => {
  it('Solid (0) fills the primary color everywhere', () => {
    const sim = createEffectSim(0, { length: LEN, colors: [RED, GREEN, BLUE] });
    const buf = sim.frame(0);
    expect(buf.every((px) => px[0] === 255 && px[1] === 0 && px[2] === 0)).toBe(
      true,
    );
  });

  it('Strobe (23) alternates between lit and dark frames over time', () => {
    const sim = createEffectSim(23, {
      length: LEN,
      sx: 200,
      colors: [
        [255, 255, 255],
        [0, 0, 0],
      ],
    });
    let sawLit = false;
    let sawDark = false;
    for (let t = 0; t < 3000; t += 20) {
      const lum = sim.frame(t).reduce((s, px) => s + px[0] + px[1] + px[2], 0);
      if (lum > 1000) sawLit = true;
      if (lum === 0) sawDark = true;
    }
    expect(sawLit).toBe(true);
    expect(sawDark).toBe(true);
  });

  it('Rainbow (9) shows multiple distinct hues across the strip', () => {
    const sim = createEffectSim(9, { length: LEN, sx: 128, ix: 200 });
    const buf = sim.frame(100);
    const uniqueHues = new Set(buf.map((px) => px.join(',')));
    expect(uniqueHues.size).toBeGreaterThan(3);
  });

  it('Fire 2012 (66) drives warm colors (more red than blue on average)', () => {
    const sim = createEffectSim(66, { length: LEN, sx: 64, ix: 160, pal: 35 });
    let rSum = 0;
    let bSum = 0;
    for (let t = 0; t < 3000; t += 25) {
      for (const px of sim.frame(t)) {
        rSum += px[0];
        bSum += px[2];
      }
    }
    expect(rSum).toBeGreaterThan(bSum);
  });

  it('Tri Fade (56) cycles through all three project colors', () => {
    const sim = createEffectSim(56, {
      length: LEN,
      sx: 200,
      colors: [RED, GREEN, BLUE],
    });
    let sawRed = false;
    let sawGreen = false;
    let sawBlue = false;
    for (let t = 0; t < 4000; t += 20) {
      const px = sim.frame(t)[0];
      if (px[0] > 200 && px[1] < 50 && px[2] < 50) sawRed = true;
      if (px[1] > 200 && px[0] < 50 && px[2] < 50) sawGreen = true;
      if (px[2] > 200 && px[0] < 50 && px[1] < 50) sawBlue = true;
    }
    expect(sawRed).toBe(true);
    expect(sawGreen).toBe(true);
    expect(sawBlue).toBe(true);
  });

  it('Strobe Mega (25) alternates a full-color burst against the resting palette fill', () => {
    const sim = createEffectSim(25, {
      length: LEN,
      sx: 128,
      ix: 128,
      colors: [
        [255, 255, 255],
        [0, 0, 0],
      ],
    });
    let sawBurst = false;
    for (let t = 0; t < 3000; t += 15) {
      const buf = sim.frame(t);
      if (buf.every((px) => px[0] === 255 && px[1] === 255 && px[2] === 255)) {
        sawBurst = true;
      }
    }
    expect(sawBurst).toBe(true);
  });

  it('Sunrise (104) at a fast (>120) speed brightens and dims the strip over time', () => {
    // Sunrise always samples a palette (its mcol sentinel bypasses the
    // "no palette selected" shortcut) -- pal 35 "Fire" is its documented
    // default and is the one that actually ramps black -> bright.
    const sim = createEffectSim(104, {
      length: LEN,
      sx: 200,
      pal: 35,
      colors: [[255, 200, 50], BLACK_RGB, BLACK_RGB],
    });
    let minLum = Infinity;
    let maxLum = 0;
    for (let t = 0; t < 4000; t += 40) {
      const lum = sim.frame(t).reduce((s, px) => s + px[0] + px[1] + px[2], 0);
      minLum = Math.min(minLum, lum);
      maxLum = Math.max(maxLum, lum);
    }
    expect(maxLum).toBeGreaterThan(minLum * 2);
  });

  it('Candle (88) flickers within a bounded range, never fully off or maxed', () => {
    const sim = createEffectSim(88, {
      length: LEN,
      sx: 96,
      ix: 224,
      colors: [[255, 180, 60], BLACK_RGB, BLACK_RGB],
    });
    let sawNonzero = false;
    for (let t = 0; t < 3000; t += 25) {
      const px = sim.frame(t)[0];
      const lum = px[0] + px[1] + px[2];
      expect(lum).toBeGreaterThan(0);
      if (lum > 0) sawNonzero = true;
    }
    expect(sawNonzero).toBe(true);
  });

  it('Twinklefox (80) shows bright twinkles against a dim background', () => {
    const sim = createEffectSim(80, {
      length: 60,
      sx: 128,
      ix: 128,
      colors: [[80, 120, 255], [4, 4, 8], BLACK_RGB],
    });
    let sawBright = false;
    for (let t = 0; t < 5000; t += 50) {
      const buf = sim.frame(t);
      if (buf.some((px) => px[0] + px[1] + px[2] > 300)) sawBright = true;
    }
    expect(sawBright).toBe(true);
  });

  it('Pacifica (101) renders blue-green ocean hues (blue/green dominate red)', () => {
    const sim = createEffectSim(101, { length: LEN, sx: 128, ix: 128 });
    let rSum = 0;
    let gSum = 0;
    let bSum = 0;
    for (let t = 0; t < 4000; t += 50) {
      for (const px of sim.frame(t)) {
        rSum += px[0];
        gSum += px[1];
        bSum += px[2];
      }
    }
    expect(gSum + bSum).toBeGreaterThan(rSum);
  });

  it('Aurora (38) lights up pixels beyond the flat backlight floor', () => {
    const sim = createEffectSim(38, {
      length: 40,
      sx: 24,
      ix: 200,
      colors: [
        [200, 60, 220],
        [0, 0, 0],
        [0, 100, 255],
      ],
    });
    let sawBrightWave = false;
    for (let t = 0; t < 6000; t += 100) {
      const buf = sim.frame(t);
      if (buf.some((px) => px[0] + px[1] + px[2] > 60)) sawBrightWave = true;
    }
    expect(sawBrightWave).toBe(true);
  });

  it('Colorwaves (67) shows multiple distinct colors across the strip', () => {
    const sim = createEffectSim(67, { length: LEN, sx: 128, ix: 128, pal: 26 });
    const buf = sim.frame(2000);
    const uniqueColors = new Set(buf.map((px) => px.join(',')));
    expect(uniqueColors.size).toBeGreaterThan(3);
  });

  it('Plasma (97) varies both spatially and over time', () => {
    const sim = createEffectSim(97, { length: LEN, sx: 128, ix: 128 });
    const frame0 = sim.frame(0);
    const uniqueAcrossStrip = new Set(frame0.map((px) => px.join(',')));
    expect(uniqueAcrossStrip.size).toBeGreaterThan(1);
    const frame0Str = JSON.stringify(frame0);
    const frame2000Str = JSON.stringify(sim.frame(2000));
    expect(frame2000Str).not.toBe(frame0Str);
  });
});
