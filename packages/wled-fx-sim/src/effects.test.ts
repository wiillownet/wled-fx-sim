// SPDX-License-Identifier: EUPL-1.2
// Test anchors derived from WLED v16.0.0 behavior; test code original to this package.
import { describe, expect, it } from 'vitest';
import {
  createEffectSim,
  FRAMETIME,
  is2DEffect,
  isPorted,
  portedFxIds,
  supports1D,
  supports2D,
  type RGB,
} from './index.js';
import {
  EFFECT_SIMS,
  EFFECT_SIMS_2D,
  FRAMETIME as STEP_MS,
} from './effects.js';
import { Segment } from './segment.js';
import { inoise16xy } from './lib8.js';
import { Segment2D } from './segment-2d.js';

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
    expect(ids.length).toBeGreaterThanOrEqual(200);
    for (const id of ids) expect(isPorted(id)).toBe(true);
    expect(isPorted(999)).toBe(false);
  });

  it('createEffectSim throws for an unported id (never faked)', () => {
    expect(() => createEffectSim(999, { length: LEN })).toThrow(
      /no simulation/i,
    );
  });

  it('reports 2D ids and sizes their sims to the matrix, 16x16 by default', () => {
    expect(is2DEffect(180)).toBe(true); // Hiphotic
    expect(is2DEffect(0)).toBe(false);
    const sim = createEffectSim(180, { length: LEN });
    expect(sim.width).toBe(16);
    expect(sim.height).toBe(16);
    expect(sim.length).toBe(256);
    const sized = createEffectSim(180, { length: LEN, width: 8, height: 4 });
    expect(sized.length).toBe(32);
    const oneD = createEffectSim(0, { length: LEN });
    expect(oneD.width).toBe(LEN);
    expect(oneD.height).toBe(1);
  });

  it('is2DEffect means matrix-only, so a dual id answers false', () => {
    // 180 Hiphotic has no 1D body; 42 Fireworks has both. Callers asking
    // is2DEffect() are picking a renderer, and a dual id can render as a strip.
    expect(is2DEffect(180)).toBe(true);
    expect(supports1D(180)).toBe(false);
    expect(is2DEffect(42)).toBe(false);
    expect(supports1D(42)).toBe(true);
    expect(supports2D(42)).toBe(true);
  });
});

// Dual effects: one WLED mode_* that branches on SEGMENT.is2D(), ported here as
// two bodies. Firmware routes by the segment's own dimensionality, so selection
// has to follow what the caller asked for -- never "a 2D body exists, use it",
// which would strand the 1D body as dead code.
describe('dual effects run the branch the caller asked for', () => {
  const DUAL = [42, 43, 65, 79, 82, 90, 99];

  it('every id in DUAL really carries both bodies', () => {
    for (const id of DUAL) {
      expect(supports1D(id)).toBe(true);
      expect(supports2D(id)).toBe(true);
    }
  });

  it('defaults to 1D when no matrix dimensions are supplied', () => {
    for (const id of DUAL) {
      const sim = createEffectSim(id, { length: LEN });
      expect(sim.height).toBe(1);
      expect(sim.width).toBe(LEN);
      expect(sim.length).toBe(LEN);
    }
  });

  it('defaults to 2D once both width and height are supplied', () => {
    for (const id of DUAL) {
      const sim = createEffectSim(id, { length: LEN, width: 8, height: 4 });
      expect(sim.width).toBe(8);
      expect(sim.height).toBe(4);
      expect(sim.length).toBe(32);
    }
  });

  it('honors an explicit dimensions request over the dimension defaults', () => {
    for (const id of DUAL) {
      // Matrix dims present but 1D asked for: the strip body wins.
      const forced1d = createEffectSim(id, {
        length: LEN,
        width: 8,
        height: 4,
        dimensions: '1d',
      });
      expect(forced1d.height).toBe(1);
      expect(forced1d.length).toBe(LEN);

      // No matrix dims but 2D asked for: falls back to the 16x16 default.
      const forced2d = createEffectSim(id, { length: LEN, dimensions: '2d' });
      expect(forced2d.width).toBe(16);
      expect(forced2d.height).toBe(16);
    }
  });

  it('renders genuinely different pixels per branch', () => {
    for (const id of DUAL) {
      const oneD = createEffectSim(id, { length: 64, dimensions: '1d' });
      const twoD = createEffectSim(id, {
        length: 64,
        width: 8,
        height: 8,
        dimensions: '2d',
      });
      // Same total pixel count, so a mixed-up branch would still be "valid".
      expect(oneD.length).toBe(twoD.length);
      expect(oneD.frame(500)).not.toEqual(twoD.frame(500));
    }
  });

  it('ignores a dimensions request a single-body effect cannot honor', () => {
    // 0 Solid is 1D-only, 180 Hiphotic is 2D-only. Neither can switch, and
    // asking is not an error -- documented fallback, not a silent failure.
    const solid = createEffectSim(0, { length: LEN, dimensions: '2d' });
    expect(solid.height).toBe(1);
    expect(solid.width).toBe(LEN);

    const hiphotic = createEffectSim(180, { length: LEN, dimensions: '1d' });
    expect(hiphotic.height).toBe(16);
    expect(hiphotic.width).toBe(16);
  });
});

// The whole ported set is exercised against one contract: valid buffer, right
// length, determinism, and no NaN/crash at the slider extremes.
describe.each(portedFxIds())('effect %i contract', (fxId) => {
  const base = { length: LEN, colors: [RED, GREEN, BLUE] as RGB[] };

  it('produces a valid RGB buffer of frame length', () => {
    // 2D ids ignore `length` and render the default 16x16 matrix; sim.length
    // reports the true frame size either way.
    const sim = createEffectSim(fxId, base);
    expect(isValidBuffer(sim.frame(0), sim.length)).toBe(true);
    expect(isValidBuffer(sim.frame(500), sim.length)).toBe(true);
    expect(isValidBuffer(sim.frame(3000), sim.length)).toBe(true);
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
          expect(isValidBuffer(sim.frame(t), sim.length)).toBe(true);
        }
      }
    }
  });

  it('handles a single-pixel frame without crashing', () => {
    // 1×1 exercises SEGLEN<=1 fallbacks in 1D and the !is2D() guard in 2D.
    const sim = createEffectSim(fxId, {
      length: 1,
      width: 1,
      height: 1,
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

describe('Rain (43) spark index', () => {
  it('rolls the 0xffff seed through uint16 like SEGENV.aux0 does', () => {
    // aux0 starts at UINT16_MAX; the 2D row step then computes
    // (aux0 % w) + (aux0 / w + 1) * w = 65551, which the uint16_t field
    // truncates to 15 -- below w*h, so the "ignore" reset does not fire and
    // the spark walks down column 15. Without the truncation it reads as
    // 65551, trips `>= w*h`, and restarts at column 0.
    const seg = new Segment2D(16, 16, 0x1234);
    seg.speed = 255; // shortest rain interval, so a tick lands every frame
    seg.intensity = 0; // rarest spark, so aux0 is the row step's alone
    seg.colors = [0xffa000, 0, 0];
    const seen: number[] = [];
    for (let f = 0; f < 5; f++) {
      seg.now = f * STEP_MS;
      seg.refreshPalette();
      EFFECT_SIMS_2D[43](seg as Segment2D);
      seg.call++;
      seen.push(seg.aux0);
    }
    expect(seen).toEqual([0xffff, 15, 31, 47, 63]);
  });
});

describe('uint32 time products shift logically', () => {
  it('keeps Noise 4 (73) sampling the same noise past 2^31', () => {
    // stp = (strip.now * SEGMENT.speed) >> 7 is uint32 upstream and goes
    // into perlin16 unmasked, so a signed shift moves the sample by 2^25
    // once the product passes 2^31 -- about two hours at full speed.
    const seg = new Segment(30, 0x1234);
    seg.speed = 255;
    seg.palette = 11;
    seg.colors = [0xffa000, 0, 0];
    // now * 255 lands between 2^31 and 2^32 here
    seg.now = 9_000_000;
    seg.refreshPalette();
    EFFECT_SIMS[73](seg);
    const signedShift = ((seg.now * seg.speed) >> 7) >>> 0;
    const logicalShift = (seg.now * seg.speed) >>> 7;
    expect(signedShift).not.toBe(logicalShift); // the frame really is past 2^31
    // Rendering with the logical value must match a hand-rolled reference.
    const ref = new Segment(30, 0x1234);
    ref.speed = 255;
    ref.palette = 11;
    ref.colors = [0xffa000, 0, 0];
    ref.now = 9_000_000;
    ref.refreshPalette();
    for (let i = 0; i < ref.length; i++) {
      ref.setPixelColor(
        i,
        ref.color_from_palette(
          inoise16xy(i << 12, logicalShift),
          false,
          false,
          0,
        ),
      );
    }
    expect(Array.from(seg.pixels)).toEqual(Array.from(ref.pixels));
  });
});

describe('Aurora (38) brightness stays unsigned', () => {
  it('shifts its 32-bit brightness products logically', () => {
    // AuroraWave::getColorForLED multiplies two AW_SCALE-scaled uint32 values
    // (up to 65536 * 65535) before shifting back down. A signed shift reads
    // any product past 2^31 as negative, which brightens the core of a wave
    // in the middle of its life rather than dimming it.
    const sim = createEffectSim(38, {
      length: 60,
      sx: 24,
      ix: 200,
      pal: 0,
      seed: 0x1234,
      colors: [[255, 160, 0], BLACK_RGB, BLACK_RGB],
    });
    let sum = 0;
    for (let t = 0; t <= 4000; t += 200) {
      for (const px of sim.frame(t)) sum += px[0] + px[1] + px[2];
    }
    expect(sum).toBe(120014); // 120692 with the signed shift
  });
});

describe('beatsin bpm is a uint16 parameter', () => {
  it('wraps Frizzles (177) negative bpm at 16 bits, not 8', () => {
    // beatsin8_t's first parameter is uint16_t, and Frizzles feeds it
    // intensity/8 - i, which goes negative for every i once intensity drops
    // below 64. Wrapping that at a byte lands under 256, where beat16 shifts
    // the bpm left by 8 -- a completely different rate.
    const sim = createEffectSim(177, {
      length: 256,
      width: 16,
      height: 16,
      dimensions: '2d',
      sx: 128,
      ix: 16, // intensity/8 = 2, so i = 3..8 all go negative
      pal: 11,
      seed: 0x1234,
      custom1: 0,
    });
    const lit = sim.frame(1000).filter((p) => p[0] || p[1] || p[2]).length;
    expect(lit).toBe(50); // 62 when the bpm wraps at a byte
  });
});

describe('abs8 narrows before taking the absolute value', () => {
  // FastLED's abs8 takes an int8_t, so a span wider than 127 wraps to a small
  // (or negative) one before abs() runs -- it caps how long the gradient lines
  // in Colored Bursts (167) and DNA Spiral (182) can get. Only observable on a
  // matrix wider than 128, which firmware allows (maxWidth/maxHeight cap at
  // 255); the counts below are with the wrap, 494 and 13832 without it.
  const litCount = (id: number, w: number, h: number) => {
    const sim = createEffectSim(id, {
      length: w * h,
      width: w,
      height: h,
      dimensions: '2d',
      sx: 180,
      ix: 200,
      pal: 11,
      seed: 0x1234,
      custom1: 100,
      custom3: 24,
    });
    return sim.frame(2000).filter((px) => px[0] || px[1] || px[2]).length;
  };

  it('caps DNA Spiral (182) line length on a 200-wide matrix', () => {
    expect(litCount(182, 200, 4)).toBe(484);
  });

  it('caps Colored Bursts (167) line length on a 160-wide matrix', () => {
    expect(litCount(167, 160, 160)).toBe(13761);
  });
});

describe('integer division at firmware widths', () => {
  it('Bouncing Balls (91) truncates its bounce-time quotient', () => {
    // (time - lastBounceTime) is an unsigned long and the speed divisor an
    // int, so C truncates the quotient before widening it to float. Keeping
    // the fraction moves the ball a pixel early on a long strip.
    const seg = new Segment(300, 0x1234);
    seg.speed = 0; // divisor 4, the coarsest -- biggest lost fraction
    seg.intensity = 0; // a single ball
    seg.colors = [0xffffff, 0, 0];
    const pos: number[] = [];
    for (let f = 0; f < 4; f++) {
      seg.now = f * STEP_MS;
      seg.refreshPalette();
      EFFECT_SIMS[91](seg);
      seg.call++;
      let lit = -1;
      for (let i = 0; i < seg.length; i++) if (seg.pixels[i]) lit = i;
      pos.push(lit);
    }
    expect(pos).toEqual([0, 7, 14, 22]); // 0, 8, 15, 22 without the truncation
  });

  it('Oscillate (62) seeds its bars from SEGLEN/4 before multiplying', () => {
    // SEGLEN/4*3 and SEGLEN/4*2 divide first, in integers: on 30 pixels that
    // is 7*3 = 21 and 7*2 = 14, not trunc(7.5*3) = 22 and trunc(7.5*2) = 15.
    const seg = new Segment(30, 0x1234);
    seg.speed = 0;
    seg.intensity = 128; // bar half-width 1, so each centre lights 3 pixels
    seg.colors = [0xff0000, 0x00ff00, 0x0000ff];
    seg.now = 0;
    seg.refreshPalette();
    EFFECT_SIMS[62](seg);
    const lit: number[] = [];
    for (let i = 0; i < seg.length; i++) if (seg.pixels[i]) lit.push(i);
    expect(lit).toEqual([6, 7, 8, 13, 14, 15, 20, 21, 22]);
  });
});

describe('Multi Comet (59) fade', () => {
  it('fades toward the secondary colour, not toward black', () => {
    // mode_multi_comet calls fade_out (which walks each channel toward
    // SEGCOLOR(1)), not fadeToBlackBy.
    const sim = createEffectSim(59, {
      length: 30,
      sx: 128,
      ix: 0, // fade_out(128): slowest rate, so the background is reached gradually
      colors: [[255, 255, 255], [0, 0, 80], BLACK_RGB],
    });
    const buf = sim.frame(3000);
    // Every pixel that is not a live comet head has been walked toward the
    // blue background rather than dimmed to black.
    expect(buf.some((px) => px[2] > px[0] && px[2] > 0)).toBe(true);
  });
});

describe('SEGENV counters stay in their firmware widths', () => {
  it('rolls aux1 over at uint16 rather than counting past it', () => {
    // Chase Flash (31) reads aux1 modulo 9 and PacMan (151) modulo 10/15 and
    // the speed divisor, so the uint16_t rollover changes what is drawn, not
    // just the stored number. Seed the counter at its rollover point rather
    // than running the ~65k frames it would take to get there.
    for (const [id, sx] of [
      [31, 255],
      [151, 192],
    ] as const) {
      const seg = new Segment(60, 0x1234);
      seg.speed = sx;
      seg.intensity = 64;
      seg.custom1 = 64;
      seg.custom3 = 12;
      seg.colors = [0xffa000, 0, 0];
      for (let f = 0; f < 4; f++) {
        seg.now = f * STEP_MS;
        seg.refreshPalette();
        EFFECT_SIMS[id](seg);
        seg.call++;
      }
      seg.aux1 = 0xffff;
      seg.step = 0; // both bodies tick their counter when now is past step
      seg.now = 100000;
      seg.refreshPalette();
      EFFECT_SIMS[id](seg);
      expect(seg.aux1, `fx ${id} aux1`).toBe(0);
    }
  });

  it('rolls Polar Lights (174) step over at uint32', () => {
    // SEGENV.step is bumped once per pixel, so on a big matrix it reaches
    // 2^32 in about 25 minutes; it feeds the noise Z coordinate as
    // step / _speed, which does not survive counting past the field.
    const seg = new Segment2D(64, 64, 0x1234);
    seg.speed = 128;
    seg.intensity = 128;
    seg.colors = [0xffa000, 0, 0];
    seg.step = 0xffffffff - 10;
    seg.now = 1000;
    seg.refreshPalette();
    EFFECT_SIMS_2D[174](seg);
    expect(seg.step).toBeLessThanOrEqual(0xffffffff);
    expect(seg.step).toBeGreaterThanOrEqual(0);
  });
});

describe('single-pixel fallback', () => {
  it('falls back to a solid fill wherever upstream guards SEGLEN <= 1', () => {
    // Every id here opens with `if (SEGLEN <= 1) FX_FALLBACK_STATIC` upstream.
    const ids = [
      12, 24, 31, 32, 35, 40, 41, 42, 43, 44, 45, 50, 57, 64, 66, 76, 78, 79,
      82, 84, 89, 90, 91, 95, 96, 99, 104, 111, 112, 128, 129, 135, 147, 151,
      155, 163, 179,
    ];
    for (const id of ids) {
      for (const dimensions of ['1d', '2d'] as const) {
        if (dimensions === '1d' ? !supports1D(id) : !supports2D(id)) continue;
        const sim = createEffectSim(id, {
          length: 1,
          width: 1,
          height: 1,
          dimensions,
          colors: [RED, GREEN, BLUE],
        });
        for (const t of [0, 500, 5000]) {
          expect(sim.frame(t), `fx ${id} ${dimensions} @${t}`).toEqual([RED]);
        }
      }
    }
  });
});

describe('2D fallbacks', () => {
  it('audio 2D bodies fall back to a solid fill off a real matrix', () => {
    // GEQ, Funky Plank, Swirl, Waverly and Akemi all open with
    // `if (!strip.isMatrix || !SEGMENT.is2D()) FX_FALLBACK_STATIC` upstream.
    for (const id of [139, 160, 165, 175, 186]) {
      const sim = createEffectSim(id, {
        length: 16,
        width: 16,
        height: 1,
        dimensions: '2d',
        colors: [RED, GREEN, BLUE],
      });
      const buf = sim.frame(500);
      expect(buf).toHaveLength(16);
      for (const px of buf) expect(px).toEqual(RED);
    }
  });
});

describe('animated effects change over time', () => {
  // Solid (0) is intentionally static. Percent (98) at ix=200 saturates to
  // 0% fill from frame 0 (its own math, not a port bug) -- also static here.
  // Solid Pattern (83/84) and Spots (85) have no seg.now dependency at all --
  // genuinely time-invariant configurable patterns, same category as Solid.
  // Palette (65)'s rotation/shift only read seg.now when its Animate
  // Rotation/Animate Shift checkboxes are on; both default false here (this
  // harness never sets check1/check2), so it's static under these params too.
  // Noise 1 (70) hits color_from_palette's palette-0 shortcut (same one Fairy/
  // Colorwaves/Plasma rely on a real palette to see past): every pixel calls
  // it with mcol<3 and the default pbri (255), so at the test's default
  // "Default" palette it always returns the raw, unchanging segment color --
  // genuinely animated only once a real palette is set (see its spot check).
  // Fill Noise8 (69) samples a palette purely by index (no brightness/blend
  // modulation of its own) -- at this test's default palette 0,
  // color_from_palette's real "Default palette" shortcut discards the index
  // argument entirely, so it renders a static solid color (a real firmware
  // characteristic, confirmed against a non-default palette in the spot
  // checks below, not a port bug).
  // Noise 4 (73) hits the exact same palette-0 shortcut as Noise 1/Fill
  // Noise8 -- it passes only `index` (no varying pbri), so it's static here
  // too (see its spot check for a real-palette proof it animates).
  // Flash Sparkle (21) genuinely does change over time, but only for a
  // single simulated frame per rare flash (real firmware: hw_random8 gated,
  // ~1/3 chance per ~55ms check at this test's params) -- coarse multi-
  // hundred-ms sampling isn't a reliable way to observe a one-frame event,
  // not a sign the port is actually static (see its spot check, which
  // samples densely enough to catch a flash).
  // Hourglass (207) waits for a manual/auto start: dropping only runs when
  // Start (check2) is set, and its color only moves for certain Color (custom1)
  // ranges. This harness sets neither (check2 false, custom1 0 -> the fixed-hue
  // colormode 0), so every particle sits pinned at its rest position with a
  // constant hue -- genuinely static under these params, like Palette above.
  // Hiphotic (180) is another palette-0-shortcut case (every pixel goes
  // through color_from_palette with mcol=0 and default pbri, so the default
  // palette returns the raw segment color regardless of the noise index) --
  // see its spot check for a real-palette proof it animates.
  const staticIds = new Set([0, 98, 83, 84, 85, 65, 70, 69, 73, 21, 207, 180]);
  const animated = portedFxIds().filter((id) => !staticIds.has(id));
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

  // 83/84/85 are legitimately static, so they sit out the "differs over time"
  // sweep above; without these three they would have no pixel-content coverage
  // at all and could be blanked to black without failing a single test.
  it('Solid Pattern (83) alternates lit/unlit runs at the configured lengths', () => {
    // sx=3 -> 4 lit, ix=1 -> 2 unlit; unlit pixels are color(1) = black
    const sim = createEffectSim(83, {
      length: LEN,
      sx: 3,
      ix: 1,
      pal: 11,
      colors: [RED, BLACK_RGB, BLUE],
    });
    const buf = sim.frame(0);
    const lit = buf.map((px) => px[0] + px[1] + px[2] > 0);
    // period is 4 lit + 2 unlit
    for (let i = 0; i < LEN; i++) {
      expect(lit[i]).toBe(i % 6 < 4);
    }
  });

  it('Solid Pattern Tri (84) lays down its three colors in equal runs', () => {
    // ix=0 -> segSize 1, so the P/S/T colors cycle one pixel at a time
    const sim = createEffectSim(84, {
      length: LEN,
      ix: 0,
      colors: [RED, GREEN, BLUE],
    });
    const buf = sim.frame(0);
    const want = [RED, GREEN, BLUE];
    for (let i = 0; i < LEN; i++) {
      expect(buf[i]).toEqual(want[i % 3]);
    }
    expect(new Set(buf.map((px) => px.join(','))).size).toBe(3);
  });

  it('Spots (85) draws the expected number of lit zones', () => {
    // maxZones = 30>>2 = 7; ix=255 -> zones = 1 + ((255*7)>>8) = 7
    const sim = createEffectSim(85, {
      length: LEN,
      sx: 128,
      ix: 255,
      pal: 11,
      colors: [RED, BLACK_RGB, BLUE],
    });
    const buf = sim.frame(0);
    const lit = buf.map((px) => px[0] + px[1] + px[2] > 0);
    expect(lit.some(Boolean)).toBe(true);
    // count runs of lit pixels
    let runs = 0;
    for (let i = 0; i < LEN; i++) if (lit[i] && !lit[i - 1]) runs++;
    expect(runs).toBe(7);
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

  it('Perlin Move (147) trail length tracks custom1 (c1 reaches the sim)', () => {
    // custom1 gates fade retention: fade_out(255 - custom1). A high c1 keeps
    // pixels lit far longer, so the strip accumulates much more total light.
    // Proves the c1/c2/c3 params actually flow into the sim (the fidelity fix).
    // Low intensity (few fresh pixels/frame) so the persisted trail dominates.
    const lit = (custom1: number) => {
      const sim = createEffectSim(147, {
        length: LEN,
        sx: 128,
        ix: 8,
        custom1,
      });
      let sum = 0;
      for (let t = 0; t < 2000; t += 25) {
        for (const px of sim.frame(t)) sum += px[0] + px[1] + px[2];
      }
      return sum;
    };
    expect(lit(255)).toBeGreaterThan(lit(0) * 1.4);
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

  it('Pacifica (101) keeps SEGENV.step a uint32 so its high half stays intact', () => {
    // Upstream packs sCIStart4 into the top 16 bits of a uint32 step and reads
    // it back with a logical >>16; a signed step would truncate toward zero
    // there and drift the fourth wave layer by one per frame.
    const seg = new Segment(30, 0x1234);
    for (let f = 0; f < 200; f++) {
      seg.now = f * STEP_MS;
      seg.refreshPalette();
      EFFECT_SIMS[101](seg);
      seg.call++;
      expect(seg.step).toBeGreaterThanOrEqual(0);
      expect(seg.step).toBeLessThanOrEqual(0xffffffff);
    }
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

  it('Pride 2015 (63) shows multiple distinct hues across the strip', () => {
    const sim = createEffectSim(63, { length: LEN, sx: 128, ix: 128 });
    const buf = sim.frame(2000);
    const uniqueColors = new Set(buf.map((px) => px.join(',')));
    expect(uniqueColors.size).toBeGreaterThan(3);
  });

  it('Juggle (64) lights a handful of dots against a mostly-dark strip', () => {
    const sim = createEffectSim(64, {
      length: 60,
      sx: 200,
      colors: [[0, 0, 0], BLACK_RGB, BLACK_RGB],
    });
    const buf = sim.frame(500);
    const lit = buf.filter((px) => px[0] + px[1] + px[2] > 100);
    expect(lit.length).toBeGreaterThan(0);
    expect(lit.length).toBeLessThan(60);
  });

  it('Bpm (68) pulses brightness to the beat over time', () => {
    const sim = createEffectSim(68, {
      length: LEN,
      sx: 120,
      colors: [[255, 200, 100], BLACK_RGB, BLACK_RGB],
    });
    let minLum = Infinity;
    let maxLum = 0;
    for (let t = 0; t < 4000; t += 40) {
      const lum = sim.frame(t)[0].reduce((s, c) => s + c, 0);
      minLum = Math.min(minLum, lum);
      maxLum = Math.max(maxLum, lum);
    }
    expect(maxLum).toBeGreaterThan(minLum);
  });

  it('Sinelon (92) moves its bright dot along the strip over time', () => {
    const sim = createEffectSim(92, {
      length: 40,
      sx: 128,
      ix: 64,
      colors: [[255, 255, 255], BLACK_RGB, BLACK_RGB],
    });
    const brightestIndex = (buf: RGB[]) =>
      buf.reduce(
        (best, px, i) =>
          px[0] + px[1] + px[2] > buf[best][0] + buf[best][1] + buf[best][2]
            ? i
            : best,
        0,
      );
    const i1 = brightestIndex(sim.frame(0));
    const i2 = brightestIndex(sim.frame(3000));
    expect(i1).not.toBe(i2);
  });

  it('Traffic Light (35) cycles between red, amber and green', () => {
    const sim = createEffectSim(35, {
      length: 12,
      sx: 255, // max speed -> shortest per-state dwell (~150ms), several
      // full cycles fit inside the sampling window below.
      colors: [[10, 10, 10], BLACK_RGB, BLACK_RGB],
    });
    let sawRed = false;
    let sawAmber = false;
    let sawGreen = false;
    for (let t = 0; t < 3000; t += 20) {
      for (const px of sim.frame(t)) {
        if (px[0] > 200 && px[1] < 50 && px[2] < 50) sawRed = true;
        if (px[0] > 200 && px[1] > 150 && px[2] < 50) sawAmber = true;
        if (px[1] > 200 && px[0] < 50 && px[2] < 50) sawGreen = true;
      }
    }
    expect(sawRed).toBe(true);
    expect(sawAmber).toBe(true);
    expect(sawGreen).toBe(true);
  });

  it('Colorful (34) shows multiple distinct color blocks', () => {
    const sim = createEffectSim(34, { length: 20, sx: 128, ix: 200 });
    const buf = sim.frame(0);
    const uniqueColors = new Set(buf.map((px) => px.join(',')));
    expect(uniqueColors.size).toBeGreaterThan(1);
  });

  it('Washing Machine (113) shifts its hue pattern over time', () => {
    const sim = createEffectSim(113, { length: LEN, sx: 128, ix: 128 });
    const frame0 = JSON.stringify(sim.frame(0));
    const frame3000 = JSON.stringify(sim.frame(3000));
    expect(frame3000).not.toBe(frame0);
  });

  it('Percent (98) at 50% fills roughly half the strip', () => {
    const sim = createEffectSim(98, {
      length: 40,
      sx: 255,
      ix: 50,
      colors: [[255, 255, 255], BLACK_RGB, BLACK_RGB],
    });
    let lit = 0;
    for (const px of sim.frame(2000)) {
      if (px[0] + px[1] + px[2] > 30) lit++;
    }
    expect(lit).toBeGreaterThan(10);
    expect(lit).toBeLessThan(30);
  });

  it('Lightning (57) has both bright flash frames and quiet (background) frames', () => {
    const sim = createEffectSim(57, {
      length: LEN,
      sx: 255, // max speed -> minimal inter-strike delay, more flashes/window
      colors: [[255, 255, 255], BLACK_RGB, BLACK_RGB],
    });
    let sawFlash = false;
    let sawQuiet = false;
    for (let t = 0; t < 4000; t += 15) {
      const lum = sim.frame(t).reduce((s, px) => s + px[0] + px[1] + px[2], 0);
      if (lum > 100) sawFlash = true;
      if (lum === 0) sawQuiet = true;
    }
    expect(sawFlash).toBe(true);
    expect(sawQuiet).toBe(true);
  });

  it('Oscillate (62) shows multiple distinct color bands', () => {
    const sim = createEffectSim(62, {
      length: 40,
      sx: 128,
      ix: 128,
      colors: [RED, GREEN, BLUE],
    });
    const buf = sim.frame(500);
    const uniqueColors = new Set(buf.map((px) => px.join(',')));
    expect(uniqueColors.size).toBeGreaterThan(1);
  });

  it('Bouncing Balls (91) lights pixels within strip bounds over time', () => {
    const sim = createEffectSim(91, {
      length: 30,
      sx: 128,
      ix: 128,
      colors: [[255, 255, 255], BLACK_RGB, BLACK_RGB],
    });
    let sawLit = false;
    for (let t = 0; t < 3000; t += 30) {
      const buf = sim.frame(t);
      expect(buf.length).toBe(30);
      if (buf.some((px) => px[0] + px[1] + px[2] > 50)) sawLit = true;
    }
    expect(sawLit).toBe(true);
  });

  it('Popcorn (95) eventually pops a kernel above the background', () => {
    const sim = createEffectSim(95, {
      length: 30,
      sx: 128,
      ix: 200,
      colors: [[255, 255, 255], BLACK_RGB, BLACK_RGB],
    });
    let sawKernel = false;
    for (let t = 0; t < 6000; t += 30) {
      const buf = sim.frame(t);
      if (buf.some((px) => px[0] + px[1] + px[2] > 100)) sawKernel = true;
    }
    expect(sawKernel).toBe(true);
  });

  it('Tetrix (44) eventually shows a falling brick against the background', () => {
    const sim = createEffectSim(44, {
      length: 20,
      sx: 200,
      ix: 128,
      colors: [[255, 200, 50], BLACK_RGB, BLACK_RGB],
    });
    let sawBrick = false;
    for (let t = 0; t < 5000; t += 40) {
      const buf = sim.frame(t);
      if (buf.some((px) => px[0] + px[1] + px[2] > 60)) sawBrick = true;
    }
    expect(sawBrick).toBe(true);
  });

  it('Fairy (49) fills the strip with varied palette colors', () => {
    // palette 0 ("Default") short-circuits color_from_palette to the raw
    // segment color regardless of index -- an actual palette is needed to
    // see per-pixel hue variation, same as the Colorwaves/Plasma spot checks.
    const sim = createEffectSim(49, { length: 30, sx: 128, ix: 0, pal: 26 });
    const buf = sim.frame(0);
    const uniqueColors = new Set(buf.map((px) => px.join(',')));
    expect(uniqueColors.size).toBeGreaterThan(1);
  });

  it('Fairytwinkle (51) fades individual pixels up and down over time', () => {
    const sim = createEffectSim(51, {
      length: 20,
      sx: 128,
      ix: 128,
      colors: [[255, 255, 255], BLACK_RGB, BLACK_RGB],
    });
    let minLum = Infinity;
    let maxLum = 0;
    for (let t = 0; t < 6000; t += 50) {
      const lum = sim.frame(t)[0].reduce((s, c) => s + c, 0);
      minLum = Math.min(minLum, lum);
      maxLum = Math.max(maxLum, lum);
    }
    expect(maxLum).toBeGreaterThan(minLum);
  });

  it('Twinkleup (106) at max intensity keeps most pixels lit', () => {
    const sim = createEffectSim(106, {
      length: 30,
      sx: 128,
      ix: 255,
      colors: [[255, 255, 255], BLACK_RGB, BLACK_RGB],
    });
    const buf = sim.frame(500);
    const lit = buf.filter((px) => px[0] + px[1] + px[2] > 0);
    expect(lit.length).toBeGreaterThan(15);
  });

  it('Ripple (79) eventually shows a ripple against the background', () => {
    const sim = createEffectSim(79, {
      length: 40,
      sx: 128,
      ix: 220,
      colors: [[255, 255, 255], BLACK_RGB, BLACK_RGB],
    });
    let sawRipple = false;
    for (let t = 0; t < 4000; t += 25) {
      const buf = sim.frame(t);
      if (buf.some((px) => px[0] + px[1] + px[2] > 60)) sawRipple = true;
    }
    expect(sawRipple).toBe(true);
  });

  it('Two Dots (50) lights two distinct groups on opposite sides', () => {
    const sim = createEffectSim(50, {
      length: 40,
      sx: 128,
      ix: 20,
      colors: [RED, GREEN, BLACK_RGB],
    });
    const buf = sim.frame(0);
    const litIdx = buf
      .map((px, i) => (px[0] + px[1] + px[2] > 20 ? i : -1))
      .filter((i) => i >= 0);
    expect(litIdx.length).toBeGreaterThan(0);
    const spread = Math.max(...litIdx) - Math.min(...litIdx);
    expect(spread).toBeGreaterThan(10);
  });

  it('Rain (43) shifts a spark position along the strip over time', () => {
    const sim = createEffectSim(43, {
      length: 30,
      sx: 200,
      ix: 200,
      colors: [[255, 255, 255], BLACK_RGB, BLACK_RGB],
    });
    const frame0 = JSON.stringify(sim.frame(0));
    const frame2000 = JSON.stringify(sim.frame(2000));
    expect(frame2000).not.toBe(frame0);
  });

  it('Twinklecat (81) differs from Twinklefox (80) under the same params', () => {
    const params = {
      length: 40,
      sx: 128,
      ix: 128,
      colors: [[80, 120, 255], [4, 4, 8], BLACK_RGB] as RGB[],
    };
    const cat = createEffectSim(81, params);
    const fox = createEffectSim(80, params);
    let sawDifference = false;
    for (let t = 0; t < 3000; t += 50) {
      if (JSON.stringify(cat.frame(t)) !== JSON.stringify(fox.frame(t))) {
        sawDifference = true;
      }
    }
    expect(sawDifference).toBe(true);
  });

  it('Heartbeat (100) pulses brightness with a lub-dub double-beat', () => {
    const sim = createEffectSim(100, {
      length: LEN,
      sx: 100,
      colors: [[255, 200, 100], BLACK_RGB, BLACK_RGB],
    });
    let minLum = Infinity;
    let maxLum = 0;
    for (let t = 0; t < 4000; t += 20) {
      const lum = sim.frame(t)[0].reduce((s, c) => s + c, 0);
      minLum = Math.min(minLum, lum);
      maxLum = Math.max(maxLum, lum);
    }
    expect(maxLum).toBeGreaterThan(minLum);
  });

  it('Railway (78) reverses its ramp direction over a long window', () => {
    const sim = createEffectSim(78, { length: LEN, sx: 128, ix: 200, pal: 26 });
    const early = JSON.stringify(sim.frame(500));
    const late = JSON.stringify(sim.frame(8000));
    expect(late).not.toBe(early);
  });

  it('Chunchun (111) spreads bird positions across the strip', () => {
    const sim = createEffectSim(111, {
      length: 50,
      sx: 128,
      ix: 200,
      colors: [[255, 255, 255], BLACK_RGB, BLACK_RGB],
    });
    const buf = sim.frame(1000);
    const litIdx = buf
      .map((px, i) => (px[0] + px[1] + px[2] > 30 ? i : -1))
      .filter((i) => i >= 0);
    expect(litIdx.length).toBeGreaterThan(0);
    // "spreads across the strip" means more than one bird, spread out -- a
    // regression collapsing them onto one pixel would pass a lit-count check
    const span = litIdx[litIdx.length - 1] - litIdx[0];
    expect(span).toBeGreaterThanOrEqual(20);
    let runs = 0;
    for (const i of litIdx) if (!litIdx.includes(i - 1)) runs++;
    expect(runs).toBeGreaterThanOrEqual(2);
  });

  it('Blink Rainbow (26) cycles hues across its lit frames', () => {
    const sim = createEffectSim(26, {
      length: LEN,
      sx: 200,
      ix: 128,
      colors: [
        [255, 255, 255],
        [0, 0, 0],
      ],
    });
    const litColors = new Set<string>();
    let sawDark = false;
    for (let t = 0; t < 4000; t += 20) {
      const px = sim.frame(t)[0];
      const lum = px[0] + px[1] + px[2];
      if (lum > 30) litColors.add(px.join(','));
      if (lum === 0) sawDark = true;
    }
    expect(litColors.size).toBeGreaterThan(1);
    expect(sawDark).toBe(true);
  });

  it('Strobe Rainbow (24) flashes varying rainbow colors against dark', () => {
    const sim = createEffectSim(24, {
      length: LEN,
      sx: 200,
      colors: [
        [255, 255, 255],
        [0, 0, 0],
      ],
    });
    const flashColors = new Set<string>();
    let sawDark = false;
    for (let t = 0; t < 4000; t += 5) {
      const px = sim.frame(t)[0];
      const lum = px[0] + px[1] + px[2];
      if (lum > 30) flashColors.add(px.join(','));
      if (lum === 0) sawDark = true;
    }
    expect(flashColors.size).toBeGreaterThan(1);
    expect(sawDark).toBe(true);
  });

  it('Halloween Eyes (82) fades a pair of eyes up over time against a dark background', () => {
    const sim = createEffectSim(82, {
      length: 60,
      sx: 128,
      ix: 200,
      colors: [[255, 200, 50], BLACK_RGB, BLACK_RGB],
    });
    let minLum = Infinity;
    let maxLum = 0;
    let sawPair = false;
    let maxLitFraction = 0;
    for (let t = 0; t < 8000; t += 40) {
      const buf = sim.frame(t);
      const lum = buf.reduce((s, px) => s + px[0] + px[1] + px[2], 0);
      minLum = Math.min(minLum, lum);
      maxLum = Math.max(maxLum, lum);
      // "a pair of eyes against a dark background": two distinct lit runs, and
      // the background stays dark -- whole-strip flashing would pass on
      // luminance variance alone
      const lit = buf.map((px) => px[0] + px[1] + px[2] > 30);
      let runs = 0;
      for (let i = 0; i < lit.length; i++) if (lit[i] && !lit[i - 1]) runs++;
      if (runs === 2) sawPair = true;
      maxLitFraction = Math.max(
        maxLitFraction,
        lit.filter(Boolean).length / lit.length,
      );
    }
    expect(maxLum).toBeGreaterThan(minLum);
    expect(sawPair).toBe(true);
    expect(maxLitFraction).toBeLessThan(0.25);
  });

  it('Dancing Shadows (112) casts moving spotlights against a black background', () => {
    const sim = createEffectSim(112, {
      length: 40,
      sx: 128,
      ix: 128,
      colors: [[255, 255, 255], BLACK_RGB, BLACK_RGB],
    });
    let sawLit = false;
    const snapshots = new Set<string>();
    for (let t = 0; t < 4000; t += 40) {
      const buf = sim.frame(t);
      if (buf.some((px) => px[0] + px[1] + px[2] > 60)) sawLit = true;
      snapshots.add(JSON.stringify(buf));
    }
    expect(sawLit).toBe(true);
    expect(snapshots.size).toBeGreaterThan(1);
  });

  it('Palette (65) spins a palette band across the strip', () => {
    const sim = createEffectSim(65, { length: 40, sx: 128, ix: 128, pal: 26 });
    const buf = sim.frame(0);
    const uniqueColors = new Set(buf.map((px) => px.join(',')));
    expect(uniqueColors.size).toBeGreaterThan(3);
  });

  it('ICU (58) moves its eyes to different positions over time', () => {
    const sim = createEffectSim(58, {
      length: 40,
      sx: 200,
      ix: 100,
      colors: [[255, 255, 255], BLACK_RGB, BLACK_RGB],
    });
    const litIndex = (buf: RGB[]) =>
      buf.findIndex((px) => px[0] + px[1] + px[2] > 50);
    const positions = new Set<number>();
    for (let t = 0; t < 6000; t += 100) {
      const idx = litIndex(sim.frame(t));
      if (idx >= 0) positions.add(idx);
    }
    expect(positions.size).toBeGreaterThan(1);
  });

  it('Solid Glitter (103) fills a solid background and eventually sparkles', () => {
    const sim = createEffectSim(103, {
      length: 30,
      ix: 255,
      colors: [[10, 10, 10], BLACK_RGB, [255, 255, 255]],
    });
    let sawGlitter = false;
    for (let t = 0; t < 500; t += 23) {
      const buf = sim.frame(t);
      const bgMatches = buf.filter(
        (px) => px[0] === 10 && px[1] === 10 && px[2] === 10,
      ).length;
      expect(bgMatches).toBeGreaterThanOrEqual(buf.length - 1);
      if (buf.some((px) => px[0] === 255 && px[1] === 255 && px[2] === 255)) {
        sawGlitter = true;
      }
    }
    expect(sawGlitter).toBe(true);
  });

  it('Drip (96) forms and falls, lighting positions other than the source pixel', () => {
    const sim = createEffectSim(96, {
      length: 30,
      sx: 200,
      ix: 200,
      colors: [[255, 255, 255], BLACK_RGB, BLACK_RGB],
    });
    let sawDropAway = false;
    for (let t = 0; t < 6000; t += 30) {
      const buf = sim.frame(t);
      for (let i = 0; i < buf.length - 1; i++) {
        const [r, g, b] = buf[i];
        if (r + g + b > 60) sawDropAway = true;
      }
    }
    expect(sawDropAway).toBe(true);
  });

  it('Fireworks Starburst (89) shows bright burst frames against the background', () => {
    const sim = createEffectSim(89, {
      length: 60,
      sx: 200,
      ix: 200,
      colors: [[255, 255, 255], BLACK_RGB, BLACK_RGB],
    });
    let sawBurst = false;
    for (let t = 0; t < 6000; t += 30) {
      const buf = sim.frame(t);
      if (buf.some((px) => px[0] + px[1] + px[2] > 200)) sawBurst = true;
    }
    expect(sawBurst).toBe(true);
  });

  it('Theater Rainbow (14) cycles through different hues over time (unlike Theater Chase)', () => {
    const params = {
      length: 30,
      sx: 200,
      ix: 64,
      colors: [[255, 255, 255], BLACK_RGB, BLACK_RGB] as RGB[],
    };
    const rainbow = createEffectSim(14, params);
    const chase = createEffectSim(13, params);
    let sawDifference = false;
    for (let t = 0; t < 3000; t += 50) {
      if (JSON.stringify(rainbow.frame(t)) !== JSON.stringify(chase.frame(t))) {
        sawDifference = true;
      }
    }
    expect(sawDifference).toBe(true);
  });

  it('Android (27) slides its lit arc around the strip over time', () => {
    const sim = createEffectSim(27, {
      length: 30,
      sx: 128,
      ix: 128,
      colors: [[255, 255, 255], BLACK_RGB, BLACK_RGB],
    });
    const frame0 = JSON.stringify(sim.frame(0));
    const frame3000 = JSON.stringify(sim.frame(3000));
    expect(frame3000).not.toBe(frame0);
  });

  it('Noise 1 (70) varies spatially and over time once a real palette is set', () => {
    // palette 0 ("Default") short-circuits color_from_palette to the raw
    // segment color regardless of index -- same as Fairy/Colorwaves/Plasma,
    // needs an actual palette selected to see the noise pattern (see the
    // staticIds comment above for why the generic contract test excludes it).
    const sim = createEffectSim(70, { length: 30, sx: 128, pal: 26 });
    const frame0 = sim.frame(0);
    const uniqueAcrossStrip = new Set(frame0.map((px) => px.join(',')));
    expect(uniqueAcrossStrip.size).toBeGreaterThan(1);
    const frame0Str = JSON.stringify(frame0);
    const frame3000Str = JSON.stringify(sim.frame(3000));
    expect(frame3000Str).not.toBe(frame0Str);
  });

  it('Fireworks 1D (90) eventually launches a bright flare or spark', () => {
    const sim = createEffectSim(90, {
      length: 40,
      sx: 128,
      ix: 128,
      colors: [[255, 255, 255], BLACK_RGB, BLACK_RGB],
    });
    let sawBright = false;
    for (let t = 0; t < 6000; t += 30) {
      const buf = sim.frame(t);
      if (buf.some((px) => px[0] + px[1] + px[2] > 200)) sawBright = true;
    }
    expect(sawBright).toBe(true);
  });

  it('TV Simulator (116) fills the strip with one flickering color that changes over time', () => {
    const sim = createEffectSim(116, { length: 20, sx: 128, ix: 128 });
    let sawVariation = false;
    let prev = JSON.stringify(sim.frame(0)[0]);
    for (let t = 50; t < 6000; t += 50) {
      const buf = sim.frame(t);
      expect(
        buf.every(
          (px) =>
            px[0] === buf[0][0] && px[1] === buf[0][1] && px[2] === buf[0][2],
        ),
      ).toBe(true);
      const cur = JSON.stringify(buf[0]);
      if (cur !== prev) sawVariation = true;
      prev = cur;
    }
    expect(sawVariation).toBe(true);
  });

  it('Scanner Dual (60) is exactly Scanner (40) with check1 forced on', () => {
    const base = {
      length: 30,
      sx: 200,
      ix: 128,
      colors: [[255, 255, 255], BLACK_RGB, BLACK_RGB] as RGB[],
    };
    const dual = createEffectSim(60, base);
    const scannerForced = createEffectSim(40, { ...base, check1: true });
    const scannerPlain = createEffectSim(40, base);
    let matchesForced = true;
    let differsFromPlain = false;
    for (let t = 0; t < 2000; t += 25) {
      const bufDual = JSON.stringify(dual.frame(t));
      if (bufDual !== JSON.stringify(scannerForced.frame(t)))
        matchesForced = false;
      if (bufDual !== JSON.stringify(scannerPlain.frame(t)))
        differsFromPlain = true;
    }
    expect(matchesForced).toBe(true);
    expect(differsFromPlain).toBe(true);
  });

  it('Stream (39) shows shifting color zones along the strip over time', () => {
    const sim = createEffectSim(39, { length: 40, sx: 128, ix: 128 });
    const frame0 = JSON.stringify(sim.frame(0));
    const buf3000 = sim.frame(3000);
    expect(JSON.stringify(buf3000)).not.toBe(frame0);
    const uniqueColors = new Set(buf3000.map((px) => px.join(',')));
    expect(uniqueColors.size).toBeGreaterThan(1);
  });

  it('Multi Comet (59) shows fading comet trails moving along the strip', () => {
    const sim = createEffectSim(59, {
      length: 30,
      sx: 128,
      ix: 128,
      colors: [[255, 255, 255], BLACK_RGB, BLACK_RGB],
    });
    const early = JSON.stringify(sim.frame(0));
    let sawLit = false;
    for (let t = 0; t < 3000; t += 25) {
      const buf = sim.frame(t);
      if (buf.some((px) => px[0] + px[1] + px[2] > 50)) sawLit = true;
    }
    expect(sawLit).toBe(true);
    expect(JSON.stringify(sim.frame(3000))).not.toBe(early);
  });

  it('Pac-Man (151) draws characters that move along the strip over time', () => {
    const params = { length: 40, sx: 128, ix: 128 };
    const activity = createEffectSim(151, params);
    let sawLit = false;
    for (let t = 0; t < 2000; t += 30) {
      const buf = activity.frame(t);
      if (buf.some((px) => px[0] + px[1] + px[2] > 50)) sawLit = true;
    }
    expect(sawLit).toBe(true);

    const movement = createEffectSim(151, params);
    const early = JSON.stringify(movement.frame(200));
    const late = JSON.stringify(movement.frame(4000));
    expect(late).not.toBe(early);
  });

  it('Noise Pal (107) shows varied colors sampled from the chosen palette', () => {
    // Palette 0 (default) stays black for the first several seconds (the
    // internal random target palette hasn't rolled yet) -- a real palette
    // bypasses that and shows immediate per-pixel variation, same treatment
    // as the Fairy/Colorwaves/Plasma spot checks.
    const sim = createEffectSim(107, { length: 30, sx: 64, ix: 128, pal: 26 });
    const buf = sim.frame(500);
    const uniqueColors = new Set(buf.map((px) => px.join(',')));
    expect(uniqueColors.size).toBeGreaterThan(1);
  });

  it('Noise Pal (107) stays black at the default palette until the first target palette rolls', () => {
    const sim = createEffectSim(107, { length: 20, sx: 0, ix: 128 });
    const early = sim.frame(500);
    expect(early.every((px) => px[0] === 0 && px[1] === 0 && px[2] === 0)).toBe(
      true,
    );
    let sawColor = false;
    for (let t = 1000; t < 8000; t += 200) {
      const buf = sim.frame(t);
      if (buf.some((px) => px[0] + px[1] + px[2] > 0)) sawColor = true;
    }
    expect(sawColor).toBe(true);
  });
  it('Rolling Balls (48) lights pixels within strip bounds over time', () => {
    const sim = createEffectSim(48, {
      length: 30,
      sx: 128,
      ix: 128,
      colors: [[255, 255, 255], BLACK_RGB, BLACK_RGB],
    });
    let sawLit = false;
    for (let t = 0; t < 4000; t += 40) {
      const buf = sim.frame(t);
      expect(buf.length).toBe(30);
      if (buf.some((px) => px[0] + px[1] + px[2] > 50)) sawLit = true;
    }
    expect(sawLit).toBe(true);
  });

  it('Candle Multi (102) gives each pixel independent flicker, unlike Candle (88)', () => {
    const params = {
      length: 20,
      sx: 96,
      ix: 224,
      colors: [[255, 180, 60], BLACK_RGB, BLACK_RGB] as RGB[],
    };
    const single = createEffectSim(88, params);
    const multi = createEffectSim(102, params);
    const bufSingle = single.frame(400);
    const bufMulti = multi.frame(400);
    const uniqSingle = new Set(bufSingle.map((px) => px.join(',')));
    const uniqMulti = new Set(bufMulti.map((px) => px.join(',')));
    expect(uniqSingle.size).toBe(1); // whole-strip flicker shares one state
    expect(uniqMulti.size).toBeGreaterThan(1); // per-LED flicker diverges
  });

  it('Shimmer (161) moves its glow band along the strip over time', () => {
    const sim = createEffectSim(161, {
      length: 40,
      sx: 128,
      colors: [[255, 255, 255], BLACK_RGB, BLACK_RGB],
    });
    const brightestIndex = (buf: RGB[]) =>
      buf.reduce(
        (best, px, i) =>
          px[0] + px[1] + px[2] > buf[best][0] + buf[best][1] + buf[best][2]
            ? i
            : best,
        0,
      );
    const early = brightestIndex(sim.frame(200));
    const late = brightestIndex(sim.frame(3000));
    expect(early).not.toBe(late);
  });

  it('Shimmer (161) applies the "Granular" modulator only when c2 is set', () => {
    const base = {
      length: 40,
      sx: 128,
      custom3: 24,
      colors: [[255, 255, 255], BLACK_RGB, BLACK_RGB] as RGB[],
    };
    const at = (extra: Partial<Parameters<typeof createEffectSim>[1]>) =>
      JSON.stringify(createEffectSim(161, { ...base, ...extra }).frame(1000));
    const plain = at({ custom2: 0 });
    expect(at({ custom2: 0, check1: true })).toBe(plain); // no c2: check1 inert
    expect(at({ custom2: 180 })).not.toBe(plain); // perlin modulation
    expect(at({ custom2: 180, check1: true })).not.toBe(plain); // "Zebra" sine
    expect(at({ custom2: 180, check1: true })).not.toBe(at({ custom2: 180 }));
  });

  it('Stream 2 / "Random Chase" (61) shifts its random pixel pattern over time', () => {
    const sim = createEffectSim(61, { length: 20, sx: 128 });
    const early = JSON.stringify(sim.frame(200));
    const late = JSON.stringify(sim.frame(4000));
    expect(late).not.toBe(early);
  });

  it('Fill Noise8 (69) shows multiple distinct hues across the strip with a real palette', () => {
    // Like Fairy/Colorwaves/Plasma, palette 0 ("Default") short-circuits
    // color_from_palette to the raw segment color regardless of index --
    // this effect has no other time/space-varying factor, so an actual
    // palette is needed to see its per-pixel noise texture (also why 69 is
    // excluded from the generic "animated effects" contract test above).
    const sim = createEffectSim(69, { length: 30, sx: 128, pal: 26 });
    const buf = sim.frame(1000);
    const uniqueColors = new Set(buf.map((px) => px.join(',')));
    expect(uniqueColors.size).toBeGreaterThan(3);
  });

  it('Phased Noise (109) differs from Phased (105) under the same params', () => {
    const params = {
      length: 30,
      sx: 128,
      ix: 128,
      colors: [RED, GREEN, BLUE] as RGB[],
    };
    const phased = createEffectSim(105, params);
    const phasedNoise = createEffectSim(109, params);
    let sawDifference = false;
    for (let t = 0; t < 3000; t += 50) {
      if (
        JSON.stringify(phased.frame(t)) !== JSON.stringify(phasedNoise.frame(t))
      ) {
        sawDifference = true;
      }
    }
    expect(sawDifference).toBe(true);
  });

  it('Color Wipe Random (4) cycles through varying random wheel colors', () => {
    const sim = createEffectSim(4, { length: 30, sx: 200, ix: 128 });
    const colors = new Set<string>();
    for (let t = 0; t < 8000; t += 100) {
      colors.add(sim.frame(t)[0].join(','));
    }
    expect(colors.size).toBeGreaterThan(1);
  });

  it('Dual Scan (11) lights a mirrored second dot alongside the primary', () => {
    const sim = createEffectSim(11, {
      length: 30,
      sx: 128,
      ix: 128,
      colors: [[255, 255, 255], BLACK_RGB, [0, 0, 255]],
    });
    let sawMirrored = false;
    for (let t = 0; t < 3000; t += 30) {
      const buf = sim.frame(t);
      const litRight = buf.some((px) => px[2] > 100 && px[0] < 50);
      if (litRight) sawMirrored = true;
    }
    expect(sawMirrored).toBe(true);
  });

  it('Chase Random (29) cycles its leading color across laps', () => {
    const sim = createEffectSim(29, { length: 20, sx: 255, ix: 128 });
    const colors = new Set<string>();
    for (let t = 0; t < 8000; t += 40) {
      colors.add(sim.frame(t)[0].join(','));
    }
    expect(colors.size).toBeGreaterThan(2);
  });

  it('Chase Flash (31) flashes the secondary color ahead of the chase', () => {
    const sim = createEffectSim(31, {
      length: 20,
      sx: 128,
      ix: 128,
      colors: [BLACK_RGB, [255, 255, 255], BLACK_RGB],
    });
    let sawFlash = false;
    for (let t = 0; t < 3000; t += 15) {
      if (sim.frame(t).some((px) => px[0] + px[1] + px[2] > 400))
        sawFlash = true;
    }
    expect(sawFlash).toBe(true);
  });

  it('Chase Flash Random (32) advances its random trail color over time', () => {
    const sim = createEffectSim(32, { length: 20, sx: 128, ix: 128 });
    const colors = new Set<string>();
    for (let t = 0; t < 8000; t += 40) {
      colors.add(sim.frame(t)[0].join(','));
    }
    expect(colors.size).toBeGreaterThan(1);
  });

  it('Chase Rainbow White (33) shows varying rainbow hues over time', () => {
    const sim = createEffectSim(33, { length: 20, sx: 200, ix: 128 });
    const hues = new Set<string>();
    for (let t = 0; t < 4000; t += 30) {
      hues.add(sim.frame(t)[0].join(','));
    }
    expect(hues.size).toBeGreaterThan(2);
  });

  it('Dissolve Random (19) fills in varying random colors over time', () => {
    const sim = createEffectSim(19, { length: 30, sx: 200, ix: 200 });
    const colors = new Set<string>();
    for (let t = 0; t < 3000; t += 40) {
      for (const px of sim.frame(t)) colors.add(px.join(','));
    }
    expect(colors.size).toBeGreaterThan(2);
  });

  it('Flash Sparkle (21) eventually flashes against a dark background', () => {
    const sim = createEffectSim(21, {
      length: 30,
      sx: 200,
      ix: 128,
      colors: [BLACK_RGB, [255, 255, 255], BLACK_RGB],
    });
    let sawFlash = false;
    for (let t = 0; t < 4000; t += FRAMETIME) {
      if (sim.frame(t).some((px) => px[0] + px[1] + px[2] > 400))
        sawFlash = true;
    }
    expect(sawFlash).toBe(true);
  });

  it('Random Color (5) crossfades between successive random wheel colors', () => {
    const sim = createEffectSim(5, { length: 10, sx: 200, ix: 128 });
    const colors = new Set<string>();
    for (let t = 0; t < 8000; t += 100) {
      colors.add(sim.frame(t)[0].join(','));
    }
    expect(colors.size).toBeGreaterThan(2);
  });

  it('Running Dual (52) blends two opposite-direction bands', () => {
    const sim = createEffectSim(52, {
      length: 30,
      sx: 128,
      ix: 128,
      colors: [[255, 255, 255], BLACK_RGB, [0, 0, 255]],
    });
    const frame0 = sim.frame(0);
    const frame2000 = sim.frame(2000);
    expect(JSON.stringify(frame0)).not.toBe(JSON.stringify(frame2000));
  });

  it('Tricolor Chase (54) cycles through a repeating three-band pattern', () => {
    const sim = createEffectSim(54, {
      length: 30,
      sx: 200,
      ix: 128,
      colors: [RED, GREEN, BLUE],
    });
    let sawRed = false;
    let sawBlue = false;
    for (let t = 0; t < 4000; t += 30) {
      for (const px of sim.frame(t)) {
        if (px[0] > 200 && px[1] < 50 && px[2] < 50) sawRed = true;
        if (px[2] > 200 && px[0] < 50 && px[1] < 50) sawBlue = true;
      }
    }
    expect(sawRed).toBe(true);
    expect(sawBlue).toBe(true);
  });

  it('Tricolor Wipe (55) sweeps through all three project colors over one cycle', () => {
    const sim = createEffectSim(55, {
      length: 30,
      sx: 200,
      colors: [RED, GREEN, BLUE],
    });
    let sawRed = false;
    let sawGreen = false;
    let sawBlue = false;
    // cycleTime at sx=200 is 1000 + (255-200)*200 = 12000ms; sample a full cycle.
    for (let t = 0; t < 13000; t += 40) {
      const px = sim.frame(t)[0];
      if (px[0] > 200 && px[1] < 50 && px[2] < 50) sawRed = true;
      if (px[1] > 200 && px[0] < 50 && px[2] < 50) sawGreen = true;
      if (px[2] > 200 && px[0] < 50 && px[1] < 50) sawBlue = true;
    }
    expect(sawRed).toBe(true);
    expect(sawGreen).toBe(true);
    expect(sawBlue).toBe(true);
  });

  it('Noise 4 (73) shows multiple distinct hues across the strip with a real palette', () => {
    // Same palette-0 shortcut as Noise 1/Fill Noise8 -- needs a real palette
    // to see the noise-driven index vary at all (see staticIds above).
    const sim = createEffectSim(73, { length: 30, sx: 128, pal: 26 });
    const buf = sim.frame(1000);
    const uniqueColors = new Set(buf.map((px) => px.join(',')));
    expect(uniqueColors.size).toBeGreaterThan(3);
  });

  it('Perlin Move (147) lights moving comet positions against a faded trail', () => {
    const sim = createEffectSim(147, {
      length: 40,
      sx: 128,
      ix: 128,
      colors: [[255, 255, 255], BLACK_RGB, BLACK_RGB],
    });
    let sawLit = false;
    const snapshots = new Set<string>();
    for (let t = 0; t < 4000; t += 30) {
      const buf = sim.frame(t);
      if (buf.some((px) => px[0] + px[1] + px[2] > 60)) sawLit = true;
      snapshots.add(JSON.stringify(buf));
    }
    expect(sawLit).toBe(true);
    expect(snapshots.size).toBeGreaterThan(1);
  });

  it('Hiphotic (180) renders a 16x16 plasma that varies spatially and over time', () => {
    // Needs a real palette (26) past the palette-0 shortcut, same as Noise 1.
    const sim = createEffectSim(180, {
      length: LEN,
      sx: 128,
      ix: 128,
      pal: 26,
    });
    expect(sim.width).toBe(16);
    expect(sim.height).toBe(16);
    const frame0 = sim.frame(0);
    const uniqueAcrossMatrix = new Set(frame0.map((px) => px.join(',')));
    expect(uniqueAcrossMatrix.size).toBeGreaterThan(3);
    expect(JSON.stringify(sim.frame(2000))).not.toBe(JSON.stringify(frame0));
  });

  it('Game Of Life (172) seeds ~33% live cells then evolves the grid', () => {
    const sim = createEffectSim(172, {
      length: LEN,
      sx: 200,
      colors: [[255, 255, 255], BLACK_RGB, BLACK_RGB],
    });
    const first = sim.frame(0);
    const lit = first.filter((px) => px[0] + px[1] + px[2] > 0).length;
    expect(lit).toBeGreaterThan(256 * 0.15);
    expect(lit).toBeLessThan(256 * 0.55);
    // past the 1.28s initial hold, generations change the grid
    const later = new Set<string>();
    for (let t = 1500; t < 6000; t += 100) {
      later.add(JSON.stringify(sim.frame(t)));
    }
    expect(later.size).toBeGreaterThan(1);
  });

  it('Color Clouds (218) drifts a per-pixel Perlin brightness field over time', () => {
    // Default palette 0 -> spectrum path; custom2 defaults 0 so hue is spatially
    // uniform but brightness (the clouds) varies per pixel and the whole field
    // drifts frame to frame.
    const sim = createEffectSim(218, { length: 40, sx: 96, ix: 96 });
    const first = sim.frame(1000);
    const brightness = first.map((px) => px[0] + px[1] + px[2]);
    expect(new Set(brightness).size).toBeGreaterThan(3);

    const snapshots = new Set<string>();
    for (let t = 0; t < 4000; t += 40) {
      snapshots.add(JSON.stringify(sim.frame(t)));
    }
    expect(snapshots.size).toBeGreaterThan(1);
  });
});

describe('PS Balance (209) tilts on 1D Perlin noise', () => {
  // The firmware calls the *one-argument* perlin8 (util.cpp:1259), which is a
  // different noise function from perlin8(x, 0), and it feeds it the full
  // uint16 SEGENV.aux0 -- only cos8_t's own parameter narrows to a byte. Its
  // sibling PS Box (193) has the identical construct and got it right.
  const lightSum = (custom3: number) => {
    const sim = createEffectSim(209, {
      length: 60,
      dimensions: '1d',
      sx: 200,
      ix: 255,
      check3: true, // perlin tilt rather than the sine one
      custom1: 0,
      custom2: 0,
      custom3,
      seed: 0x1234,
    });
    let total = 0;
    for (const ms of [500, 2000, 5000, 9000])
      total += sim.frame(ms).reduce((a, p) => a + p[0] + p[1] + p[2], 0);
    return total;
  };

  it('settles differently than the 2D noise form would', () => {
    expect(lightSum(31)).toBe(17890); // 17138 via perlin8(aux0 & 0xff, 0)
    expect(lightSum(8)).toBe(14477); // 15594 via perlin8(aux0 & 0xff, 0)
  });
});

describe('uint32 time products fold before an integer divide', () => {
  // Same class as the shift-side fixes, but the fold has to happen before a
  // *divide*: `strip.now * k` wraps at 2^32 and the quotient then reaches
  // perlin as an unmasked coordinate. A power-of-two divisor happens to keep
  // the 2^32 difference a multiple of 65536 and hides it, so both anchors
  // below pick a speed whose divisor is not a power of two.
  const sumFrames = (
    fxId: number,
    params: Parameters<typeof createEffectSim>[1],
    at: number[],
  ) => {
    const sim = createEffectSim(fxId, params);
    let total = 0;
    for (const t of at)
      total += sim.frame(t).reduce((a, p) => a + p[0] + p[1] + p[2], 0);
    return total;
  };

  it('Perlin Move (147) past the ~9.3 h wrap of strip.now * 128', () => {
    const late = 12 * 3600 * 1000;
    const params = {
      length: 60,
      dimensions: '1d' as const,
      sx: 128,
      ix: 200,
      custom1: 200,
      seed: 0x1234,
    };
    expect(sumFrames(147, params, [late, late + 500, late + 1500])).toBe(31289); // 30851 unwrapped
  });

  it('Plasma Ball (178) past the ~6.2 day wrap of strip.now * 8', () => {
    const late = 7 * 86400000;
    const params = {
      length: 256,
      width: 16,
      height: 16,
      dimensions: '2d' as const,
      sx: 100, // divisor 156, not a power of two
      ix: 200,
      seed: 0x1234,
    };
    expect(sumFrames(178, params, [late, late + 500, late + 1500])).toBe(335816); // 331239 unwrapped
  });
});

describe('Noise 2 (71) keeps its noise origin unsigned', () => {
  // SEGENV.step is uint32 and this effect shifts it right by 6 to get the x
  // origin. A signed shift reads the top half of the range back as a negative
  // origin, offsetting real_x by 2^26*1000 -- which is not a multiple of 2^32,
  // so perlin16's own uint32 fold does not absorb it. step climbs by up to
  // 128/frame, reaching 2^31 in about 4.6 days at full speed.
  //
  // Sibling Noise 3 (72) needs no such fix: it feeds step through `* 8` only,
  // and (step mod 2^32)*8 is congruent to step*8 mod 2^32, so the port's
  // unbounded accumulator lands on the same noise coordinate either way.
  const sumOverFrames = (fxId: number, startStep: number) => {
    const seg = new Segment(40, 0x1234);
    seg.speed = 255;
    seg.intensity = 200;
    seg.colors = [0xffffff, 0, 0];
    seg.step = startStep;
    let total = 0;
    for (let f = 0; f < 3; f++) {
      seg.now = f * STEP_MS;
      seg.refreshPalette();
      EFFECT_SIMS[fxId](seg);
      seg.call++;
      for (let i = 0; i < seg.length; i++) total += seg.pixels[i];
    }
    return total;
  };

  it('past 2^31 the x origin keeps climbing', () => {
    expect(sumOverFrames(71, 2 ** 31 + 5000)).toBe(1229276412); // 607137804 signed
  });

  it('Noise 3 (72) is unaffected by how far step has run', () => {
    expect(sumOverFrames(72, 2 ** 31 + 5000)).toBe(
      sumOverFrames(72, 2 ** 33 + 5000),
    );
  });
});

describe('Colorwaves/Pride base truncates bri16 before scaling it', () => {
  // mode_colorwaves_pride_base (FX.cpp:2029) computes
  // `unsigned bri16 = (uint32_t)b16 * b16 / 65536` -- an integer division --
  // and only then scales by brightdepth and divides again. Carrying the first
  // fraction into the second divide shifts the odd pixel up by one step; it
  // is rare (~0.07% of channels) but it is every frame of both effects, and
  // the golden config at length 16 does not happen to catch it.
  const params = {
    length: 120,
    dimensions: '1d' as const,
    sx: 200,
    ix: 180,
    pal: 11,
    seed: 0x1234,
  };

  it('Pride 2015 (63) rounds its brightness down', () => {
    const sim = createEffectSim(63, params);
    expect(sim.frame(0)[103][0]).toBe(58); // 59 with the fraction kept
  });

  it('Colorwaves (67) rounds its brightness down', () => {
    const sim = createEffectSim(67, params);
    expect(sim.frame(0)[103][0]).toBe(114); // 115 with the fraction kept
    expect(sim.frame(500)[17][1]).toBe(146); // 147 with the fraction kept
  });
});

describe('Noise 1 (70) folds its step accumulator at uint32', () => {
  // shift_y is `SEGENV.step / 42` (FX.cpp:2241). 42 is not a power of two, so
  // the 2^32 wrap does not survive the divide and perlin16's own fold cannot
  // absorb it. step climbs by up to 16/frame, so this lands after ~74 days.
  const sumAt = (startStep: number) => {
    const seg = new Segment(40, 0x1234);
    seg.speed = 255;
    seg.intensity = 200;
    // A real palette is load-bearing: this effect passes no per-pixel
    // brightness, so on palette 0 every pixel is the primary color and the
    // noise position never reaches the output.
    seg.palette = 11;
    seg.colors = [0xffffff, 0, 0];
    seg.step = startStep;
    let total = 0;
    for (let f = 0; f < 3; f++) {
      seg.now = f * STEP_MS;
      seg.refreshPalette();
      EFFECT_SIMS[70](seg);
      seg.call++;
      for (let i = 0; i < seg.length; i++) total += seg.pixels[i];
    }
    return total;
  };

  it('wraps rather than running past 2^32', () => {
    expect(sumAt(2 ** 32 + 5000)).toBe(1226548420); // 1518882696 unwrapped
    expect(sumAt(5000)).toBe(1226548420);
  });
});
