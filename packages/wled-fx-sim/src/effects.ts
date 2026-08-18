// SPDX-License-Identifier: EUPL-1.2
// Ported from WLED v16.0.0 (commit 4374f01) wled00/FX.cpp mode_* bodies.
// Copyright (c) 2016-present Christian Schwinne and individual WLED contributors
/**
 * Ported WLED 1D effect bodies (wled00/FX.cpp, tag v16.0.0), keyed by real fx
 * id. Each is a pure function of a Segment's inputs + scratch state, matching
 * the firmware logic line-for-line (motion, timing, palette use) at perceptual
 * accuracy -- not frame-parity with the device (decisions.md, 2026-07-03).
 *
 * All randomness routes through seg.rng (WLED's on-device hw_random is
 * non-deterministic; the sim seeds a PRNG so a preview is reproducible).
 * `strip.now` -> seg.now, SEGENV.* -> seg.*, SEGLEN -> seg.length,
 * SEGCOLOR(x) -> seg.color(x), FRAMETIME -> the 42fps firmware default.
 */
import { Segment } from './segment.js';
import { Segment2D } from './segment-2d.js';
import {
  LINEARBLEND,
  LINEARBLEND_NOWRAP,
  NOBLEND,
  PRNG,
  averageLight,
  beat16,
  beat8,
  beatsin16_t,
  beatsin88_t,
  beatsin8_t,
  colorFromPalette,
  color_add,
  color_blend,
  color_fade,
  lerp8by8,
  cos_approx,
  cubicwave8,
  gamma32inv,
  gamma8,
  gamma8inv,
  hsv2rgb_rainbow,
  hsv2rgb_spectrum,
  beat88,
  inoise8,
  perlin8,
  qadd8,
  qsub8,
  quadwave8,
  rgbw32,
  scale16,
  scale8,
  scale8_video,
  sin_approx,
  cos8_t as cos8,
  cos16_t as cos16,
  ease8InOutCubic,
  sin16_t as sin16,
  sin8_t as sin8,
  triwave16,
  triwave8,
  inoise16,
  inoise16xy,
  unpack,
  R,
  G,
  B,
  type RGB,
} from './lib8.js';
import { fillGradient, nblendPaletteTowardPalette } from './palettes.js';
import { sampleSyntheticAudio } from './audio-fixture.js';
import {
  initParticleSystem1D,
  getParticleSystem1D,
  newPSsettings1D,
  PS_P_RADIUS_1D,
  type ParticleSystem1D,
} from './particles-1d.js';
import {
  initParticleSystem2D,
  getParticleSystem2D,
  newPSsettings2D,
  PS_P_RADIUS,
  PS_P_HALFRADIUS as PS_P_HALFRADIUS_2D,
  type ParticleSystem2D,
} from './particles-2d.js';

/** WLED's default frame interval (FRAMETIME_FIXED = 1000/42). */
export const FRAMETIME = Math.trunc(1000 / 42); // 23

const WHITE = 0xffffff;
const BLACK = 0x000000;

/** Arduino map(): integer, truncating. */
function map(
  x: number,
  inMin: number,
  inMax: number,
  outMin: number,
  outMax: number,
): number {
  const d = inMax - inMin;
  return (
    Math.trunc(((x - inMin) * (outMax - outMin)) / (d === 0 ? 1 : d)) + outMin
  );
}

/** WLED mapf(): the float form of map(), no truncation -- wled_math.cpp. */
function mapf(
  x: number,
  inMin: number,
  inMax: number,
  outMin: number,
  outMax: number,
): number {
  const d = inMax - inMin;
  return ((x - inMin) * (outMax - outMin)) / (d === 0 ? 1 : d) + outMin;
}

/** SEGLEN<=1 fallback -- FX_FALLBACK_STATIC. */
function fallbackStatic(seg: Segment): void {
  seg.fill(seg.color(0));
}

/** New random wheel index at least 42 apart from `pos` -- util.cpp get_random_wheel_index. */
function getRandomWheelIndex(seg: Segment, pos: number): number {
  let r: number;
  let d: number;
  do {
    r = seg.rng.random8();
    const x = Math.abs(pos - r);
    const y = 255 - x;
    d = Math.min(x, y);
  } while (d < 42);
  return r;
}

// --- Solid (0) --------------------------------------------------------------
function modeStatic(seg: Segment): void {
  seg.fill(seg.color(0));
}

// --- Blink / Strobe helper (1, 23) ------------------------------------------
function blink(
  seg: Segment,
  color1: number,
  color2: number,
  strobe: boolean,
  doPalette: boolean,
): void {
  let cycleTime = (255 - seg.speed) * 20;
  let onTime = FRAMETIME;
  if (!strobe) onTime += (cycleTime * seg.intensity) >> 8;
  cycleTime += FRAMETIME * 2;
  const it = Math.trunc(seg.now / cycleTime);
  const rem = seg.now % cycleTime;

  const on = it !== seg.step || rem <= onTime;
  seg.step = it;

  const color = on ? color1 : color2;
  if (color === color1 && doPalette) {
    for (let i = 0; i < seg.length; i++) {
      seg.setPixelColor(i, seg.color_from_palette(i, true, false, 0));
    }
  } else {
    seg.fill(color);
  }
}

function modeBlink(seg: Segment): void {
  blink(seg, seg.color(0), seg.color(1), false, true);
}

function modeStrobe(seg: Segment): void {
  blink(seg, seg.color(0), seg.color(1), true, true);
}

// --- Blink Rainbow (26) / Strobe Rainbow (24) --------------------------------
// Both are one-liners over the same shared blink() helper: color1 cycles
// through the rainbow via seg.call (WLED's SEGENV.call, a per-step counter)
// instead of holding a fixed segment color.
function modeBlinkRainbow(seg: Segment): void {
  blink(seg, seg.color_wheel(seg.call & 0xff), seg.color(1), false, false);
}

function modeStrobeRainbow(seg: Segment): void {
  blink(seg, seg.color_wheel(seg.call & 0xff), seg.color(1), true, false);
}

// --- Breathe (2) ------------------------------------------------------------
function modeBreath(seg: Segment): void {
  let counter = (seg.now * ((seg.speed >> 3) + 10)) & 0xffff;
  counter = (counter >> 2) + (counter >> 4);
  let varr = 0;
  if (counter < 16384) {
    if (counter > 8192) counter = 8192 - (counter - 8192);
    // sin16_t via the exported primitive; parabola-ish 0..~23170
    varr = Math.trunc(sin16(counter) / 103);
  }
  const lum = 30 + varr;
  for (let i = 0; i < seg.length; i++) {
    seg.setPixelColor(
      i,
      color_blend(
        seg.color(1),
        seg.color_from_palette(i, true, false, 0),
        lum & 0xff,
      ),
    );
  }
}

// --- Wipe (3) / Sweep (6) / Wipe Random (4) / Sweep Random (36) -------------
function colorWipe(seg: Segment, rev: boolean, useRandomColors = false): void {
  if (seg.length <= 1) return fallbackStatic(seg);
  const cycleTime = 750 + (255 - seg.speed) * 150;
  const perc = seg.now % cycleTime;
  let prog = Math.trunc((perc * 65535) / cycleTime);
  const back = prog > 32767;
  if (back) {
    prog -= 32767;
    if (seg.step === 0) seg.step = 1;
  } else {
    if (seg.step === 2) seg.step = 3;
  }

  if (useRandomColors) {
    if (seg.call === 0) {
      seg.aux0 = seg.rng.random8();
      seg.step = 3;
    }
    if (seg.step === 1) {
      seg.aux1 = getRandomWheelIndex(seg, seg.aux0);
      seg.step = 2;
    }
    if (seg.step === 3) {
      seg.aux0 = getRandomWheelIndex(seg, seg.aux1);
      seg.step = 0;
    }
  }

  const ledIndex = (prog * seg.length) >> 15;
  let rem = (prog * seg.length * 2) & 0xffff;
  rem = Math.trunc(rem / (seg.intensity + 1));
  if (rem > 255) rem = 255;

  const col1 = useRandomColors ? seg.color_wheel(seg.aux1) : seg.color(1);
  for (let i = 0; i < seg.length; i++) {
    const index = rev && back ? seg.length - 1 - i : i;
    const col0 = useRandomColors
      ? seg.color_wheel(seg.aux0)
      : seg.color_from_palette(index, true, false, 0);
    if (i < ledIndex) {
      seg.setPixelColor(index, back ? col1 : col0);
    } else {
      seg.setPixelColor(index, back ? col0 : col1);
      if (i === ledIndex) {
        seg.setPixelColor(
          index,
          color_blend(back ? col0 : col1, back ? col1 : col0, rem & 0xff),
        );
      }
    }
  }
}

function modeColorWipe(seg: Segment): void {
  colorWipe(seg, false);
}

function modeColorSweep(seg: Segment): void {
  colorWipe(seg, true);
}

function modeColorWipeRandom(seg: Segment): void {
  colorWipe(seg, false, true);
}

function modeColorSweepRandom(seg: Segment): void {
  colorWipe(seg, true, true);
}

// --- Colorloop (8, mode_rainbow) --------------------------------------------
function modeRainbow(seg: Segment): void {
  let counter = (seg.now * ((seg.speed >> 2) + 2)) & 0xffff;
  counter = counter >> 8;
  if (seg.intensity < 128) {
    seg.fill(
      color_blend(
        seg.color_wheel(counter),
        WHITE,
        (128 - seg.intensity) & 0xff,
      ),
    );
  } else {
    seg.fill(seg.color_wheel(counter));
  }
}

// --- Rainbow (9, mode_rainbow_cycle) ----------------------------------------
function modeRainbowCycle(seg: Segment): void {
  let counter = (seg.now * ((seg.speed >> 2) + 2)) & 0xffff;
  counter = counter >> 8;
  for (let i = 0; i < seg.length; i++) {
    const index =
      (Math.trunc((i * (16 << Math.trunc(seg.intensity / 29))) / seg.length) +
        counter) &
      0xff;
    seg.setPixelColor(i, seg.color_wheel(index));
  }
}

// --- Scan (10) / Scan Dual (11) ----------------------------------------------
function scanBase(seg: Segment, dual: boolean): void {
  if (seg.length <= 1) return fallbackStatic(seg);
  const cycleTime = 750 + (255 - seg.speed) * 150;
  const perc = seg.now % cycleTime;
  const prog = Math.trunc((perc * 65535) / cycleTime);
  const size = 1 + ((seg.intensity * seg.length) >> 9);
  const ledIndex = (prog * (seg.length * 2 - size * 2)) >> 16;

  if (!seg.check2) seg.fill(seg.color(1));

  let ledOffset = ledIndex - (seg.length - size);
  ledOffset = Math.abs(ledOffset);

  if (dual) {
    const mcol = seg.color(2) ? 2 : 0;
    for (let j = ledOffset; j < ledOffset + size; j++) {
      const i2 = seg.length - 1 - j;
      seg.setPixelColor(i2, seg.color_from_palette(i2, true, false, mcol));
    }
  }

  for (let j = ledOffset; j < ledOffset + size; j++) {
    seg.setPixelColor(j, seg.color_from_palette(j, true, false, 0));
  }
}

function modeScan(seg: Segment): void {
  scanBase(seg, false);
}

function modeDualScan(seg: Segment): void {
  scanBase(seg, true);
}

// --- Fade (12) --------------------------------------------------------------
function modeFade(seg: Segment): void {
  const counter = seg.now * ((seg.speed >> 3) + 10);
  const lum = triwave16(counter & 0xffff) >> 8;
  for (let i = 0; i < seg.length; i++) {
    seg.setPixelColor(
      i,
      color_blend(
        seg.color(1),
        seg.color_from_palette(i, true, false, 0),
        lum & 0xff,
      ),
    );
  }
}

// --- Theater (13) / Running (15) shared "running" helper --------------------
function running(
  seg: Segment,
  color1: number,
  color2: number,
  theatre: boolean,
): void {
  const width = (theatre ? 3 : 1) + (seg.intensity >> 4);
  const cycleTime = 50 + (255 - seg.speed);
  const it = Math.trunc(seg.now / cycleTime);
  const usePalette = color1 === seg.color(0);

  for (let i = 0; i < seg.length; i++) {
    let col = color2;
    const c1 = usePalette ? seg.color_from_palette(i, true, false, 0) : color1;
    if (theatre) {
      if (i % width === seg.aux0) col = c1;
    } else {
      const pos = i % (width << 1);
      if (pos < seg.aux0 - width || (pos >= seg.aux0 && pos < seg.aux0 + width))
        col = c1;
    }
    seg.setPixelColor(i, col);
  }

  if (it !== seg.step) {
    seg.aux0 = (seg.aux0 + 1) % (theatre ? width : width << 1);
    seg.step = it;
  }
}

function modeTheaterChase(seg: Segment): void {
  running(seg, seg.color(0), seg.color(1), true);
}

// --- Theater Rainbow (14, mode_theater_chase_rainbow) -----------------------
function modeTheaterChaseRainbow(seg: Segment): void {
  running(seg, seg.color_wheel(seg.step), seg.color(1), true);
}

// --- Running (15, mode_running_lights via running_base, saw=false) ----------
function modeRunningLights(seg: Segment): void {
  const xScale = seg.intensity >> 2;
  const counter = (seg.now * seg.speed) >> 9;
  for (let i = 0; i < seg.length; i++) {
    const a = i * xScale - counter;
    const s = sin8(a & 0xff);
    seg.setPixelColor(
      i,
      color_blend(seg.color(1), seg.color_from_palette(i, true, false, 0), s),
    );
  }
}

// --- Twinkle (17) -----------------------------------------------------------
function modeTwinkle(seg: Segment): void {
  seg.fade_out(224);
  const cycleTime = 20 + (255 - seg.speed) * 5;
  const it = Math.trunc(seg.now / cycleTime);
  if (it !== seg.step) {
    const maxOn = map(seg.intensity, 0, 255, 1, seg.length);
    if (seg.aux0 >= maxOn) {
      seg.aux0 = 0;
      seg.aux1 = seg.rng.random16();
    }
    seg.aux0++;
    seg.step = it;
  }

  let prng16 = seg.aux1 & 0xffff;
  for (let i = 0; i < seg.aux0; i++) {
    prng16 = (prng16 * 2053 + 13849) & 0xffff;
    const j = Math.trunc((seg.length * prng16) / 65536);
    seg.setPixelColor(j, seg.color_from_palette(j, true, false, 0));
  }
}

// --- Dissolve (18) / Dissolve Random (19) shared "dissolve" helper ----------
function dissolveImpl(seg: Segment, color: number): void {
  const buf = seg.allocateData(seg.length * 4);
  const px = new Uint32Array(buf.buffer, buf.byteOffset, seg.length);

  if (seg.call === 0) {
    for (let i = 0; i < seg.length; i++) px[i] = seg.color(1) >>> 0;
    seg.aux0 = 1;
  }

  for (let j = 0; j <= Math.trunc(seg.length / 15); j++) {
    if (seg.rng.random8() <= seg.intensity) {
      for (let times = 0; times < 10; times++) {
        const i = seg.rng.random16(seg.length);
        if (seg.aux0) {
          if (px[i] === seg.color(1) >>> 0) {
            let c =
              color === seg.color(0)
                ? seg.color_from_palette(i, true, false, 0)
                : color;
            if (seg.check2 && c === seg.color(1)) c = (c ^ 1) >>> 0;
            px[i] = c >>> 0;
            break;
          }
        } else if (px[i] !== seg.color(1) >>> 0) {
          px[i] = seg.color(1) >>> 0;
          break;
        }
      }
    }
  }

  let incompletePixels = 0;
  for (let i = 0; i < seg.length; i++) {
    seg.setPixelColor(i, px[i]);
    if (seg.check2) {
      if (seg.aux0) {
        if (px[i] === seg.color(1) >>> 0) incompletePixels++;
      } else if (px[i] !== seg.color(1) >>> 0) {
        incompletePixels++;
      }
    }
  }

  if (seg.step > 255 - seg.speed + 15) {
    seg.aux0 = seg.aux0 ? 0 : 1;
    seg.step = 0;
  } else if (seg.check2) {
    if (incompletePixels === 0) seg.step++;
  } else {
    seg.step++;
  }
}

function modeDissolve(seg: Segment): void {
  dissolveImpl(
    seg,
    seg.check1 ? seg.color_wheel(seg.rng.random8()) : seg.color(0),
  );
}

function modeDissolveRandom(seg: Segment): void {
  dissolveImpl(seg, seg.color_wheel(seg.rng.random8()));
}

// --- Sparkle (20) -----------------------------------------------------------
function modeSparkle(seg: Segment): void {
  if (!seg.check2) {
    for (let i = 0; i < seg.length; i++) {
      seg.setPixelColor(i, seg.color_from_palette(i, true, false, 1));
    }
  }
  const cycleTime = 10 + (255 - seg.speed) * 2;
  const it = Math.trunc(seg.now / cycleTime);
  if (it !== seg.step) {
    seg.aux0 = seg.rng.random16(seg.length);
    seg.step = it;
  }
  seg.setPixelColor(seg.aux0, seg.color(0));
}

// --- Flash Sparkle (21) / Hyper Sparkle (22) shared flash-timing base -------
// Real firmware reuses aux0/step for two different roles across frames (a
// last-flash timestamp, then a delay amount, then back) rather than adding
// fields -- ported with that exact reuse, not "cleaned up" into named state.
function sparkleFlashBase(seg: Segment, count: number): void {
  if (!seg.check2) {
    for (let i = 0; i < seg.length; i++) {
      seg.setPixelColor(i, seg.color_from_palette(i, true, false, 0));
    }
  }
  if (seg.now - seg.aux0 > seg.step) {
    if (seg.rng.random8((255 - seg.intensity) >> 4) === 0) {
      for (let i = 0; i < count; i++) {
        seg.setPixelColor(seg.rng.random16(seg.length), seg.color(1));
      }
    }
    seg.step = seg.now;
    seg.aux0 = 255 - seg.speed;
  }
}

function modeFlashSparkle(seg: Segment): void {
  sparkleFlashBase(seg, 1);
}

function modeHyperSparkle(seg: Segment): void {
  sparkleFlashBase(seg, Math.max(1, Math.trunc(seg.length / 3)));
}

// --- Chase (28) / Chase Rainbow (30) / Chase Random (29) / Rainbow White (33)
// shared "chase" helper. Real firmware reads its own `SEGMENT.mode ==
// FX_MODE_CHASE_RANDOM` inside the shared function; ported as an explicit
// `isRandom` param instead, since this sim has no SEGMENT.mode concept.
function chase(
  seg: Segment,
  color1: number,
  color2: number,
  color3: number,
  doPalette: boolean,
  isRandom = false,
): void {
  const counter = (seg.now * ((seg.speed >> 2) + 1)) & 0xffff;
  const a = (counter * seg.length) >> 16;

  if (isRandom) {
    if (a < seg.step) {
      seg.aux1 = seg.aux0;
      seg.aux0 = getRandomWheelIndex(seg, seg.aux0);
    }
    color1 = seg.color_wheel(seg.aux0);
  }
  seg.step = a;

  const size = 1 + ((seg.intensity * seg.length) >> 10);
  let b = a + size;
  if (b > seg.length) b -= seg.length;
  let c = b + size;
  if (c > seg.length) c -= seg.length;

  if (doPalette) {
    for (let i = 0; i < seg.length; i++) {
      seg.setPixelColor(i, seg.color_from_palette(i, true, false, 1));
    }
  } else {
    seg.fill(color1);
  }

  if (isRandom) {
    color1 = seg.color_wheel(seg.aux1);
    for (let i = a; i < seg.length; i++) seg.setPixelColor(i, color1);
  }

  const fillRange = (from: number, to: number, col: number) => {
    if (from < to) {
      for (let i = from; i < to; i++) seg.setPixelColor(i, col);
    } else {
      for (let i = from; i < seg.length; i++) seg.setPixelColor(i, col);
      for (let i = 0; i < to; i++) seg.setPixelColor(i, col);
    }
  };
  fillRange(a, b, color2);
  fillRange(b, c, color3);
}

function modeChaseColor(seg: Segment): void {
  chase(
    seg,
    seg.color(1),
    seg.color(2) ? seg.color(2) : seg.color(0),
    seg.color(0),
    true,
  );
}

function modeChaseRandom(seg: Segment): void {
  chase(
    seg,
    seg.color(1),
    seg.color(2) ? seg.color(2) : seg.color(0),
    seg.color(0),
    false,
    true,
  );
}

function modeChaseRainbow(seg: Segment): void {
  let colorSep = Math.trunc(256 / seg.length);
  if (colorSep === 0) colorSep = 1;
  const colorIndex = seg.call & 0xff;
  const color = seg.color_wheel((seg.step * colorSep + colorIndex) & 0xff);
  chase(seg, color, seg.color(0), seg.color(1), false);
}

function modeChaseRainbowWhite(seg: Segment): void {
  const n = seg.step;
  const m = (seg.step + 1) % seg.length;
  const color2 = seg.color_wheel(
    (Math.trunc((n * 256) / seg.length) + (seg.call & 0xff)) & 0xff,
  );
  const color3 = seg.color_wheel(
    (Math.trunc((m * 256) / seg.length) + (seg.call & 0xff)) & 0xff,
  );
  chase(seg, seg.color(0), color2, color3, false);
}

// --- Chase Flash (31) / Chase Flash Random (32) -----------------------------
const FLASH_COUNT = 4;

function modeChaseFlash(seg: Segment): void {
  if (seg.length <= 1) return fallbackStatic(seg);
  const now = seg.now;
  let advance = true;
  const flashStep = seg.aux1 % (FLASH_COUNT * 2 + 1);
  if (now < seg.step) advance = false;
  else seg.aux1++;

  for (let i = 0; i < seg.length; i++) {
    seg.setPixelColor(i, seg.color_from_palette(i, true, false, 0));
  }
  const n = seg.aux0;
  const m = (seg.aux0 + 1) % seg.length;

  let delay = 10 + Math.trunc((30 * (255 - seg.speed)) / seg.length);
  if (flashStep < FLASH_COUNT * 2) {
    if (flashStep % 2 === 0) {
      seg.setPixelColor(n, seg.color(1));
      seg.setPixelColor(m, seg.color(1));
      delay = 20;
    } else {
      delay = 30;
    }
  } else if (advance) {
    seg.aux0 = m;
  }
  if (advance) seg.step = now + delay;
}

function modeChaseFlashRandom(seg: Segment): void {
  if (seg.length <= 1) return fallbackStatic(seg);
  const now = seg.now;
  let advance = true;
  if (now < seg.step) {
    seg.call--;
    advance = false;
  }
  const flashStep = seg.call % (FLASH_COUNT * 2 + 1);

  for (let i = 0; i < seg.aux1; i++) {
    seg.setPixelColor(i, seg.color_wheel(seg.aux0));
  }

  let delay = 1 + Math.trunc((10 * (255 - seg.speed)) / seg.length);
  if (flashStep < FLASH_COUNT * 2) {
    const n = seg.aux1;
    const m = (seg.aux1 + 1) % seg.length;
    if (flashStep % 2 === 0) {
      seg.setPixelColor(n, seg.color(0));
      seg.setPixelColor(m, seg.color(0));
      delay = 20;
    } else {
      seg.setPixelColor(n, seg.color_wheel(seg.aux0));
      seg.setPixelColor(m, seg.color(1));
      delay = 30;
    }
  } else if (advance) {
    seg.aux1 = (seg.aux1 + 1) % seg.length;
    if (seg.aux1 === 0) {
      seg.aux0 = getRandomWheelIndex(seg, seg.aux0);
    }
  }
  if (advance) seg.step = now + delay;
}

// --- Running Color (37, mode_running_color) ---------------------------------
function modeRunningColor(seg: Segment): void {
  running(seg, seg.color(0), seg.color(1), false);
}

// --- Random Color (5) --------------------------------------------------------
function modeRandomColor(seg: Segment): void {
  const cycleTime = 200 + (255 - seg.speed) * 50;
  const it = Math.trunc(seg.now / cycleTime);
  const rem = seg.now % cycleTime;
  const fadedur = (cycleTime * seg.intensity) >> 8;

  let fade = 255;
  if (fadedur) {
    fade = Math.trunc((rem * 255) / fadedur);
    if (fade > 255) fade = 255;
  }

  if (seg.call === 0) {
    seg.aux0 = seg.rng.random8();
    seg.step = 2;
  }
  if (it !== seg.step) {
    seg.aux1 = seg.aux0;
    seg.aux0 = getRandomWheelIndex(seg, seg.aux0);
    seg.step = it;
  }

  seg.fill(
    color_blend(seg.color_wheel(seg.aux1), seg.color_wheel(seg.aux0), fade),
  );
}

// --- Scanner (40, mode_larson_scanner) --------------------------------------
function modeLarsonScanner(seg: Segment): void {
  if (seg.length <= 1) return fallbackStatic(seg);
  const speed = FRAMETIME * map(seg.speed, 0, 255, 96, 2);
  const pixels = Math.trunc(seg.length / speed);

  seg.fade_out(255 - seg.intensity);

  if (seg.step > seg.now) return;

  let index = seg.aux1 + pixels;
  if (pixels === 0) {
    const frames = Math.trunc(speed / seg.length);
    if (seg.step++ < frames) return;
    seg.step = 0;
    index++;
  }

  if (index > seg.length) {
    seg.aux0 = seg.aux0 ? 0 : 1;
    seg.aux1 = 0;
    if (seg.aux0 || seg.check2) seg.step = seg.now + seg.custom1 * 25;
    else seg.step = 0;
  } else {
    for (let i = seg.aux1; i < index; i++) {
      const j = seg.aux0 ? i : seg.length - 1 - i;
      const cc = seg.color_from_palette(j, true, false, 0);
      seg.setPixelColor(j, cc);
      if (seg.check1)
        seg.setPixelColor(seg.length - 1 - j, seg.color(2) ? seg.color(2) : cc);
    }
    seg.aux1 = index;
  }
}

// --- Lighthouse (41, mode_comet) --------------------------------------------
function modeComet(seg: Segment): void {
  if (seg.length <= 1) return fallbackStatic(seg);
  const counter = (seg.now * ((seg.speed >> 2) + 1)) & 0xffff;
  const index = (counter * seg.length) >> 16;
  if (seg.call === 0) seg.aux0 = index;

  seg.fade_out(seg.intensity);

  seg.setPixelColor(index, seg.color_from_palette(index, true, false, 0));
  if (index > seg.aux0) {
    for (let i = seg.aux0; i < index; i++) {
      seg.setPixelColor(i, seg.color_from_palette(i, true, false, 0));
    }
  } else if (index < seg.aux0 && index < 10) {
    for (let i = 0; i < index; i++) {
      seg.setPixelColor(i, seg.color_from_palette(i, true, false, 0));
    }
  }
  seg.aux0 = index;
}

// --- Fireworks (42, 1D) -----------------------------------------------------
function modeFireworks(seg: Segment): void {
  if (seg.length <= 1) return fallbackStatic(seg);
  const width = seg.length;
  const height = 1;

  if (seg.call === 0) {
    seg.aux0 = 0xffff;
    seg.aux1 = 0xffff;
  }
  seg.fade_out(128);

  if (!seg.step) {
    const valid1 = seg.aux0 < width * height;
    const valid2 = seg.aux1 < width * height;
    let sv1 = 0;
    let sv2 = 0;
    if (valid1) sv1 = seg.getPixelColor(seg.aux0);
    if (valid2) sv2 = seg.getPixelColor(seg.aux1);
    seg.blur(16);
    if (valid1) seg.setPixelColor(seg.aux0, sv1);
    if (valid2) seg.setPixelColor(seg.aux1, sv2);
  }

  for (let i = 0; i < Math.max(1, Math.trunc(width / 20)); i++) {
    if (seg.rng.random8(129 - (seg.intensity >> 1)) === 0) {
      const index = seg.rng.random16(width * height);
      const col = seg.color_from_palette(seg.rng.random8(), false, false, 0);
      seg.setPixelColor(index, col);
      seg.aux1 = seg.aux0;
      seg.aux0 = index;
    }
  }
}

// --- Fire 2012 (66) ---------------------------------------------------------
function modeFire2012(seg: Segment): void {
  if (seg.length <= 1) return fallbackStatic(seg);
  const heat = seg.allocateData(seg.length);
  const it = seg.now >> 5;
  const ignition = Math.max(3, Math.trunc(seg.length / 10));

  // Step 1: cool down
  for (let i = 0; i < seg.length; i++) {
    const cool =
      it !== seg.step
        ? seg.rng.random8(
            Math.trunc(((20 + Math.trunc(seg.speed / 3)) * 16) / seg.length) +
              2,
          )
        : seg.rng.random8(4);
    const minTemp = i < ignition ? Math.trunc((ignition - i) / 4) + 16 : 0;
    const temp = qsub8(heat[i], cool);
    heat[i] = temp < minTemp ? minTemp : temp;
  }

  if (it !== seg.step) {
    // Step 2: heat drifts up
    for (let k = seg.length - 1; k > 1; k--) {
      heat[k] = Math.trunc((heat[k - 1] + (heat[k - 2] << 1)) / 3);
    }
    // Step 3: ignite sparks near the bottom
    if (seg.rng.random8() <= seg.intensity) {
      const y = seg.rng.random8(ignition);
      const boost = Math.trunc(
        ((17 + seg.custom3) * (ignition - Math.trunc(y / 2))) / ignition,
      );
      heat[y] = qadd8(heat[y], seg.rng.random8(96 + 2 * boost, 207 + boost));
    }
  }

  // Step 4: map heat -> color via the segment palette
  const pal = seg.getCurrentPalette();
  for (let j = 0; j < seg.length; j++) {
    seg.setPixelColor(
      j,
      colorFromPalette(pal, Math.min(heat[j], 240), 255, NOBLEND),
    );
  }

  if (it !== seg.step) seg.step = it;
}

// --- Meteor (76) ------------------------------------------------------------
function modeMeteor(seg: Segment): void {
  if (seg.length <= 1) return fallbackStatic(seg);
  const trail = seg.allocateData(seg.length);
  const meteorSmooth = seg.check3;
  const meteorSize = 1 + Math.trunc(seg.length / 20);

  let meteorstart: number;
  if (meteorSmooth) {
    meteorstart = map((seg.step >>> 6) & 0xff, 0, 255, 0, seg.length - 1);
  } else {
    const counter = seg.now * ((seg.speed >> 2) + 8);
    meteorstart = ((counter * seg.length) >>> 0) >>> 16;
  }

  const maxv = seg.palette === 5 || !seg.check1 ? 240 : 255;

  for (let i = 0; i < seg.length; i++) {
    if (seg.rng.random8() <= 255 - seg.intensity) {
      let col: number;
      if (meteorSmooth) {
        if (trail[i] > 0) {
          // change each time between -20 and +4
          const change = trail[i] + 4 - seg.rng.random8(24);
          trail[i] = Math.max(0, Math.min(maxv, change));
        }
        col = seg.check1
          ? seg.color_from_palette(i, true, false, 0, trail[i])
          : seg.color_from_palette(trail[i], false, true, 255);
      } else {
        trail[i] = scale8(trail[i], 128 + seg.rng.random8(127));
        let index: number;
        let idx = 255;
        let bri: number;
        if (!seg.check1) {
          idx = 0;
          index = map(i, 0, seg.length, 0, maxv);
          bri = trail[i];
        } else {
          index = trail[i];
          bri = seg.palette === 35 || seg.palette === 36 ? 255 : trail[i];
        }
        col = seg.color_from_palette(index, false, false, idx, bri);
      }
      seg.setPixelColor(i, col);
    }
  }

  for (let j = 0; j < meteorSize; j++) {
    const index = (meteorstart + j) % seg.length;
    if (meteorSmooth) {
      trail[index] = maxv;
      seg.setPixelColor(
        index,
        seg.check1
          ? seg.color_from_palette(index, true, false, 0, trail[index])
          : seg.color_from_palette(trail[index], false, true, 255),
      );
    } else {
      let idx = 255;
      let ii = (trail[index] = maxv);
      if (!seg.check1) {
        ii = map(index, 0, seg.length, 0, maxv);
        idx = 0;
      }
      seg.setPixelColor(
        index,
        seg.color_from_palette(ii, false, false, idx, 255),
      );
    }
  }

  // uint32_t SEGENV.step upstream; the smooth branch's meteorstart reads it
  seg.step = (seg.step + seg.speed + 1) >>> 0;
}

// --- Glitter (87) -----------------------------------------------------------
function glitterBase(seg: Segment, intensity: number, col: number): void {
  if (intensity > seg.rng.random8())
    seg.setPixelColor(seg.rng.random16(seg.length), col);
}

function modeGlitter(seg: Segment): void {
  if (!seg.check2) {
    let counter = 0;
    if (seg.speed !== 0) {
      counter = (seg.now * ((seg.speed >> 3) + 1)) & 0xffff;
      counter = counter >> 8;
    }
    // paletteBlend default 0: noWrap only when speed == 0
    const noWrap = seg.speed === 0;
    for (let i = 0; i < seg.length; i++) {
      let colorIndex = (Math.trunc((i * 255) / seg.length) - counter) & 0xff;
      if (noWrap) colorIndex = map(colorIndex, 0, 255, 0, 240);
      seg.setPixelColor(
        i,
        seg.color_from_palette(colorIndex, false, true, 255),
      );
    }
  }
  glitterBase(seg, seg.intensity, seg.color(2) ? seg.color(2) : WHITE);
}

// --- Tri Fade (56) -----------------------------------------------------------
function modeTricolorFade(seg: Segment): void {
  const counter = (seg.now * ((seg.speed >> 3) + 1)) & 0xffff;
  const prog = (counter * 768) >> 16;

  let color1: number;
  let color2: number;
  let stage: number;
  if (prog < 256) {
    color1 = seg.color(0);
    color2 = seg.color(1);
    stage = 0;
  } else if (prog < 512) {
    color1 = seg.color(1);
    color2 = seg.color(2);
    stage = 1;
  } else {
    color1 = seg.color(2);
    color2 = seg.color(0);
    stage = 2;
  }

  const stp = prog & 0xff;
  for (let i = 0; i < seg.length; i++) {
    let color: number;
    if (stage === 2) {
      color = color_blend(
        seg.color_from_palette(i, true, false, 2),
        color2,
        stp,
      );
    } else if (stage === 1) {
      color = color_blend(
        color1,
        seg.color_from_palette(i, true, false, 2),
        stp,
      );
    } else {
      color = color_blend(color1, color2, stp);
    }
    seg.setPixelColor(i, color);
  }
}

// --- Strobe Mega (25) --------------------------------------------------------
function modeMultiStrobe(seg: Segment): void {
  for (let i = 0; i < seg.length; i++) {
    seg.setPixelColor(i, seg.color_from_palette(i, true, false, 1));
  }

  seg.aux0 = 50 + 20 * (255 - seg.speed);
  const count = 2 * (Math.trunc(seg.intensity / 10) + 1);
  if (seg.aux1 < count) {
    if ((seg.aux1 & 1) === 0) {
      seg.fill(seg.color(0));
      seg.aux0 = 15;
    } else {
      seg.aux0 = 50;
    }
  }

  if (seg.now - seg.step > seg.aux0) {
    seg.aux1++;
    if (seg.aux1 > count) seg.aux1 = 0;
    seg.step = seg.now;
  }
}

// --- Fire Flicker (45) -------------------------------------------------------
function modeFireFlicker(seg: Segment): void {
  const cycleTime = 40 + (255 - seg.speed);
  const it = Math.trunc(seg.now / cycleTime);
  if (seg.step === it) return;

  const w = (seg.color(0) >>> 24) & 0xff;
  const r = (seg.color(0) >>> 16) & 0xff;
  const g = (seg.color(0) >>> 8) & 0xff;
  const b = seg.color(0) & 0xff;
  let lum = seg.palette === 0 ? Math.max(w, r, g, b) : 255;
  lum = Math.trunc(lum / (Math.trunc((256 - seg.intensity) / 16) + 1));
  for (let i = 0; i < seg.length; i++) {
    const flicker = seg.rng.random8(lum);
    if (seg.palette === 0) {
      seg.setPixelColor(
        i,
        rgbw32(
          Math.max(r - flicker, 0),
          Math.max(g - flicker, 0),
          Math.max(b - flicker, 0),
          Math.max(w - flicker, 0),
        ),
      );
    } else {
      seg.setPixelColor(
        i,
        seg.color_from_palette(i, true, false, 0, 255 - flicker),
      );
    }
  }

  seg.step = it;
}

// --- Colortwinkles (74) ------------------------------------------------------
// Based on https://gist.github.com/kriegsman/5408ecd397744ba0393e. WLED scales
// the fade rates by the device's global brightness (strip.getBrightness()); this
// sim has no such setting (preview brightness is the block's own params), so it
// always takes the ">28" branch -- the common case at any normal show brightness.
function modeColortwinkle(seg: Segment): void {
  const dataSize = (seg.length + 7) >> 3; // 1 bit per LED
  const data = seg.allocateData(dataSize);

  const fadeUpAmount = 8 + (seg.speed >> 2);
  const fadeDownAmount = 8 + (seg.speed >> 3);
  for (let i = 0; i < seg.length; i++) {
    const cur = seg.getPixelColor(i);
    const index = i >> 3;
    const bitNum = i & 0x07;
    const fadeUp = (data[index] & (1 << bitNum)) !== 0;

    if (fadeUp) {
      const incremental = color_fade(cur, fadeUpAmount, true);
      let col = color_add(cur, incremental);
      if (
        ((col >>> 16) & 0xff) === 255 ||
        ((col >>> 8) & 0xff) === 255 ||
        (col & 0xff) === 255
      ) {
        data[index] &= ~(1 << bitNum);
      }
      if (col === cur) col = color_add(col, col);
      seg.setPixelColor(i, col);
    } else {
      seg.setPixelColor(i, color_fade(cur, 255 - fadeDownAmount, false));
    }
  }

  for (let j = 0; j <= Math.trunc(seg.length / 50); j++) {
    if (seg.rng.random8() <= seg.intensity) {
      for (let times = 0; times < 5; times++) {
        const i = seg.rng.random16(seg.length);
        if (seg.getPixelColor(i) === 0) {
          const index = i >> 3;
          const bitNum = i & 0x07;
          data[index] |= 1 << bitNum;
          seg.setPixelColor(
            i,
            colorFromPalette(
              seg.getCurrentPalette(),
              seg.rng.random8(),
              64,
              NOBLEND,
            ),
          );
          break;
        }
      }
    }
  }
}

// --- Twinklefox (80) ---------------------------------------------------------
// TwinkleFOX by Mark Kriegsman: https://gist.github.com/kriegsman/756ea6dcae8e30845b5a
function twinklefoxOneTwinkle(
  seg: Segment,
  ms: number,
  salt: number,
  cat: boolean,
): RGB {
  const ticks = Math.trunc(ms / seg.aux0);
  const fastcycle8 = ticks & 0xff;
  let slowcycle16 = (ticks >> 8) + salt;
  slowcycle16 = (slowcycle16 + sin8(slowcycle16 & 0xff)) & 0xffff;
  slowcycle16 = (slowcycle16 * 2053 + 1384) & 0xffff;
  const slowcycle8 = ((slowcycle16 & 0xff) + (slowcycle16 >> 8)) & 0xff;

  const twinkleDensity = (seg.intensity >> 5) + 1;

  let bright = 0;
  if (Math.trunc((slowcycle8 & 0x0e) / 2) < twinkleDensity) {
    const ph = fastcycle8;
    if (cat) {
      // Twinklecat: LEDs snap on and fade off (or, with the reverse
      // checkbox, fade on and snap off) instead of vanilla's asymmetric
      // triangle wave.
      bright = seg.check2 ? ph : 255 - ph;
    } else if (ph < 86) {
      bright = ph * 3;
    } else {
      const ph2 = ph - 86;
      bright = 255 - (ph2 + Math.trunc(ph2 / 2));
    }
  }

  const hue = (slowcycle8 - salt) & 0xff;
  if (bright <= 0) return [0, 0, 0];

  let c = colorFromPalette(
    seg.getCurrentPalette(),
    hue,
    bright,
    1 /* LINEARBLEND */,
  );
  if (!seg.check1 && fastcycle8 >= 128) {
    const cooling = (fastcycle8 - 128) >> 4;
    const g = qsub8((c >>> 8) & 0xff, cooling);
    const b = qsub8(c & 0xff, cooling * 2);
    c = rgbw32((c >>> 16) & 0xff, g, b);
  }
  return [(c >>> 16) & 0xff, (c >>> 8) & 0xff, c & 0xff];
}

function twinklefoxBase(seg: Segment, cat: boolean): void {
  if (seg.speed > 100) seg.aux0 = 3 + ((255 - seg.speed) >> 3);
  else seg.aux0 = 22 + ((100 - seg.speed) >> 1);

  let bg = seg.color(1);
  const bglight = averageLight(bg);
  if (bglight > 64) bg = color_fade(bg, 16, true);
  else if (bglight > 16) bg = color_fade(bg, 64, true);
  else bg = color_fade(bg, 86, true);
  bg = gamma32inv(bg);

  const backgroundBrightness = averageLight(bg);

  let prng16 = 11337;
  for (let i = 0; i < seg.length; i++) {
    prng16 = (prng16 * 2053 + 1384) & 0xffff;
    const myclockoffset16 = prng16;
    prng16 = (prng16 * 2053 + 1384) & 0xffff;
    const myspeedmultiplierQ5_3 =
      ((((prng16 & 0xff) >> 4) + (prng16 & 0x0f)) & 0x0f) + 0x08;
    const myclock30 =
      ((seg.now * myspeedmultiplierQ5_3) >> 3) + myclockoffset16;
    const myunique8 = prng16 >> 8;

    const [cr, cg, cb] = twinklefoxOneTwinkle(seg, myclock30, myunique8, cat);
    const c = rgbw32(cr, cg, cb);
    const cbright = averageLight(c);
    const deltabright = cbright - backgroundBrightness;
    if (deltabright >= 32 || bg === 0) {
      seg.setPixelColor(i, c);
    } else if (deltabright > 0) {
      seg.setPixelColor(i, color_blend(bg, c, (deltabright * 8) & 0xff));
    } else {
      seg.setPixelColor(i, bg);
    }
  }
}

function modeTwinklefox(seg: Segment): void {
  twinklefoxBase(seg, false);
}

function modeTwinklecat(seg: Segment): void {
  twinklefoxBase(seg, true);
}

// --- Candle (88) / Candle Multi (102) ----------------------------------------
// Shared base (WLED candle(bool multi)) -- multi=false is the original single-
// candle whole-strip flicker (id 88); multi=true (id 102) gives every LED its
// own independent flicker state, stored per-LED in byte scratch (candleData)
// instead of the single aux0/aux1/step scratch the i==0 candle uses.
function candleBase(seg: Segment, multi: boolean): void {
  // Firmware rate-limits to one update per FRAMETIME via a stored last-call
  // timestamp; this sim's frame loop already steps in fixed FRAMETIME
  // increments (index.ts), so that guard is a no-op here -- and skipping it
  // avoids a spurious all-black frame 0 (now=0, stored lastcall=0 -> firmware's
  // literal guard would trip on the very first call too). Same reasoning
  // applies to the multi branch: every LED's flicker still updates once per
  // sim frame, matching the ~1 update/FRAMETIME cadence the real rate limit
  // targets anyway.
  const valrange = seg.intensity;
  const rndval = valrange >> 1;
  let speedFactor = 4;
  if (seg.speed > 252) speedFactor = 1;
  else if (seg.speed > 99) speedFactor = 2;
  else if (seg.speed > 49) speedFactor = 3;

  const numCandles = multi ? seg.length : 1;
  const candleData =
    multi && seg.length > 1
      ? seg.allocateData(Math.max(1, seg.length - 1) * 3)
      : null;

  for (let i = 0; i < numCandles; i++) {
    let d = 0;
    let s = seg.aux0;
    let sTarget = seg.aux1;
    let fadeStep = seg.step;
    if (i > 0 && candleData) {
      d = (i - 1) * 3;
      s = candleData[d];
      sTarget = candleData[d + 1];
      fadeStep = candleData[d + 2];
    }
    if (fadeStep === 0) {
      s = 128;
      sTarget = 130 + seg.rng.random8(4);
      fadeStep = 1;
    }

    let newTarget = false;
    if (sTarget > s) {
      s = qadd8(s, fadeStep);
      if (s >= sTarget) newTarget = true;
    } else {
      s = qsub8(s, fadeStep);
      if (s <= sTarget) newTarget = true;
    }

    if (newTarget) {
      sTarget = seg.rng.random8(rndval) + seg.rng.random8(rndval);
      if (sTarget < rndval >> 1)
        sTarget = (rndval >> 1) + seg.rng.random8(rndval);
      sTarget += 255 - valrange;
      const dif = Math.abs(sTarget - s);
      fadeStep = dif >> speedFactor;
      if (fadeStep === 0) fadeStep = 1;
    }

    if (i > 0 && candleData) {
      seg.setPixelColor(
        i,
        color_blend(
          seg.color(1),
          seg.color_from_palette(i, true, false, 0),
          s & 0xff,
        ),
      );
      candleData[d] = s;
      candleData[d + 1] = sTarget;
      candleData[d + 2] = fadeStep;
    } else {
      for (let j = 0; j < seg.length; j++) {
        seg.setPixelColor(
          j,
          color_blend(
            seg.color(1),
            seg.color_from_palette(j, true, false, 0),
            s & 0xff,
          ),
        );
      }
      seg.aux0 = s;
      seg.aux1 = sTarget;
      seg.step = fadeStep;
    }
  }
}

function modeCandle(seg: Segment): void {
  candleBase(seg, false);
}

function modeCandleMulti(seg: Segment): void {
  candleBase(seg, true);
}

// --- Sunrise (104) ------------------------------------------------------------
// Firmware measures elapsed time via wall-clock millis() (deliberately, so a
// clock sync doesn't reset the ramp) kept separate from strip.now. This sim has
// no wall clock -- seg.now (the timeline position) already means "time since
// this block started", which is the actual intent, so it stands in for both.
function modeSunrise(seg: Segment): void {
  if (seg.length <= 1) return fallbackStatic(seg);

  if (seg.call === 0 || seg.speed !== seg.aux1) {
    seg.step = seg.now;
    seg.aux1 = seg.speed;
  }

  seg.fill(BLACK);
  let stage = 0xffff;

  let s10SinceStart = Math.trunc((seg.now - seg.step) / 100);

  if (seg.speed > 120) {
    const counter = (seg.now >> 1) * (((seg.speed - 120) >> 1) + 1);
    stage = triwave16(counter & 0xffff);
  } else if (seg.speed) {
    let durMins = seg.speed;
    if (durMins > 60) durMins -= 60;
    const s10Target = durMins * 600;
    if (s10SinceStart > s10Target) s10SinceStart = s10Target;
    stage = map(s10SinceStart, 0, s10Target, 0, 0xffff);
    if (seg.speed > 60) stage = 0xffff - stage;
  }

  for (let i = 0; i <= Math.trunc(seg.length / 2); i++) {
    let wave = triwave16(Math.trunc((i * stage) / seg.length));
    wave = (wave >> 8) + ((wave * seg.intensity) >> 15);
    const c =
      wave > 240
        ? seg.color_from_palette(240, false, true, 255)
        : seg.color_from_palette(wave, false, true, 255);
    seg.setPixelColor(i, c);
    seg.setPixelColor(seg.length - i - 1, c);
  }
}

// --- Colorwaves (67) / Pride 2015 (63) ---------------------------------------
// Shared base (WLED mode_colorwaves_pride_base) -- Pride 2015 takes the
// CHSV + gamma32inv branch that was dead code while only Colorwaves was ported.
function blendPixelColor(
  seg: Segment,
  i: number,
  color: number,
  blend: number,
): void {
  seg.setPixelColor(i, color_blend(seg.getPixelColor(i), color, blend));
}

function colorwavesPrideBase(seg: Segment, isPride2015: boolean): void {
  const duration = 10 + seg.speed;
  let sPseudotime = seg.step;
  let sHue16 = seg.aux0 & 0xffff;

  const sat8 = isPride2015 ? beatsin88_t(87, seg.now, 220, 250) : 255;
  const brightdepth = beatsin88_t(341, seg.now, 96, 224);
  const brightnessthetainc16 = beatsin88_t(203, seg.now, 25 * 256, 40 * 256);
  const msmultiplier = beatsin88_t(147, seg.now, 23, 60);

  let hue16 = sHue16;
  const hueinc16 = isPride2015
    ? beatsin88_t(113, seg.now, 1, 3000)
    : Math.trunc(
        (beatsin88_t(113, seg.now, 60, 300) * seg.intensity * 10) / 255,
      );

  sPseudotime += duration * msmultiplier;
  sHue16 = (sHue16 + duration * beatsin88_t(400, seg.now, 5, 9)) & 0xffff;
  let brightnesstheta16 = sPseudotime;

  for (let i = 0; i < seg.length; i++) {
    hue16 = (hue16 + hueinc16) & 0xffff;
    let hue8: number;
    if (isPride2015) {
      hue8 = (hue16 >> 8) & 0xff;
    } else {
      const h16_128 = hue16 >> 7;
      hue8 = h16_128 & 0x100 ? 255 - (h16_128 >> 1) : h16_128 >> 1;
    }

    brightnesstheta16 += brightnessthetainc16;
    const b16 = sin16(brightnesstheta16 & 0xffff) + 32768;
    const bri16 = (b16 * b16) / 65536;
    let bri8 = Math.trunc((bri16 * brightdepth) / 65536);
    bri8 = (bri8 + (255 - brightdepth)) & 0xff;

    if (isPride2015) {
      blendPixelColor(
        seg,
        i,
        gamma32inv(hsv2rgb_rainbow(hue8, sat8, bri8)),
        64,
      );
    } else {
      blendPixelColor(
        seg,
        i,
        seg.color_from_palette(hue8 & 0xff, false, false, 0, bri8),
        128,
      );
    }
  }

  seg.step = sPseudotime;
  seg.aux0 = sHue16;
}

function modeColorwaves(seg: Segment): void {
  colorwavesPrideBase(seg, false);
}

function modePride2015(seg: Segment): void {
  colorwavesPrideBase(seg, true);
}

// --- Aurora (38) ---------------------------------------------------------------
// Aurora effect by @Mazen, ported to integer math by @dedehai. Persistent
// per-wave state (position/age/color) doesn't fit the byte-scratch SEGENV.data
// model other ports use, so it's kept in a WeakMap keyed by the Segment
// instance -- a fresh Segment (index.ts's reset()) means a fresh entry, so
// determinism-from-reset still holds.
const W_MAX_COUNT = 20;
const W_MAX_SPEED = 6;
const W_WIDTH_FACTOR = 6;
const AW_SHIFT = 16;
const AW_SCALE = 1 << AW_SHIFT;

interface AuroraWave {
  center: number; // scaled by AW_SCALE
  ttl: number;
  age: number;
  width: number;
  basealpha: number; // scaled by AW_SCALE
  speedFactor: number; // scaled by AW_SCALE
  goingleft: boolean;
  alive: boolean;
  basecolor: RGB;
}

const auroraWaves = new WeakMap<Segment, AuroraWave[]>();

function auroraInit(seg: Segment, length: number, color: RGB): AuroraWave {
  const basealpha = Math.trunc((seg.rng.random8(60, 100) * AW_SCALE) / 100);
  const width =
    seg.rng.random16(
      Math.trunc(length / 20),
      Math.trunc(length / W_WIDTH_FACTOR),
    ) + 1;
  const center = Math.trunc((seg.rng.random8(101) * AW_SCALE) / 100) * length;
  const goingleft = (seg.rng.random8() & 0x01) === 1;
  const speedFactor = Math.trunc(
    (seg.rng.random8(10, 31) * W_MAX_SPEED * AW_SCALE) / (100 * 255),
  );
  return {
    center,
    ttl: seg.rng.random16(500, 1501),
    age: 0,
    width,
    basealpha,
    speedFactor,
    goingleft,
    alive: true,
    basecolor: color,
  };
}

function auroraUpdate(
  seg: Segment,
  w: AuroraWave,
  length: number,
  speed: number,
): void {
  const step = w.speedFactor * speed;
  w.center += w.goingleft ? -step : step;
  w.age++;

  if (w.age > w.ttl) {
    w.alive = false;
    return;
  }
  const widthScaled = w.width * AW_SCALE;
  const lengthScaled = length * AW_SCALE;
  if (w.goingleft) {
    if (w.center < -widthScaled) w.alive = false;
  } else {
    if (w.center > lengthScaled + widthScaled) w.alive = false;
  }
}

function auroraColorForLed(
  w: AuroraWave,
  ageFactor: number,
  waveStart: number,
  waveEnd: number,
  ledIndex: number,
): RGB {
  if (ledIndex < waveStart || ledIndex > waveEnd) return [0, 0, 0];
  const ledScaled = ledIndex * AW_SCALE;
  const offset = Math.abs(ledScaled - w.center);
  const offsetFactor = Math.trunc(offset / w.width);
  if (offsetFactor > AW_SCALE) return [0, 0, 0];
  let brightness = AW_SCALE - offsetFactor;
  brightness = (brightness * ageFactor) >> AW_SHIFT;
  brightness = (brightness * w.basealpha) >> AW_SHIFT;
  return [
    (w.basecolor[0] * brightness) >> AW_SHIFT,
    (w.basecolor[1] * brightness) >> AW_SHIFT,
    (w.basecolor[2] * brightness) >> AW_SHIFT,
  ];
}

function modeAurora(seg: Segment): void {
  let waves = auroraWaves.get(seg);
  if (!waves) {
    waves = Array.from({ length: W_MAX_COUNT }, () => ({
      center: 0,
      ttl: 0,
      age: 0,
      width: 1,
      basealpha: 0,
      speedFactor: 0,
      goingleft: false,
      alive: false,
      basecolor: [0, 0, 0] as RGB,
    }));
    auroraWaves.set(seg, waves);
  }

  const wavecount = map(seg.intensity, 0, 255, 2, W_MAX_COUNT);

  const ageFactors: number[] = new Array(wavecount);
  const waveStarts: number[] = new Array(wavecount);
  const waveEnds: number[] = new Array(wavecount);

  for (let i = 0; i < wavecount; i++) {
    const w = waves[i];
    auroraUpdate(seg, w, seg.length, seg.speed);
    if (!w.alive) {
      const color = seg.color_from_palette(
        seg.rng.random8(),
        false,
        false,
        seg.rng.random8(0, 3),
      );
      waves[i] = auroraInit(seg, seg.length, [
        (color >>> 16) & 0xff,
        (color >>> 8) & 0xff,
        color & 0xff,
      ]);
    }
    const w2 = waves[i];
    const halfTtl = w2.ttl >> 1;
    ageFactors[i] = Math.min(
      w2.age < halfTtl
        ? Math.trunc((w2.age * AW_SCALE) / halfTtl)
        : Math.trunc(((w2.ttl - w2.age) * AW_SCALE) / halfTtl),
      AW_SCALE - 1,
    );
    const centerLed = Math.trunc(w2.center / AW_SCALE);
    waveStarts[i] = centerLed - w2.width;
    waveEnds[i] = centerLed + w2.width;
  }

  let backlight = 0;
  if (seg.color(0)) backlight++;
  if (seg.color(1)) backlight++;
  if (seg.color(2)) backlight++;
  backlight = gamma8inv(backlight);

  for (let i = 0; i < seg.length; i++) {
    let r = backlight;
    let g = backlight;
    let b = backlight;
    for (let j = 0; j < wavecount; j++) {
      const [wr, wg, wb] = auroraColorForLed(
        waves[j],
        ageFactors[j],
        waveStarts[j],
        waveEnds[j],
        i,
      );
      const mixed = color_add(rgbw32(r, g, b), rgbw32(wr, wg, wb));
      r = (mixed >>> 16) & 0xff;
      g = (mixed >>> 8) & 0xff;
      b = mixed & 0xff;
    }
    seg.setPixelColor(i, rgbw32(r, g, b));
  }
}

// --- Plasma (97) ---------------------------------------------------------------
function modePlasma(seg: Segment): void {
  if (seg.call === 0) seg.aux0 = seg.rng.random8(0, 2);

  const thisPhase = beatsin8_t(6 + seg.aux0, seg.now, -64, 64);
  const thatPhase = beatsin8_t(7 + seg.aux0, seg.now, -64, 64);

  for (let i = 0; i < seg.length; i++) {
    const colorIndex =
      Math.trunc(
        cubicwave8((i * (2 + 3 * (seg.speed >> 5)) + thisPhase) & 0xff) / 2,
      ) +
      Math.trunc(cos8((i * (1 + 2 * (seg.speed >> 5)) + thatPhase) & 0xff) / 2);
    const thisBright = qsub8(
      colorIndex & 0xff,
      beatsin8_t(7, seg.now, 0, 128 - (seg.intensity >> 1)),
    );
    seg.setPixelColor(
      i,
      seg.color_from_palette(colorIndex & 0xff, false, false, 0, thisBright),
    );
  }
}

// --- Pacifica (101) --------------------------------------------------------------
// Mark Kriegsman & Mary Corey March, adapted for WLED from the FastLED example.
// strip.now is temporarily rescaled in firmware (saved/restored as nowOld) just
// to skew this function's own beatsin*/sin16 time base; this sim passes that
// rescaled `deltat` explicitly instead of mutating the shared seg.now.
const PACIFICA_PALETTE_1: RGB[] = [
  [0x00, 0x05, 0x07],
  [0x00, 0x04, 0x09],
  [0x00, 0x03, 0x0b],
  [0x00, 0x03, 0x0d],
  [0x00, 0x02, 0x10],
  [0x00, 0x02, 0x12],
  [0x00, 0x01, 0x14],
  [0x00, 0x01, 0x17],
  [0x00, 0x00, 0x19],
  [0x00, 0x00, 0x1c],
  [0x00, 0x00, 0x26],
  [0x00, 0x00, 0x31],
  [0x00, 0x00, 0x3b],
  [0x00, 0x00, 0x46],
  [0x14, 0x55, 0x4b],
  [0x28, 0xaa, 0x50],
];
const PACIFICA_PALETTE_2: RGB[] = [
  [0x00, 0x05, 0x07],
  [0x00, 0x04, 0x09],
  [0x00, 0x03, 0x0b],
  [0x00, 0x03, 0x0d],
  [0x00, 0x02, 0x10],
  [0x00, 0x02, 0x12],
  [0x00, 0x01, 0x14],
  [0x00, 0x01, 0x17],
  [0x00, 0x00, 0x19],
  [0x00, 0x00, 0x1c],
  [0x00, 0x00, 0x26],
  [0x00, 0x00, 0x31],
  [0x00, 0x00, 0x3b],
  [0x00, 0x00, 0x46],
  [0x0c, 0x5f, 0x52],
  [0x19, 0xbe, 0x5f],
];
const PACIFICA_PALETTE_3: RGB[] = [
  [0x00, 0x02, 0x08],
  [0x00, 0x03, 0x0e],
  [0x00, 0x05, 0x14],
  [0x00, 0x06, 0x1a],
  [0x00, 0x08, 0x20],
  [0x00, 0x09, 0x27],
  [0x00, 0x0b, 0x2d],
  [0x00, 0x0c, 0x33],
  [0x00, 0x0e, 0x39],
  [0x00, 0x10, 0x40],
  [0x00, 0x14, 0x50],
  [0x00, 0x18, 0x60],
  [0x00, 0x1c, 0x70],
  [0x00, 0x20, 0x80],
  [0x10, 0x40, 0xbf],
  [0x20, 0x60, 0xff],
];

/** Saturating per-channel add on [r,g,b] triples -- FastLED CRGB::operator+=. */
function addRGB3(c1: RGB, c2: RGB): RGB {
  return [qadd8(c1[0], c2[0]), qadd8(c1[1], c2[1]), qadd8(c1[2], c2[2])];
}

function modePacifica(seg: Segment): void {
  const deltat = (seg.now >> 2) + Math.trunc((seg.now * seg.speed) >> 7);

  let p1 = PACIFICA_PALETTE_1;
  let p2 = PACIFICA_PALETTE_2;
  let p3 = PACIFICA_PALETTE_3;
  if (seg.palette) {
    p1 = seg.getCurrentPalette();
    p2 = p1;
    p3 = p1;
  }

  let sCIStart1 = seg.aux0;
  let sCIStart2 = seg.aux1;
  let sCIStart3 = seg.step & 0xffff;
  let sCIStart4 = Math.trunc(seg.step / 0x10000);

  const deltams = (FRAMETIME >> 2) + ((FRAMETIME * seg.speed) >> 7);

  const speedfactor1 = beatsin16_t(3, deltat, 179, 269);
  const speedfactor2 = beatsin16_t(4, deltat, 179, 269);
  const deltams1 = Math.trunc((deltams * speedfactor1) / 256);
  const deltams2 = Math.trunc((deltams * speedfactor2) / 256);
  const deltams21 = Math.trunc((deltams1 + deltams2) / 2);
  sCIStart1 =
    (sCIStart1 + deltams1 * beatsin88_t(1011, deltat, 10, 13)) & 0xffff;
  sCIStart2 =
    (sCIStart2 - deltams21 * beatsin88_t(777, deltat, 8, 11)) & 0xffff;
  sCIStart3 = (sCIStart3 - deltams1 * beatsin88_t(501, deltat, 5, 7)) & 0xffff;
  sCIStart4 = (sCIStart4 - deltams2 * beatsin88_t(257, deltat, 4, 6)) & 0xffff;
  seg.aux0 = sCIStart1;
  seg.aux1 = sCIStart2;
  seg.step = (sCIStart4 << 16) | (sCIStart3 & 0xffff);

  const basethreshold = beatsin8_t(9, deltat, 55, 65);
  let wave = beat8(7, deltat);

  const layer = (
    i: number,
    pal: RGB[],
    cistart: number,
    wavescale: number,
    bri: number,
    ioff: number,
  ): RGB => {
    const waveangle = (ioff + (120 + seg.intensity) * i) & 0xffff;
    const wavescaleHalf = (wavescale >> 1) + 20;
    const s16 = sin16(waveangle) + 32768;
    const cs = scale16(s16, wavescaleHalf) + wavescaleHalf;
    const ci = (cistart + cs * i) & 0xffff;
    const sindex16 = sin16(ci) + 32768;
    const sindex8 = scale16(sindex16, 240);
    const c = colorFromPalette(pal, sindex8, bri, 1 /* LINEARBLEND */);
    return [(c >>> 16) & 0xff, (c >>> 8) & 0xff, c & 0xff];
  };

  for (let i = 0; i < seg.length; i++) {
    let c: RGB = [2, 6, 10];
    c = addRGB3(
      c,
      layer(
        i,
        p1,
        sCIStart1,
        beatsin16_t(3, deltat, 11 * 256, 14 * 256),
        beatsin8_t(10, deltat, 70, 130),
        -beat16(301, deltat),
      ),
    );
    c = addRGB3(
      c,
      layer(
        i,
        p2,
        sCIStart2,
        beatsin16_t(4, deltat, 6 * 256, 9 * 256),
        beatsin8_t(17, deltat, 40, 80),
        beat16(401, deltat),
      ),
    );
    c = addRGB3(
      c,
      layer(
        i,
        p3,
        sCIStart3,
        6 * 256,
        beatsin8_t(9, deltat, 10, 38),
        -beat16(503, deltat),
      ),
    );
    c = addRGB3(
      c,
      layer(
        i,
        p3,
        sCIStart4,
        5 * 256,
        beatsin8_t(8, deltat, 10, 28),
        beat16(601, deltat),
      ),
    );

    const threshold = scale8(sin8(wave & 0xff), 20) + basethreshold;
    wave = (wave + 7) & 0xff;
    const l = ((c[0] + c[1] + c[2]) * 21846) >>> 16;
    if (l > threshold) {
      const overage = l - threshold;
      const overage2 = qadd8(overage, overage);
      c = addRGB3(c, [overage, overage2, qadd8(overage2, overage2)]);
    }

    c = [c[0], scale8(c[1], 200), scale8(c[2], 145)];
    c = [c[0] | 2, c[1] | 5, c[2] | 7];

    seg.setPixelColor(i, rgbw32(c[0], c[1], c[2]));
  }
}

// --- Juggle (64) --------------------------------------------------------------
function orColor(a: number, b: number): number {
  return rgbw32(R(a) | R(b), G(a) | G(b), B(a) | B(b));
}

function modeJuggle(seg: Segment): void {
  if (seg.length <= 1) return fallbackStatic(seg);

  seg.fadeToBlackBy(192 - Math.trunc((3 * seg.intensity) / 4));
  let dothue = 0;
  for (let i = 0; i < 8; i++) {
    const index = beatsin88_t(
      (16 + seg.speed) * (i + 7),
      seg.now,
      0,
      seg.length - 1,
    );
    const base = seg.getPixelColor(index);
    const add =
      seg.palette === 0
        ? hsv2rgb_rainbow(dothue, 220, 255)
        : colorFromPalette(seg.getCurrentPalette(), dothue, 255);
    seg.setPixelColor(index, orColor(base, add));
    dothue = (dothue + 32) & 0xff;
  }
}

// --- Bpm (68) ------------------------------------------------------------------
function modeBpm(seg: Segment): void {
  const stp = Math.trunc(seg.now / 20) & 0xff;
  const beat = beatsin8_t(seg.speed, seg.now, 64, 255);
  for (let i = 0; i < seg.length; i++) {
    seg.setPixelColor(
      i,
      seg.color_from_palette(
        (stp + i * 2) & 0xff,
        false,
        false,
        0,
        (beat - stp + i * 10) & 0xff,
      ),
    );
  }
}

// --- Sinelon / Sinelon Dual / Sinelon Rainbow (92/93/94) ---------------------
function sinelonBase(seg: Segment, dual: boolean, rainbow = false): void {
  if (seg.length <= 1) return fallbackStatic(seg);

  seg.fade_out(seg.intensity);
  const pos = beatsin16_t(
    Math.trunc(seg.speed / 10),
    seg.now,
    0,
    seg.length - 1,
  );
  if (seg.call === 0) seg.aux0 = pos;
  let color1 = seg.color_from_palette(pos, true, false, 0);
  let color2 = seg.color(2);
  if (rainbow) color1 = seg.color_wheel((pos & 0x07) * 32);
  seg.setPixelColor(pos, color1);
  if (dual) {
    if (!color2) color2 = seg.color_from_palette(pos, true, false, 0);
    if (rainbow) color2 = color1;
    seg.setPixelColor(seg.length - 1 - pos, color2);
  }
  if (seg.aux0 !== pos) {
    if (seg.aux0 < pos) {
      for (let i = seg.aux0; i < pos; i++) {
        seg.setPixelColor(i, color1);
        if (dual) seg.setPixelColor(seg.length - 1 - i, color2);
      }
    } else {
      for (let i = seg.aux0; i > pos; i--) {
        seg.setPixelColor(i, color1);
        if (dual) seg.setPixelColor(seg.length - 1 - i, color2);
      }
    }
    seg.aux0 = pos;
  }
}

function modeSinelon(seg: Segment): void {
  sinelonBase(seg, false);
}

function modeSinelonDual(seg: Segment): void {
  sinelonBase(seg, true);
}

function modeSinelonRainbow(seg: Segment): void {
  sinelonBase(seg, false, true);
}

// --- Traffic Light (35) --------------------------------------------------------
function modeTrafficLight(seg: Segment): void {
  if (seg.length <= 1) return fallbackStatic(seg);

  for (let i = 0; i < seg.length; i++) {
    seg.setPixelColor(i, seg.color_from_palette(i, true, false, 1));
  }
  let mdelay = 500;
  for (let i = 0; i < seg.length - 2; i += 3) {
    switch (seg.aux0) {
      case 0:
        seg.setPixelColor(i, 0x00ff0000);
        mdelay = 150 + 100 * (255 - seg.speed);
        break;
      case 1:
        seg.setPixelColor(i, 0x00ff0000);
        mdelay = 150 + 20 * (255 - seg.speed);
        seg.setPixelColor(i + 1, 0x00eecc00);
        break;
      case 2:
        seg.setPixelColor(i + 2, 0x0000ff00);
        mdelay = 150 + 100 * (255 - seg.speed);
        break;
      case 3:
        seg.setPixelColor(i + 1, 0x00eecc00);
        mdelay = 150 + 20 * (255 - seg.speed);
        break;
    }
  }
  if (seg.now - seg.step > mdelay) {
    seg.aux0++;
    if (seg.aux0 === 1 && seg.intensity > 140) seg.aux0 = 2;
    if (seg.aux0 > 3) seg.aux0 = 0;
    seg.step = seg.now;
  }
}

// --- Gradient (46) / Loading (47) ---------------------------------------------
function gradientBase(seg: Segment, loading: boolean): void {
  if (seg.length <= 1) return fallbackStatic(seg);

  const counter = (seg.now * ((seg.speed >> 2) + 1)) & 0xffff;
  let pp = (counter * seg.length) >>> 16;
  if (seg.call === 0) pp = 0;
  // Source's `1 + loading ? a : b` parses as `(1+loading) ? a : b` under C++
  // precedence, always truthy -- brd is always intensity/2 regardless of
  // `loading`. A real quirk in WLED's own gradient_base(), kept faithfully.
  const brd = Math.trunc(seg.intensity / 2);
  const p1 = pp - seg.length;
  const p2 = pp + seg.length;

  for (let i = 0; i < seg.length; i++) {
    let val: number;
    if (loading) {
      val = Math.abs((i > pp ? p2 : pp) - i);
    } else {
      val = Math.min(
        Math.abs(pp - i),
        Math.min(Math.abs(p1 - i), Math.abs(p2 - i)),
      );
    }
    val = brd > val ? Math.trunc((val * 255) / brd) : 255;
    seg.setPixelColor(
      i,
      color_blend(
        seg.color(0),
        seg.color_from_palette(i, true, false, 1),
        val & 0xff,
      ),
    );
  }
}

function modeGradient(seg: Segment): void {
  gradientBase(seg, false);
}

function modeLoading(seg: Segment): void {
  gradientBase(seg, true);
}

// --- Colorful (34) ---------------------------------------------------------
function modeColorful(seg: Segment): void {
  let numColors = 4;
  const cols = [0x00ff0000, 0x00eebb00, 0x0000ee00, 0x000077cc, 0, 0, 0, 0, 0];

  if (seg.intensity > 160 || seg.palette) {
    if (!seg.palette) {
      numColors = 3;
      for (let i = 0; i < 3; i++) cols[i] = seg.color(i);
    } else {
      let fac = 80;
      if (seg.palette === 52) {
        numColors = 5;
        fac = 61;
      }
      for (let i = 0; i < numColors; i++) {
        cols[i] = seg.color_from_palette(i * fac, false, true, 255);
      }
    }
  } else if (seg.intensity < 80) {
    cols[0] = 0x00ff8040;
    cols[1] = 0x00e5d241;
    cols[2] = 0x0077ff77;
    cols[3] = 0x0077f0f0;
  }

  for (let i = numColors; i < numColors * 2 - 1; i++)
    cols[i] = cols[i - numColors];

  const cycleTime = 50 + 8 * (255 - seg.speed);
  const it = Math.trunc(seg.now / cycleTime);
  if (it !== seg.step) {
    if (seg.speed > 0) seg.aux0++;
    if (seg.aux0 >= numColors) seg.aux0 = 0;
    seg.step = it;
  }

  for (let i = 0; i < seg.length; i += numColors) {
    for (let j = 0; j < numColors; j++)
      seg.setPixelColor(i + j, cols[seg.aux0 + j]);
  }
}

// --- Sine (108) ----------------------------------------------------------------
function modeSinewave(seg: Segment): void {
  const colorIndex = Math.trunc(seg.now / 32);
  seg.step += Math.trunc(seg.speed / 16);
  const freq = Math.trunc(seg.intensity / 4);
  for (let i = 0; i < seg.length; i++) {
    const pixBri = cubicwave8(i * freq + seg.step);
    seg.setPixelColor(
      i,
      color_blend(
        seg.color(1),
        seg.color_from_palette(
          Math.trunc((i * colorIndex) / 255),
          false,
          false,
          0,
        ),
        pixBri,
      ),
    );
  }
}

// --- Washing Machine (113) ------------------------------------------------------
function tristateSquare8(
  x: number,
  pulsewidth: number,
  attdec: number,
): number {
  let a = 127;
  let xx = x & 0xff;
  if (xx > 127) {
    a = -127;
    xx -= 127;
  }
  if (xx < attdec) return Math.trunc((xx * a) / attdec);
  if (xx < pulsewidth - attdec) return a;
  if (xx < pulsewidth) return Math.trunc(((pulsewidth - xx) * a) / attdec);
  return 0;
}

function modeWashingMachine(seg: Segment): void {
  const speed = tristateSquare8((seg.now >> 7) & 0xff, 90, 15);
  seg.step += Math.trunc((speed * 2048) / (512 - seg.speed));
  const term = Math.trunc(seg.intensity / 25) + 1;
  for (let i = 0; i < seg.length; i++) {
    const col = sin8(
      (Math.trunc((term * 255 * i) / seg.length) + (seg.step >> 7)) & 0xff,
    );
    seg.setPixelColor(i, seg.color_from_palette(col, false, false, 3));
  }
}

// --- Flow (110) ------------------------------------------------------------
function modeFlow(seg: Segment): void {
  // Firmware has no SEGLEN<=1 guard here, but zoneLen would divide by zero at
  // length 1 -- guarded to satisfy this sim's universal length-1 contract
  // rather than replicate what would be undefined behavior on a real device.
  if (seg.length <= 1) return fallbackStatic(seg);

  let counter = 0;
  if (seg.speed !== 0) {
    counter = (seg.now * ((seg.speed >> 2) + 1)) >>> 0;
    counter = counter >>> 8;
  }

  const maxZones = Math.trunc(seg.length / 6);
  let zones = (seg.intensity * maxZones) >> 8;
  if (zones & 1) zones++;
  if (zones < 2) zones = 2;
  const zoneLen = Math.max(1, Math.trunc(seg.length / zones));
  const requiredZones = Math.trunc((seg.length + zoneLen - 1) / zoneLen);
  zones = requiredZones + 2;
  const offset = Math.trunc((seg.length - zones * zoneLen) / 2);

  for (let z = 0; z < zones; z++) {
    const pos = offset + z * zoneLen;
    for (let i = 0; i < zoneLen; i++) {
      const colorIndex = (Math.trunc((i * 255) / zoneLen) - counter) & 0xff;
      // SEGMENT.reverse has no sim equivalent (no per-segment display
      // orientation modeled) -- treated as always false.
      const led = z & 1 ? i : zoneLen - 1 - i;
      seg.setPixelColor(
        pos + led,
        seg.color_from_palette(colorIndex, false, true, 255),
      );
    }
  }
}

// --- Percent (98) ----------------------------------------------------------
function modePercent(seg: Segment): void {
  const percent = Math.min(200, Math.max(0, seg.intensity));
  const activeLeds =
    percent < 100
      ? Math.round((seg.length * percent) / 100)
      : Math.round((seg.length * (200 - percent)) / 100);
  let size = 1 + ((seg.speed * seg.length) >> 11);
  if (seg.speed === 255) size = 255;

  if (percent <= 100) {
    for (let i = 0; i < seg.length; i++) {
      if (i < seg.aux1) {
        seg.setPixelColor(
          i,
          seg.check1
            ? seg.color_from_palette(
                map(percent, 0, 100, 0, 255),
                false,
                false,
                0,
              )
            : seg.color_from_palette(i, true, false, 0),
        );
      } else {
        seg.setPixelColor(i, seg.color(1));
      }
    }
  } else {
    for (let i = 0; i < seg.length; i++) {
      if (i < seg.length - seg.aux1) {
        seg.setPixelColor(i, seg.color(1));
      } else {
        seg.setPixelColor(
          i,
          seg.check1
            ? seg.color_from_palette(
                map(percent, 100, 200, 255, 0),
                false,
                false,
                0,
              )
            : seg.color_from_palette(i, true, false, 0),
        );
      }
    }
  }

  if (activeLeds > seg.aux1) {
    seg.aux1 += size;
    if (seg.aux1 > activeLeds) seg.aux1 = activeLeds;
  } else if (activeLeds < seg.aux1) {
    if (seg.aux1 > size) seg.aux1 -= size;
    else seg.aux1 = 0;
    if (seg.aux1 < activeLeds) seg.aux1 = activeLeds;
  }
}

// --- Blends (115) ------------------------------------------------------------
function modeBlends(seg: Segment): void {
  const pixelLen = Math.min(255, seg.length);
  const buf = seg.allocateData(4 * (pixelLen + 1));
  const pixels = new Uint32Array(buf.buffer, buf.byteOffset, pixelLen + 1);
  const blendSpeed = map(seg.intensity, 0, 255, 10, 128);
  let shift = ((seg.now * ((seg.speed >> 3) + 1)) >>> 0) >>> 8;

  for (let i = 0; i < pixelLen; i++) {
    pixels[i] = color_blend(
      pixels[i],
      seg.color_from_palette(
        shift + quadwave8((i + 1) * 16),
        false,
        false,
        255,
      ),
      blendSpeed,
    );
    shift += 3;
  }

  let offset = 0;
  for (let i = 0; i < seg.length; i++) {
    seg.setPixelColor(i, pixels[offset++]);
    if (offset >= pixelLen) offset = 0;
  }
}

// --- Lightning (57) --------------------------------------------------------
function modeLightning(seg: Segment): void {
  if (seg.length <= 1) return fallbackStatic(seg);

  const ledstart = seg.rng.random16(seg.length);
  const ledlen = 1 + seg.rng.random16(seg.length - ledstart);
  let bri = Math.trunc(255 / seg.rng.random8(1, 3));

  if (seg.aux1 === 0) {
    seg.aux1 = seg.rng.random8(4, 4 + Math.trunc(seg.intensity / 20));
    seg.aux1 *= 2;
    bri = 52;
    seg.aux0 = 200;
  }

  if (!seg.check2) seg.fill(seg.color(1));

  if (seg.aux1 > 3 && !(seg.aux1 & 1)) {
    for (let i = ledstart; i < ledstart + ledlen; i++) {
      seg.setPixelColor(i, seg.color_from_palette(i, true, false, 0, bri));
    }
    seg.aux1--;
    seg.step = seg.now;
  } else if (seg.now - seg.step > seg.aux0) {
    seg.aux1--;
    if (seg.aux1 < 2) seg.aux1 = 0;
    seg.aux0 = 50 + seg.rng.random8(100);
    if (seg.aux1 === 2) {
      seg.aux0 = seg.rng.random8(255 - seg.speed) * 100;
    }
    seg.step = seg.now;
  }
}

// --- Flow Stripe (179) -----------------------------------------------------
function modeFlowStripe(seg: Segment): void {
  if (seg.length <= 1) return fallbackStatic(seg);

  const hl = Math.trunc((seg.length * 10) / 13);
  const hue = Math.trunc(seg.now / (seg.speed + 1)) & 0xff;
  const t = Math.trunc(seg.now / (Math.trunc(seg.intensity / 8) + 1));

  for (let i = 0; i < seg.length; i++) {
    let c = Math.trunc((Math.abs(i - hl) * 127) / hl);
    c = sin8(c & 0xff);
    c = sin8((Math.trunc(c / 2) + t) & 0xff);
    const b = sin8((c + Math.trunc(t / 8)) & 0xff);
    seg.setPixelColor(
      i,
      seg.color_from_palette((b + hue) & 0xff, false, true, 3),
    );
  }
}

// --- Oscillate (62) -----------------------------------------------------------
interface Oscillator {
  pos: number;
  size: number;
  dir: number;
  speed: number;
}

const oscillatorState = new WeakMap<Segment, Oscillator[]>();

function modeOscillate(seg: Segment): void {
  let oscillators = oscillatorState.get(seg);
  if (seg.call === 0 || !oscillators) {
    oscillators = [
      {
        pos: Math.trunc(seg.length / 4),
        size: Math.trunc(seg.length / 8),
        dir: 1,
        speed: 1,
      },
      {
        pos: Math.trunc((seg.length / 4) * 3),
        size: Math.trunc(seg.length / 8),
        dir: 1,
        speed: 2,
      },
      {
        pos: Math.trunc((seg.length / 4) * 2),
        size: Math.trunc(seg.length / 8),
        dir: -1,
        speed: 1,
      },
    ];
    oscillatorState.set(seg, oscillators);
  }

  const cycleTime = 20 + 2 * (255 - seg.speed);
  const it = Math.trunc(seg.now / cycleTime);

  for (const osc of oscillators) {
    if (it !== seg.step) osc.pos += osc.dir * osc.speed;
    osc.size = Math.trunc(seg.length / (3 + Math.trunc(seg.intensity / 8)));
    // Firmware detects wraparound via uint16_t underflow (pos goes huge, not
    // negative); this sim's pos is a plain signed number, so it checks the
    // actual intent -- pos dropping below zero -- directly instead.
    if (osc.dir === -1 && osc.pos < 0) {
      osc.pos = 0;
      osc.dir = 1;
      osc.speed =
        seg.speed > 100 ? seg.rng.random8(2, 4) : seg.rng.random8(1, 3);
    }
    if (osc.dir === 1 && osc.pos >= seg.length - 1) {
      osc.pos = seg.length - 1;
      osc.dir = -1;
      osc.speed =
        seg.speed > 100 ? seg.rng.random8(2, 4) : seg.rng.random8(1, 3);
    }
  }

  for (let i = 0; i < seg.length; i++) {
    let color = BLACK;
    for (let j = 0; j < oscillators.length; j++) {
      const osc = oscillators[j];
      if (i >= osc.pos - osc.size && i <= osc.pos + osc.size) {
        color =
          color === BLACK
            ? seg.color(j)
            : color_blend(color, seg.color(j), 128);
      }
    }
    seg.setPixelColor(i, color);
  }

  seg.step = it;
}

// --- Tetrix (44) / Bouncing Balls (91) / Popcorn (95) -------------------------
// All three wrap their body in firmware's virtualStrip::runStrip() indirection
// to run 1D logic across the columns of a 2D matrix (nrOfVStrips() > 1 there).
// This sim is 1D-only (nrOfVStrips() is always 1), so the indirection collapses
// to a single direct pass -- indexToVStrip(index, 0) is dropped entirely.

interface TetrisDrop {
  pos: number;
  speed: number;
  col: number;
  brick: number;
  stack: number;
  step: number;
}

const tetrixState = new WeakMap<Segment, TetrisDrop>();

function modeTetrix(seg: Segment): void {
  if (seg.length <= 1) return fallbackStatic(seg);

  let drop = tetrixState.get(seg);
  if (seg.call === 0 || !drop) {
    drop = { pos: 0, speed: 0, col: 0, brick: 0, stack: 0, step: 0 };
    tetrixState.set(seg, drop);
  }

  if (seg.call === 0) {
    drop.stack = 0;
    drop.step = seg.now + 2000;
    if (seg.check1) drop.col = 0;
  }

  if (drop.step === 0) {
    const speedIn = seg.speed !== 0 ? seg.speed : seg.rng.random8(1, 255);
    const speedMapped = map(speedIn, 1, 255, 5000, 250);
    drop.speed = (seg.length * FRAMETIME) / speedMapped;
    drop.pos = seg.length;
    if (!seg.check1) drop.col = seg.rng.random8(0, 15) << 4;
    drop.step = 1;
    drop.brick =
      (seg.intensity !== 0 ? (seg.intensity >> 5) + 1 : seg.rng.random8(1, 5)) *
      (1 + (seg.length >> 6));
  }

  if (drop.step === 1) {
    if (seg.rng.random8() >> 6) drop.step = 2;
  }

  if (drop.step === 2) {
    if (drop.pos > drop.stack) {
      drop.pos -= drop.speed;
      if (Math.trunc(drop.pos) < Math.trunc(drop.stack)) drop.pos = drop.stack;
      for (let i = Math.trunc(drop.pos); i < seg.length; i++) {
        const col =
          i < Math.trunc(drop.pos) + drop.brick
            ? seg.color_from_palette(drop.col, false, false, 0)
            : seg.color(1);
        seg.setPixelColor(i, col);
      }
    } else {
      drop.step = 0;
      drop.stack += drop.brick;
      if (drop.stack >= seg.length) drop.step = seg.now + 2000;
    }
  }

  if (drop.step > 2) {
    drop.brick = 0;
    if (drop.step > seg.now) {
      for (let i = 0; i < seg.length; i++)
        blendPixelColor(seg, i, seg.color(1), 25);
    } else {
      drop.stack = 0;
      drop.step = 0;
      if (seg.check1) drop.col += 8;
    }
  }
}

interface Ball {
  lastBounceTime: number;
  impactVelocity: number;
  height: number;
}

const MAX_BALLS = 16;
const ballsState = new WeakMap<Segment, Ball[]>();

function modeBouncingBalls(seg: Segment): void {
  if (seg.length <= 1) return fallbackStatic(seg);

  let balls = ballsState.get(seg);
  if (seg.call === 0 || !balls) {
    balls = Array.from({ length: MAX_BALLS }, () => ({
      lastBounceTime: seg.now,
      impactVelocity: 0,
      height: 0,
    }));
    ballsState.set(seg, balls);
  }

  if (!seg.check2) seg.fill(seg.color(2) ? BLACK : seg.color(1));

  const numBalls = Math.trunc((seg.intensity * (MAX_BALLS - 1)) / 255) + 1;
  const gravity = -9.81;
  const hasCol2 = seg.color(2) !== 0;
  const time = seg.now;

  for (let i = 0; i < numBalls; i++) {
    const timeSinceLastBounce =
      (time - balls[i].lastBounceTime) /
      (Math.trunc((255 - seg.speed) / 64) + 1);
    const timeSec = timeSinceLastBounce / 1000;
    balls[i].height =
      (0.5 * gravity * timeSec + balls[i].impactVelocity) * timeSec;

    if (balls[i].height <= 0) {
      balls[i].height = 0;
      const dampening = 0.9 - i / (numBalls * numBalls);
      balls[i].impactVelocity = dampening * balls[i].impactVelocity;
      balls[i].lastBounceTime = time;

      if (balls[i].impactVelocity < 0.015) {
        balls[i].impactVelocity =
          Math.sqrt(-2 * gravity) * (seg.rng.random8(5, 11) / 10);
      }
    } else if (balls[i].height > 1) {
      continue;
    }

    let color = seg.color(0);
    if (seg.palette) {
      color = seg.color_wheel(Math.trunc(i * (256 / Math.max(numBalls, 8))));
    } else if (hasCol2) {
      color = seg.color(i % 3);
    }

    // Firmware's WLED_USE_AA_PIXELS sub-pixel positioning branch is a
    // hardware-output nicety that doesn't apply to this 1D RGB-buffer sim.
    const pos = Math.round(balls[i].height * (seg.length - 1));
    seg.setPixelColor(pos, color);
  }
}

// --- Rolling Balls (48) -------------------------------------------------------
// "Bouncing balls on a track", modified from Aircoookie's Bouncing Balls by
// pjhatch. Real float physics (height/velocity/mass per ball) integrated from
// *elapsed wall-clock time* every frame -- (now - lastBounceUpdate) / cfac --
// not a fixed per-tick step, so a ball's position is recomputed from how long
// it's actually been since its last bounce/update. Porting the exact
// continuous-time integration (rather than a fixed increment) matters here:
// a step-based approximation would visibly drift out of sync with a real
// device as soon as the sim's step cadence differs from firmware's.
interface RollingBall {
  lastBounceUpdate: number; // seg.now at the last bounce/update/collision
  mass: number;
  velocity: number;
  height: number; // 0..1, fraction of the strip
}

const MAX_ROLLING_BALLS = 16;
const rollingBallsState = new WeakMap<Segment, RollingBall[]>();

function modeRollingBalls(seg: Segment): void {
  let balls = rollingBallsState.get(seg);
  const hasCol2 = seg.color(2) !== 0;

  if (seg.call === 0 || !balls) {
    seg.fill(hasCol2 ? BLACK : seg.color(1)); // start clean
    balls = Array.from({ length: MAX_ROLLING_BALLS }, () => {
      let velocity = 20 * (seg.rng.random16(1000, 10000) / 10000); // 1 to 10
      if (seg.rng.random8() < 128) velocity = -velocity; // 50% reverse direction
      return {
        lastBounceUpdate: seg.now,
        velocity,
        height: seg.rng.random16(0, 10000) / 10000, // 0. to 1.
        mass: seg.rng.random16(1000, 10000) / 10000, // .1 to 1.
      };
    });
    rollingBallsState.set(seg, balls);
  }

  const numBalls = Math.trunc(seg.intensity / 16) + 1;
  // Aircoookie's time-scaling conversion factor for the speed slider.
  const cfac = (scale8(8, 255 - seg.speed) + 1) * 20000;

  if (seg.check3) {
    seg.fade_out(250); // 2-8 pixel trails (optional)
  } else if (!seg.check2) {
    seg.fill(hasCol2 ? BLACK : seg.color(1)); // don't fill if user wants trails visible
  }

  for (let i = 0; i < numBalls; i++) {
    const timeSinceLastUpdate = (seg.now - balls[i].lastBounceUpdate) / cfac;
    let thisHeight = balls[i].height + balls[i].velocity * timeSinceLastUpdate;

    // intensity was raised and some balls are way off the track -- reset them
    if (thisHeight < -0.5 || thisHeight > 1.5) {
      thisHeight = balls[i].height = seg.rng.random16(0, 10000) / 10000;
      balls[i].lastBounceUpdate = seg.now;
    }

    // reached either end of the strip
    if (
      (thisHeight <= 0 && balls[i].velocity < 0) ||
      (thisHeight >= 1 && balls[i].velocity > 0)
    ) {
      balls[i].velocity = -balls[i].velocity;
      balls[i].lastBounceUpdate = seg.now;
      balls[i].height = thisHeight;
    }

    if (seg.check1) {
      // "Collide": elastic collisions between balls sharing the track
      for (let j = i + 1; j < numBalls; j++) {
        if (balls[j].velocity !== balls[i].velocity) {
          // tcollided + balls[j].lastBounceUpdate is the actual collision
          // time (keeps precision through the long-to-float conversion).
          const tcollided =
            (cfac * (balls[i].height - balls[j].height) +
              balls[i].velocity *
                (balls[j].lastBounceUpdate - balls[i].lastBounceUpdate)) /
            (balls[j].velocity - balls[i].velocity);

          if (
            tcollided > 2 &&
            tcollided < seg.now - balls[j].lastBounceUpdate
          ) {
            balls[i].height =
              balls[i].height +
              (balls[i].velocity *
                (tcollided +
                  (balls[j].lastBounceUpdate - balls[i].lastBounceUpdate))) /
                cfac;
            balls[j].height = balls[i].height;
            balls[i].lastBounceUpdate =
              Math.trunc(tcollided + 0.5) + balls[j].lastBounceUpdate;
            balls[j].lastBounceUpdate = balls[i].lastBounceUpdate;
            const vtmp = balls[i].velocity;
            balls[i].velocity =
              ((balls[i].mass - balls[j].mass) * vtmp +
                2 * balls[j].mass * balls[j].velocity) /
              (balls[i].mass + balls[j].mass);
            balls[j].velocity =
              ((balls[j].mass - balls[i].mass) * balls[j].velocity +
                2 * balls[i].mass * vtmp) /
              (balls[i].mass + balls[j].mass);
            thisHeight =
              balls[i].height +
              (balls[i].velocity * (seg.now - balls[i].lastBounceUpdate)) /
                cfac;
          }
        }
      }
    }

    let color = seg.color(0);
    if (seg.palette) {
      color = seg.color_from_palette(
        Math.trunc((i * 255) / numBalls),
        false,
        false,
        0,
      );
    } else if (hasCol2) {
      color = seg.color(i % 3);
    }

    if (thisHeight < 0) thisHeight = 0;
    if (thisHeight > 1) thisHeight = 1;
    // Firmware's WLED_USE_AA_PIXELS sub-pixel positioning branch is a
    // hardware-output nicety that doesn't apply to this 1D RGB-buffer sim.
    const pos = Math.round(thisHeight * (seg.length - 1));
    seg.setPixelColor(pos, color);
    balls[i].lastBounceUpdate = seg.now;
    balls[i].height = thisHeight;
  }
}

interface Spark {
  pos: number;
  vel: number;
  colIndex: number;
}

// Firmware caps usable popcorn kernels by a device memory budget
// (FAIR_DATA_PER_SEG, 256-640 bytes depending on hardware) this sim has no
// equivalent for -- always uses the firmware max (21).
const MAX_POPCORN = 21;
const popcornState = new WeakMap<Segment, Spark[]>();

function modePopcorn(seg: Segment): void {
  if (seg.length <= 1) return fallbackStatic(seg);

  let popcorn = popcornState.get(seg);
  if (seg.call === 0 || !popcorn) {
    popcorn = Array.from({ length: MAX_POPCORN }, () => ({
      pos: -1,
      vel: 0,
      colIndex: 0,
    }));
    popcornState.set(seg, popcorn);
  }

  const hasCol2 = seg.color(2) !== 0;
  if (!seg.check2) seg.fill(hasCol2 ? BLACK : seg.color(1));

  let gravity = -0.0001 - seg.speed / 200000;
  gravity *= seg.length;

  let numPopcorn = Math.trunc((seg.intensity * MAX_POPCORN) / 255);
  if (numPopcorn === 0) numPopcorn = 1;

  for (let i = 0; i < numPopcorn; i++) {
    if (popcorn[i].pos >= 0) {
      popcorn[i].pos += popcorn[i].vel;
      popcorn[i].vel += gravity;
    } else if (seg.rng.random8() < 2) {
      popcorn[i].pos = 0.01;
      let peakHeight = 128 + seg.rng.random8(128);
      peakHeight = (peakHeight * (seg.length - 1)) >> 8;
      popcorn[i].vel = Math.sqrt(-2 * gravity * peakHeight);

      if (seg.palette) {
        popcorn[i].colIndex = seg.rng.random8();
      } else {
        let col = seg.rng.random8(0, 3);
        if (!seg.color(2) || !seg.color(col)) col = 0;
        popcorn[i].colIndex = col;
      }
    }
    if (popcorn[i].pos >= 0) {
      let col = seg.color_wheel(popcorn[i].colIndex);
      if (!seg.palette && popcorn[i].colIndex < 3)
        col = seg.color(popcorn[i].colIndex);
      const ledIndex = Math.trunc(popcorn[i].pos);
      if (ledIndex < seg.length) seg.setPixelColor(ledIndex, col);
    }
  }
}

// --- Fairy (49) / Fairytwinkle (51) --------------------------------------------
interface Flasher {
  stateStart: number;
  stateDur: number;
  stateOn: boolean;
}

const FLASHERS_PER_ZONE = 6;
const MAX_SHIMMER = 92;
const fairyFlashers = new WeakMap<Segment, Flasher[]>();

function modeFairy(seg: Segment): void {
  // strip.getCurrSegmentId() has no equivalent (no multi-segment concept) --
  // assumed segment 0, matching this sim's other single-segment assumptions.
  let prng16 = 5100 & 0xffff;
  for (let i = 0; i < seg.length; i++) {
    prng16 = (prng16 * 2053 + 1384) & 0xffff;
    seg.setPixelColor(i, seg.color_from_palette(prng16 >> 8, false, false, 0));
  }

  if (seg.intensity === 0) return;
  const flasherDistance = Math.trunc((255 - seg.intensity) / 28) + 1;
  const numFlashers = Math.trunc(seg.length / flasherDistance) + 1;

  let flashers = fairyFlashers.get(seg);
  if (!flashers || flashers.length !== numFlashers) {
    flashers = Array.from({ length: numFlashers }, () => ({
      stateStart: 0,
      stateDur: 0,
      stateOn: false,
    }));
    fairyFlashers.set(seg, flashers);
  }
  const now16 = seg.now & 0xffff;

  let zones = Math.trunc(numFlashers / FLASHERS_PER_ZONE);
  if (!zones) zones = 1;
  let flashersInZone = Math.trunc(numFlashers / zones);
  const flasherBri: number[] = new Array(FLASHERS_PER_ZONE * 2 - 1).fill(0);

  for (let z = 0; z < zones; z++) {
    let flasherBriSum = 0;
    const firstFlasher = z * flashersInZone;
    if (z === zones - 1)
      flashersInZone = numFlashers - flashersInZone * (zones - 1);

    for (let f = firstFlasher; f < firstFlasher + flashersInZone; f++) {
      let stateTime = (now16 - flashers[f].stateStart) & 0xffff;
      if (stateTime > flashers[f].stateDur * 10) {
        flashers[f].stateOn = !flashers[f].stateOn;
        if (flashers[f].stateOn) {
          flashers[f].stateDur =
            12 + seg.rng.random8(12 + ((255 - seg.speed) >> 2));
        } else {
          flashers[f].stateDur =
            20 + seg.rng.random8(6 + ((255 - seg.speed) >> 2));
        }
        flashers[f].stateStart = now16;
        if (stateTime < 255) {
          flashers[f].stateStart =
            (flashers[f].stateStart - (255 - stateTime)) & 0xffff;
          flashers[f].stateDur += 26 - Math.trunc(stateTime / 10);
          stateTime = 255 - stateTime;
        } else {
          stateTime = 0;
        }
      }
      if (stateTime > 255) stateTime = 255;
      flasherBri[f - firstFlasher] = flashers[f].stateOn
        ? stateTime
        : 255 - stateTime;
      flasherBriSum += flasherBri[f - firstFlasher];
    }

    const avgFlasherBri = Math.trunc(flasherBriSum / flashersInZone);
    const globalPeakBri = 255 - ((avgFlasherBri * MAX_SHIMMER) >> 8);

    for (let f = firstFlasher; f < firstFlasher + flashersInZone; f++) {
      const bri = Math.trunc(
        (flasherBri[f - firstFlasher] * globalPeakBri) / 255,
      );
      prng16 = (prng16 * 2053 + 1384) & 0xffff;
      const flasherPos = f * flasherDistance;
      seg.setPixelColor(
        flasherPos,
        color_blend(
          seg.color(1),
          seg.color_from_palette(prng16 >> 8, false, false, 0),
          bri,
        ),
      );
      for (
        let i = flasherPos + 1;
        i < flasherPos + flasherDistance && i < seg.length;
        i++
      ) {
        prng16 = (prng16 * 2053 + 1384) & 0xffff;
        seg.setPixelColor(
          i,
          seg.color_from_palette(prng16 >> 8, false, false, 0, globalPeakBri),
        );
      }
    }
  }
}

const fairytwinkleFlashers = new WeakMap<Segment, Flasher[]>();

function modeFairytwinkle(seg: Segment): void {
  let flashers = fairytwinkleFlashers.get(seg);
  if (!flashers || flashers.length !== seg.length) {
    flashers = Array.from({ length: seg.length }, () => ({
      stateStart: 0,
      stateDur: 0,
      stateOn: false,
    }));
    fairytwinkleFlashers.set(seg, flashers);
  }
  const now16 = seg.now & 0xffff;
  let prng16 = 5100 & 0xffff; // strip.getCurrSegmentId() -- assumed segment 0

  const riseFallTime = 400 + (255 - seg.speed) * 3;
  const maxDur =
    Math.trunc(riseFallTime / 100) +
    ((255 - seg.intensity) >> 2) +
    13 +
    ((255 - seg.intensity) >> 1);

  for (let f = 0; f < seg.length; f++) {
    let stateTime = (now16 - flashers[f].stateStart) & 0xffff;
    if (stateTime > flashers[f].stateDur * 100) {
      flashers[f].stateOn = !flashers[f].stateOn;
      const init = flashers[f].stateDur === 0;
      if (flashers[f].stateOn) {
        flashers[f].stateDur =
          Math.trunc(riseFallTime / 100) +
          ((255 - seg.intensity) >> 2) +
          seg.rng.random8(12 + ((255 - seg.intensity) >> 1)) +
          1;
      } else {
        flashers[f].stateDur =
          Math.trunc(riseFallTime / 100) +
          seg.rng.random8(3 + ((255 - seg.speed) >> 6)) +
          1;
      }
      flashers[f].stateStart = now16;
      stateTime = 0;
      if (init) {
        flashers[f].stateStart =
          (flashers[f].stateStart - riseFallTime) & 0xffff;
        flashers[f].stateDur =
          Math.trunc(riseFallTime / 100) +
          seg.rng.random8(12 + ((255 - seg.intensity) >> 1)) +
          5;
        stateTime = riseFallTime;
      }
    }
    if (flashers[f].stateOn && flashers[f].stateDur > maxDur)
      flashers[f].stateDur = maxDur;
    if (stateTime > riseFallTime) stateTime = riseFallTime;
    const fadeprog = 255 - Math.trunc((stateTime * 255) / riseFallTime);
    const flasherBri = flashers[f].stateOn
      ? 255 - gamma8(fadeprog)
      : gamma8(fadeprog);
    const lastR = prng16;
    let diff = 0;
    while (diff < 0x4000) {
      prng16 = (prng16 * 2053 + 1384) & 0xffff;
      diff = prng16 > lastR ? prng16 - lastR : lastR - prng16;
    }
    seg.setPixelColor(
      f,
      color_blend(
        seg.color(1),
        seg.color_from_palette(prng16 >> 8, false, false, 0),
        flasherBri,
      ),
    );
  }
}

// --- Twinkleup (106) ------------------------------------------------------
// Firmware reseeds a *second*, globally-shared `prng` (distinct from
// hw_random8/16, which seg.rng already stands in for elsewhere) to a fixed
// seed each call, then restores the caller's seed afterward -- deliberate,
// so every frame redraws the exact same per-pixel pattern. This sim just
// creates a fresh local instance each call instead: same effect (always
// starts from the same seed), no shared global state to save/restore.
function modeTwinkleup(seg: Segment): void {
  const localPrng = new PRNG(535);
  for (let i = 0; i < seg.length; i++) {
    const ranstart = localPrng.random8();
    let pixBri = sin8(
      (ranstart + Math.trunc((16 * seg.now) / (256 - seg.speed))) & 0xff,
    );
    if (localPrng.random8() > seg.intensity) pixBri = 0;
    seg.setPixelColor(
      i,
      color_blend(
        seg.color(1),
        seg.color_from_palette(
          localPrng.random8() + Math.trunc(seg.now / 100),
          false,
          false,
          0,
        ),
        pixBri,
      ),
    );
  }
}

// --- Ripple (79) / Ripple Rainbow (99) -----------------------------------------
interface RippleDrop {
  state: number;
  pos: number;
  color: number;
}

const MAX_RIPPLES = 100; // firmware's ESP32 default; no device memory ceiling here
const rippleState = new WeakMap<Segment, RippleDrop[]>();

function rippleBase(seg: Segment, blurAmount = 0): void {
  if (seg.length <= 1) return fallbackStatic(seg);

  const maxRipples = Math.min(1 + (seg.length >> 2), MAX_RIPPLES);
  let ripples = rippleState.get(seg);
  if (!ripples || ripples.length !== maxRipples) {
    ripples = Array.from({ length: maxRipples }, () => ({
      state: 0,
      pos: 0,
      color: 0,
    }));
    rippleState.set(seg, ripples);
  }

  for (const ripple of ripples) {
    if (ripple.state) {
      const rippledecay = (seg.speed >> 4) + 1;
      const rippleorigin = ripple.pos;
      const col = seg.color_from_palette(ripple.color, false, false, 255);
      const propagation =
        (Math.trunc(ripple.state / rippledecay) - 1) * (seg.speed + 1);
      const propI = propagation >> 8;
      const propF = propagation & 0xff;
      const amp =
        ripple.state < 17
          ? triwave8(((ripple.state - 1) * 8) & 0xff)
          : map(ripple.state, 17, 255, 255, 2);

      const left = rippleorigin - propI - 1;
      const right = rippleorigin + propI + 2;
      for (let v = 0; v < 4; v++) {
        const mag = scale8(cubicwave8(((propF >> 2) + v * 64) & 0xff), amp);
        seg.setPixelColor(
          left + v,
          color_blend(seg.getPixelColor(left + v), col, mag),
        );
        seg.setPixelColor(
          right - v,
          color_blend(seg.getPixelColor(right - v), col, mag),
        );
      }

      const next = ripple.state + rippledecay;
      ripple.state = next > 254 ? 0 : next;
    } else if (seg.rng.random16(5100 + 10000) <= seg.intensity) {
      ripple.state = 1;
      ripple.pos = seg.rng.random16(seg.length);
      ripple.color = seg.rng.random8();
    }
  }

  seg.blur(blurAmount);
}

function modeRipple(seg: Segment): void {
  if (seg.length <= 1) return fallbackStatic(seg);
  if (seg.custom1 || seg.check2) {
    seg.fade_out(250);
  } else {
    seg.fill(seg.color(1));
  }
  rippleBase(seg, seg.custom1 >> 1);
}

function modeRippleRainbow(seg: Segment): void {
  if (seg.length <= 1) return fallbackStatic(seg);
  if (seg.call === 0) {
    seg.aux0 = seg.rng.random8();
    seg.aux1 = seg.rng.random8();
  }
  if (seg.aux0 === seg.aux1) {
    seg.aux1 = seg.rng.random8();
  } else if (seg.aux1 > seg.aux0) {
    seg.aux0 = (seg.aux0 + 1) & 0xff;
  } else {
    seg.aux0 = (seg.aux0 - 1) & 0xff;
  }
  seg.fill(color_blend(seg.color_wheel(seg.aux0), BLACK, 235));
  rippleBase(seg);
}

// --- Two Dots (50) --------------------------------------------------------
function modeTwoDots(seg: Segment): void {
  if (seg.length <= 1) return fallbackStatic(seg);
  const delay = 1 + Math.trunc((FRAMETIME << 3) / seg.length);
  const it = Math.trunc(seg.now / map(seg.speed, 0, 255, delay << 4, delay));
  const offset = it % seg.length;
  let width = (seg.length * (seg.intensity + 1)) >> 9;
  if (!width) width = 1;
  if (!seg.check2) seg.fill(seg.color(2));
  const color1 = seg.color(0);
  const color2 = seg.color(1) === seg.color(2) ? color1 : seg.color(1);
  for (let i = 0; i < width; i++) {
    const indexR = (offset + i) % seg.length;
    const indexB = (offset + i + (seg.length >> 1)) % seg.length;
    seg.setPixelColor(indexR, color1);
    seg.setPixelColor(indexB, color2);
  }
}

// --- Dynamic (7) / Dynamic Smooth (117) ----------------------------------------
function modeDynamicImpl(seg: Segment, smooth: boolean): void {
  const data = seg.allocateData(seg.length);

  if (seg.call === 0) {
    for (let i = 0; i < seg.length; i++) data[i] = seg.rng.random8();
  }

  const cycleTime = 50 + (255 - seg.speed) * 15;
  const it = Math.trunc(seg.now / cycleTime);
  if (it !== seg.step && seg.speed !== 0) {
    for (let i = 0; i < seg.length; i++) {
      if (seg.rng.random8() <= seg.intensity) data[i] = seg.rng.random8();
    }
    seg.step = it;
  }

  if (smooth) {
    for (let i = 0; i < seg.length; i++) {
      blendPixelColor(seg, i, seg.color_wheel(data[i]), 16);
    }
  } else {
    for (let i = 0; i < seg.length; i++) {
      seg.setPixelColor(i, seg.color_wheel(data[i]));
    }
  }
}

function modeDynamic(seg: Segment): void {
  modeDynamicImpl(seg, seg.check1);
}

function modeDynamicSmooth(seg: Segment): void {
  modeDynamicImpl(seg, true);
}

// --- Rain (43) -------------------------------------------------------------
function modeRain(seg: Segment): void {
  if (seg.length <= 1) return fallbackStatic(seg);
  seg.step += FRAMETIME;
  const speedFormulaL = 5 + Math.trunc((50 * (255 - seg.speed)) / seg.length);
  if (seg.call && seg.step > speedFormulaL) {
    seg.step = 1;
    const ctemp = seg.getPixelColor(0);
    for (let i = 0; i < seg.length - 1; i++) {
      seg.setPixelColor(i, seg.getPixelColor(i + 1));
    }
    seg.setPixelColor(seg.length - 1, ctemp);
    seg.aux0++;
    seg.aux1++;
    if (seg.aux0 === 0) seg.aux0 = 0xffff;
    // Firmware's own source sets aux0 (not aux1) on this line too -- a real
    // copy-paste quirk in mode_rain(), preserved faithfully.
    if (seg.aux1 === 0) seg.aux0 = 0xffff;
    if (seg.aux0 >= seg.length) seg.aux0 = 0;
    if (seg.aux1 >= seg.length) seg.aux1 = 0;
  }
  modeFireworks(seg);
}

// --- Lake (75) ---------------------------------------------------------------
function modeLake(seg: Segment): void {
  const sp = Math.trunc(seg.speed / 10);
  const wave1 = beatsin8_t(sp + 2, seg.now, -64, 64);
  const wave2 = beatsin8_t(sp + 1, seg.now, -64, 64);
  const wave3 = beatsin8_t(sp + 2, seg.now, 0, 80);

  for (let i = 0; i < seg.length; i++) {
    const index =
      Math.trunc(cos8((i * 15 + wave1) & 0xff) / 2) +
      Math.trunc(cubicwave8((i * 23 + wave2) & 0xff) / 2);
    const lum = index > wave3 ? index - wave3 : 0;
    seg.setPixelColor(i, seg.color_from_palette(index, false, false, 0, lum));
  }
}

// --- Heartbeat (100) ------------------------------------------------------
function modeHeartbeat(seg: Segment): void {
  const bpm = 40 + (seg.speed >> 3);
  const msPerBeat = Math.trunc(60000 / bpm);
  const secondBeat = Math.trunc(msPerBeat / 3);
  let briLower = seg.aux1;
  const beatTimer = seg.now - seg.step;

  briLower = Math.trunc((briLower * 2042) / (2048 + seg.intensity));
  seg.aux1 = briLower;

  if (beatTimer > secondBeat && !seg.aux0) {
    seg.aux1 = 0xffff;
    seg.aux0 = 1;
  }
  if (beatTimer > msPerBeat) {
    seg.aux1 = 0xffff;
    seg.aux0 = 0;
    seg.step = seg.now;
  }

  for (let i = 0; i < seg.length; i++) {
    seg.setPixelColor(
      i,
      color_blend(
        seg.color_from_palette(i, true, false, 0),
        seg.color(1),
        255 - (seg.aux1 >> 8),
      ),
    );
  }
}

// --- Chunchun (111) ------------------------------------------------------
function modeChunchun(seg: Segment): void {
  if (seg.length <= 1) return fallbackStatic(seg);
  seg.fade_out(254);
  let counter = (seg.now * (6 + (seg.speed >> 4))) >>> 0;
  const numBirds = 2 + (seg.length >> 3);
  const span = Math.trunc((seg.intensity << 8) / numBirds);

  for (let i = 0; i < numBirds; i++) {
    counter = (counter - span) >>> 0;
    const megumin = (sin16(counter & 0xffff) + 0x8000) & 0xffff;
    let bird = Math.trunc((megumin * seg.length) / 65536);
    bird = Math.min(Math.max(bird, 0), seg.length - 1);
    seg.setPixelColor(
      bird,
      seg.color_from_palette(Math.trunc((i * 255) / numBirds), false, false, 0),
    );
  }
}

// --- Railway (78) --------------------------------------------------------
function modeRailway(seg: Segment): void {
  if (seg.length <= 1) return fallbackStatic(seg);
  const dur = (256 - seg.speed) * 40;
  const rampdur = (dur * seg.intensity) >> 8;
  if (seg.step > dur) {
    seg.step = 0;
    seg.aux0 = seg.aux0 ? 0 : 1;
  }
  let pos = 255;
  if (rampdur !== 0) {
    const p0 = Math.trunc((seg.step * 255) / rampdur);
    if (p0 < 255) pos = p0;
  }
  if (seg.aux0) pos = 255 - pos;
  for (let i = 0; i < seg.length; i += 2) {
    seg.setPixelColor(i, seg.color_from_palette(255 - pos, false, false, 255));
    if (i < seg.length - 1) {
      seg.setPixelColor(i + 1, seg.color_from_palette(pos, false, false, 255));
    }
  }
  seg.step += FRAMETIME;
}

// --- Solid Pattern (83) / Solid Pattern Tri (84) -------------------------
function modeStaticPattern(seg: Segment): void {
  const lit = 1 + seg.speed;
  const unlit = 1 + seg.intensity;
  let drawingLit = true;
  let cnt = 0;

  for (let i = 0; i < seg.length; i++) {
    seg.setPixelColor(
      i,
      drawingLit ? seg.color_from_palette(i, true, false, 0) : seg.color(1),
    );
    cnt++;
    if (cnt >= (drawingLit ? lit : unlit)) {
      cnt = 0;
      drawingLit = !drawingLit;
    }
  }
}

function modeTriStaticPattern(seg: Segment): void {
  const segSize = (seg.intensity >> 5) + 1;
  let currSeg = 0;
  let currSegCount = 0;

  for (let i = 0; i < seg.length; i++) {
    if (currSeg % 3 === 0) seg.setPixelColor(i, seg.color(0));
    else if (currSeg % 3 === 1) seg.setPixelColor(i, seg.color(1));
    else seg.setPixelColor(i, seg.color(2));
    currSegCount += 1;
    if (currSegCount >= segSize) {
      currSeg += 1;
      currSegCount = 0;
    }
  }
}

// --- Spots (85) / Spots Fade (86) -----------------------------------------
function spotsBase(seg: Segment, threshold: number): void {
  if (seg.length <= 1) return fallbackStatic(seg);
  if (!seg.check2) seg.fill(seg.color(1));

  const maxZones = seg.length >> 2;
  const zones = 1 + ((seg.intensity * maxZones) >> 8);
  const zoneLen = Math.trunc(seg.length / zones);
  const offset = (seg.length - zones * zoneLen) >> 1;

  for (let z = 0; z < zones; z++) {
    const pos = offset + z * zoneLen;
    for (let i = 0; i < zoneLen; i++) {
      const wave = triwave16(Math.trunc((i * 0xffff) / zoneLen));
      if (wave > threshold) {
        const index = pos + i;
        const s = Math.trunc(((wave - threshold) * 255) / (0xffff - threshold));
        seg.setPixelColor(
          index,
          color_blend(
            seg.color_from_palette(index, true, false, 0),
            seg.color(1),
            255 - s,
          ),
        );
      }
    }
  }
}

function modeSpots(seg: Segment): void {
  spotsBase(seg, (255 - seg.speed) << 8);
}

function modeSpotsFade(seg: Segment): void {
  const counter = (seg.now * ((seg.speed >> 2) + 8)) >>> 0;
  const t = triwave16(counter & 0xffff);
  const tr = (t >> 1) + (t >> 2);
  spotsBase(seg, tr);
}

// --- Phased (105) / Phased Noise (109) ---------------------------------------
// Shared base (WLED phased_base(uint8_t moder)) -- moder=0 (id 105) is the
// original fixed modulus-5 sine phasing; moder=1 (id 109) replaces the fixed
// modulus with one drawn from Perlin noise each pixel.
function phasedBase(seg: Segment, moder: number): void {
  const allfreq = 16;
  // Firmware bit-reinterprets SEGENV.step as a float to smuggle a float
  // through a uint32 field; seg.step is already a plain number, so it holds
  // the float phase directly -- no reinterpretation needed.
  let phase = seg.step;
  const cutOff = 255 - seg.intensity;
  let modVal = 5;

  let index = Math.trunc(seg.now / 64);
  phase += seg.speed / 32;

  for (let i = 0; i < seg.length; i++) {
    if (moder === 1) modVal = Math.trunc(inoise8(i * 10 + i * 10) / 16);
    let val = (i + 1) * allfreq;
    if (modVal === 0) modVal = 1;
    val += Math.trunc((phase * ((i % modVal) + 1)) / 2);
    let b = cubicwave8(val & 0xff);
    b = b > cutOff ? b - cutOff : 0;
    seg.setPixelColor(
      i,
      color_blend(
        seg.color(1),
        seg.color_from_palette(index & 0xff, false, false, 0),
        b,
      ),
    );
    index += Math.trunc(256 / seg.length);
    if (seg.length > 256) index++;
  }

  seg.step = phase;
}

function modePhased(seg: Segment): void {
  phasedBase(seg, 0);
}

function modePhasedNoise(seg: Segment): void {
  phasedBase(seg, 1);
}

// --- Saw (16) ----------------------------------------------------------------
function modeSaw(seg: Segment): void {
  const xScale = seg.intensity >> 2;
  const counter = (seg.now * seg.speed) >> 9;

  for (let i = 0; i < seg.length; i++) {
    let a = (i * xScale - counter) & 0xff;
    if (a < 16) {
      a = 192 + a * 8;
    } else {
      a = map(a, 16, 255, 64, 192);
    }
    a = 255 - a;
    const s = sin8(a & 0xff);
    seg.setPixelColor(
      i,
      color_blend(seg.color(1), seg.color_from_palette(i, true, false, 0), s),
    );
  }
}

// --- Wavesins (184) ------------------------------------------------------
function modeWavesins(seg: Segment): void {
  for (let i = 0; i < seg.length; i++) {
    const bri = sin8((Math.trunc(seg.now / 4) + i * seg.intensity) & 0xff);
    const index = beatsin8_t(
      seg.speed,
      seg.now,
      seg.custom1,
      seg.custom1 + seg.custom2,
      0,
      i * (seg.custom3 << 3),
    );
    seg.setPixelColor(i, seg.color_from_palette(index, false, false, 0, bri));
  }
}

// --- Halloween Eyes (82) -----------------------------------------------------
// Single-struct-per-Segment WeakMap state, same tier as Tetrix's TetrisDrop.
// State values are plain numeric constants (not a TS enum) matching this
// file's existing style -- no enum is used anywhere else in this module.
const EYE_INIT_ON = 0;
const EYE_ON = 1;
const EYE_BLINK = 2;
const EYE_INIT_OFF = 3;
const EYE_OFF = 4;
const EYE_STATE_COUNT = 5;

interface EyeData {
  state: number;
  color: number;
  startPos: number;
  duration: number;
  startTime: number;
  blinkEndTime: number;
}

const eyeDataState = new WeakMap<Segment, EyeData>();

function modeHalloweenEyes(seg: Segment): void {
  if (seg.length <= 1) return fallbackStatic(seg);

  // strip.isMatrix is always false (1D-only sim) -- maxWidth collapses to
  // SEGLEN, and the matrix-only SEG_H/offset branch is dead code here.
  const maxWidth = seg.length;
  const eyeSpace = Math.max(2, seg.length >> 5);
  const eyeWidth = eyeSpace >> 1;
  const eyeLength = 2 * eyeWidth + eyeSpace;
  if (eyeLength >= maxWidth) return fallbackStatic(seg); // segment too short

  let data = eyeDataState.get(seg);
  if (seg.call === 0 || !data) {
    // Fresh allocateData() zero-fills (FX_fcn.cpp allocateData at call==0),
    // so state starts at 0 (EYE_INIT_ON) same as the real firmware.
    data = {
      state: EYE_INIT_ON,
      color: 0,
      startPos: 0,
      duration: 0,
      startTime: 0,
      blinkEndTime: 0,
    };
    eyeDataState.set(seg, data);
  }

  if (!seg.check2) seg.fill(seg.color(1)); // fill background

  data.state = data.state % EYE_STATE_COUNT;
  let duration = Math.max(1, data.duration);
  const elapsedTime = seg.now - data.startTime;

  // The real firmware's switch deliberately falls through
  // initializeOn -> on and initializeOff -> off (no `break`) so a freshly
  // (re)initialized state renders immediately instead of waiting a frame.
  // Preserved as-is rather than split into clean separate cases.
  switch (data.state) {
    case EYE_INIT_ON: {
      data.startPos = seg.rng.random16(0, maxWidth - eyeLength - 1);
      data.color = seg.rng.random8();
      duration = 128 + seg.rng.random16(seg.intensity * 64);
      data.duration = duration;
      data.state = EYE_ON;
    }
    // falls through
    case EYE_ON: {
      const start2ndEye = data.startPos + eyeWidth + eyeSpace;
      duration = Math.min(duration, 128 + seg.intensity * 64);

      const minimumOnTimeBegin = 1024;
      const minimumOnTimeEnd = 1024;
      const fadeInAnimationState = Math.trunc(
        (elapsedTime * (256 * 8)) / duration,
      );
      const backgroundColor = seg.color(1);
      const eyeColor = seg.color_from_palette(data.color, false, false, 0);
      let c = eyeColor;
      if (fadeInAnimationState < 256) {
        c = color_blend(backgroundColor, eyeColor, fadeInAnimationState & 0xff);
      } else if (elapsedTime > minimumOnTimeBegin) {
        const remainingTime =
          elapsedTime >= duration ? 0 : duration - elapsedTime;
        if (remainingTime > minimumOnTimeEnd) {
          if (seg.rng.random8() < 4) {
            c = backgroundColor;
            data.state = EYE_BLINK;
            data.blinkEndTime = seg.now + seg.rng.random8(8, 128);
          }
        }
      }

      if (c !== backgroundColor) {
        for (let i = 0; i < eyeWidth; i++) {
          seg.setPixelColor(data.startPos + i, c);
          seg.setPixelColor(start2ndEye + i, c);
        }
      }
      break;
    }
    case EYE_BLINK: {
      if (seg.now >= data.blinkEndTime) data.state = EYE_ON;
      break;
    }
    case EYE_INIT_OFF: {
      const eyeOffTimeBase = seg.speed * 128;
      duration = eyeOffTimeBase + seg.rng.random16(eyeOffTimeBase);
      data.duration = duration;
      data.state = EYE_OFF;
    }
    // falls through
    case EYE_OFF: {
      const eyeOffTimeBase = seg.speed * 128;
      duration = Math.min(duration, 2 * eyeOffTimeBase);
      break;
    }
    case EYE_STATE_COUNT:
    default: {
      data.state = EYE_INIT_ON;
      break;
    }
  }

  if (elapsedTime > duration) {
    switch (data.state) {
      case EYE_INIT_ON:
      case EYE_ON:
      case EYE_BLINK:
        data.state = EYE_INIT_OFF;
        break;
      case EYE_INIT_OFF:
      case EYE_OFF:
      case EYE_STATE_COUNT:
      default:
        data.state = EYE_INIT_ON;
        break;
    }
    data.startTime = seg.now;
  }
}

// --- Dancing Shadows (112) ---------------------------------------------------
// Ports the classic per-spotlight-struct implementation (FX.cpp's
// `#ifdef WLED_PS_DONT_REPLACE_1D_FX` branch) rather than the particle-system
// replacement in the `#else` branch -- same precedent as batch 2 excluding PS
// Sparkler: the particle-system engine (FXparticleSystem.h/.cpp) is a whole
// separate framework not vendored here, so the struct-array version (fully
// self-contained in FX.cpp) is the one that's actually portable.
interface Spotlight {
  speed: number;
  colorIdx: number;
  position: number;
  lastUpdateTime: number;
  width: number;
  type: number;
}

const SPOT_TYPE_SOLID = 0;
const SPOT_TYPE_GRADIENT = 1;
const SPOT_TYPE_2X_GRADIENT = 2;
const SPOT_TYPE_2X_DOT = 3;
const SPOT_TYPE_3X_DOT = 4;
const SPOT_TYPE_4X_DOT = 5;
const SPOT_TYPES_COUNT = 6;
const SPOT_MAX_COUNT = 49; // firmware's ESP32 default; no device memory ceiling here

const dancingShadowsState = new WeakMap<Segment, Spotlight[]>();

function modeDancingShadows(seg: Segment): void {
  if (seg.length <= 1) return fallbackStatic(seg);

  const numSpotlights = map(seg.intensity, 0, 255, 2, SPOT_MAX_COUNT);
  // A settings change (numSpotlights derived from the intensity slider)
  // forces a full reinit, same as the real firmware's aux0 comparison --
  // the WeakMap value is rebuilt, not just resized/left stale.
  const initialize = seg.aux0 !== numSpotlights;
  seg.aux0 = numSpotlights;

  let spotlights = dancingShadowsState.get(seg);
  if (initialize || !spotlights || spotlights.length !== numSpotlights) {
    spotlights = Array.from({ length: numSpotlights }, () => ({
      speed: 0,
      colorIdx: 0,
      position: 0,
      lastUpdateTime: 0,
      width: 0,
      type: 0,
    }));
    dancingShadowsState.set(seg, spotlights);
  }

  seg.fill(BLACK);

  const time = seg.now;
  let respawn = false;

  for (let i = 0; i < numSpotlights; i++) {
    const spot = spotlights[i];
    if (!initialize) {
      // advance the position of the spotlight
      const delta = Math.trunc(
        (time - spot.lastUpdateTime) *
          (spot.speed * ((1.0 + seg.speed) / 100.0)),
      );
      if (Math.abs(delta) >= 1) {
        spot.position += delta;
        spot.lastUpdateTime = time;
      }
      respawn =
        (spot.speed > 0.0 && spot.position > seg.length + 2) ||
        (spot.speed < 0.0 && spot.position < -(spot.width + 2));
    }

    if (initialize || respawn) {
      spot.colorIdx = seg.rng.random8();
      spot.width = seg.rng.random8(1, 10);
      spot.speed = 1.0 / seg.rng.random8(4, 50);

      if (initialize) {
        spot.position = seg.rng.random16(seg.length);
        spot.speed *= seg.rng.random8(2) ? 1.0 : -1.0;
      } else {
        if (seg.rng.random8(2)) {
          spot.position = seg.length + spot.width;
          spot.speed *= -1.0;
        } else {
          spot.position = -spot.width;
        }
      }
      spot.lastUpdateTime = time;
      spot.type = seg.rng.random8(SPOT_TYPES_COUNT);
    }

    // mcol=255 (>2) bypasses the "default palette -> raw segment color"
    // shortcut so spotlights get real per-colorIdx palette variation even
    // on the default (Party) palette -- same sentinel used by Sunrise (104).
    const color = seg.color_from_palette(spot.colorIdx, false, false, 255);
    const start = spot.position;

    if (spot.width <= 1) {
      if (start >= 0 && start < seg.length) {
        blendPixelColor(seg, start, color, 128);
      }
    } else {
      switch (spot.type) {
        case SPOT_TYPE_SOLID:
          for (let j = 0; j < spot.width; j++) {
            if (start + j >= 0 && start + j < seg.length) {
              blendPixelColor(seg, start + j, color, 128);
            }
          }
          break;
        case SPOT_TYPE_GRADIENT:
          for (let j = 0; j < spot.width; j++) {
            if (start + j >= 0 && start + j < seg.length) {
              blendPixelColor(
                seg,
                start + j,
                color,
                cubicwave8(map(j, 0, spot.width - 1, 0, 255)),
              );
            }
          }
          break;
        case SPOT_TYPE_2X_GRADIENT:
          for (let j = 0; j < spot.width; j++) {
            if (start + j >= 0 && start + j < seg.length) {
              blendPixelColor(
                seg,
                start + j,
                color,
                cubicwave8(2 * map(j, 0, spot.width - 1, 0, 255)),
              );
            }
          }
          break;
        case SPOT_TYPE_2X_DOT:
          for (let j = 0; j < spot.width; j += 2) {
            if (start + j >= 0 && start + j < seg.length) {
              blendPixelColor(seg, start + j, color, 128);
            }
          }
          break;
        case SPOT_TYPE_3X_DOT:
          for (let j = 0; j < spot.width; j += 3) {
            if (start + j >= 0 && start + j < seg.length) {
              blendPixelColor(seg, start + j, color, 128);
            }
          }
          break;
        case SPOT_TYPE_4X_DOT:
          for (let j = 0; j < spot.width; j += 4) {
            if (start + j >= 0 && start + j < seg.length) {
              blendPixelColor(seg, start + j, color, 128);
            }
          }
          break;
      }
    }
  }
}

// --- Palette (65) -------------------------------------------------------
// ESP32 float-math path only (this sim assumes a float-capable target
// elsewhere, per decisions.md 2026-07-03). Real firmware treats each
// *segment* as one row of an imaginary multi-row display
// (yFrom=yTo=strip.getCurrSegmentId(), rows=strip.getActiveSegmentsNum())
// so a rotation becomes visible across rows when multiple segments are
// active. This sim has no multi-segment concept -- strip.getCurrSegmentId()
// is assumed 0 (same precedent as Fairy/Fairytwinkle/Palette's own mcol=255
// sibling in Dancing Shadows above), and getActiveSegmentsNum() is assumed 1
// (same category as nrOfVStrips()==1). rows collapses to 1 and only that
// single row ever renders -- no visible row rotation, which is the expected
// single-segment result here, not a bug.
function modePalette(seg: Segment): void {
  const cols = seg.length;
  const rows = 1;

  const inputShift = seg.speed;
  const inputSize = seg.intensity;
  const inputRotation = seg.custom1;
  const inputAnimateShift = seg.check1;
  const inputAnimateRotation = seg.check2;
  const inputAssumeSquare = seg.check3;

  const maxAngle = Math.PI / 256;
  const animatedRotationScale = (2 * Math.PI) / 0xffff;

  const theta = !inputAnimateRotation
    ? (inputRotation + 128) * maxAngle
    : ((seg.now * ((inputRotation >> 4) + 1)) & 0xffff) * animatedRotationScale;
  const sinTheta = sin_approx(theta);
  const cosTheta = cos_approx(theta);

  const maxX = Math.max(1, cols - 1);
  const maxY = Math.max(1, rows - 1);
  const maxXIn = inputAssumeSquare ? maxX : 1;
  const maxYIn = inputAssumeSquare ? maxY : 1;
  const maxXOut = !inputAssumeSquare ? maxX : 1;
  const maxYOut = !inputAssumeSquare ? maxY : 1;
  const centerX = maxXOut / 2;
  const centerY = maxYOut / 2;
  const scale = Math.abs(sinTheta) + (Math.abs(cosTheta) * maxYOut) / maxXOut;

  const y = 0; // yFrom = yTo = strip.getCurrSegmentId(), assumed 0
  const ytCosTheta = (cosTheta * (y - centerY * maxYIn)) / (maxYIn * scale);
  for (let x = 0; x < cols; x++) {
    const xtSinTheta = (sinTheta * (x - centerX * maxXIn)) / (maxXIn * scale);
    const sourceX = xtSinTheta + ytCosTheta + centerX;
    let colorIndex = Math.trunc(
      (Math.min(Math.max(sourceX, 0), maxXOut) * 255) / maxXOut,
    );
    if (inputSize <= 128) {
      colorIndex = Math.trunc((colorIndex * inputSize) / 128);
    } else {
      colorIndex = Math.trunc(((inputSize - 112) * colorIndex) / 16);
    }
    const paletteOffset = !inputAnimateShift
      ? inputShift
      : ((seg.now * ((inputShift >> 3) + 1)) & 0xffff) >> 8;
    colorIndex -= paletteOffset;
    seg.setPixelColor(x, seg.color_wheel(colorIndex & 0xff));
  }
}

// --- ICU (58) ----------------------------------------------------------------
// A plain state machine driving a pair of "eyes" that dart to random
// positions -- no allocateData() at all. State packs into seg.step (upper 16
// bits = state enum, lower 16 bits = next-update time), mirroring firmware's
// bit-packed SEGENV.step, plus aux0 (move target) / aux1 (current position).
// Firmware has no SEGLEN<=1 guard here either; the math holds up fine at
// length 1 (no division by a zero segment length anywhere), so none is added.
function modeIcu(seg: Segment): void {
  const now16 = seg.now & 0xffff;
  let dest = seg.aux1;
  const space = (seg.intensity >> 3) + 2;
  const eyeGap = Math.trunc(seg.length / space);
  let state = (seg.step >>> 16) & 0xffff;
  let nextUpdate = seg.step & 0xffff;

  const destRange = seg.length - eyeGap;
  const pindex = map(dest, 0, destRange, 0, 255) & 0xff;
  const col = seg.color_from_palette(pindex, false, false, 0);
  const bgcol = seg.check2 ? BLACK : seg.color(1);
  seg.fill(bgcol);

  // draw eyes if not blinking
  if (state !== 1) {
    seg.setPixelColor(dest, col);
    seg.setPixelColor(dest + eyeGap, col);
    // render next position if moving
    if (state === 3) {
      if (seg.aux0 > seg.aux1) dest++;
      else if (seg.aux0 < seg.aux1) dest--;
      seg.setPixelColor(dest, col);
      seg.setPixelColor(dest + eyeGap, col);
    }
  }

  // update state -- (int16_t)(now-nextUpdate) >= 0, i.e. handle 16-bit wrap
  const diff16 = (now16 - nextUpdate) & 0xffff;
  const signedDiff = diff16 >= 0x8000 ? diff16 - 0x10000 : diff16;
  if (signedDiff >= 0) {
    switch (state) {
      case 0: // pause part 1
        state = 1;
        if (seg.rng.random8(6) === 0) {
          // blink once in a while
          nextUpdate = (now16 + 200) & 0xffff;
          break;
        }
      // falls through if not blinking
      case 1: // blink
        nextUpdate = (now16 + 500 + seg.rng.random16(1000)) & 0xffff;
        state = 2;
        break;
      case 2: // pause part 2
        seg.aux0 = seg.rng.random16(destRange); // choose a new destination
        nextUpdate = now16;
        state = 3;
        break;
      default: // move (state 3)
        seg.aux1 = dest; // update destination to moved position
        nextUpdate =
          (now16 + 5 + Math.trunc((50 * (255 - seg.speed)) / seg.length)) &
          0xffff; // SPEED_FORMULA_L
        if (seg.aux0 === dest) {
          // reached destination
          nextUpdate = (now16 + 500 + seg.rng.random16(1000)) & 0xffff;
          state = 0;
        }
        break;
    }
  }

  seg.step = (state << 16) | nextUpdate;
}

// --- Solid Glitter (103) -------------------------------------------------------
// Solid color1 background with glitter overlaid via the already-existing
// glitterBase helper (shared with Glitter, 87).
function modeSolidGlitter(seg: Segment): void {
  seg.fill(seg.color(0));
  // Firmware's fallback here is ULTRAWHITE (0xFFFFFFFF); the existing Glitter
  // (87) port above already uses this sim's plain WHITE (0xFFFFFF) for the
  // same fallback since only the W channel differs and this sim's RGB output
  // never reads it (readBuffer drops W) -- reused here to match that port.
  glitterBase(seg, seg.intensity, seg.color(2) ? seg.color(2) : WHITE);
}

// --- Drip (96) -----------------------------------------------------------------
// Firmware's Spark struct (also backing Popcorn/Fireworks/Rain above) carries
// posX/velX for 2D use that Drip doesn't need, but is missing the `col`
// brightness scratch field Drip *does* need -- rather than touch the shared
// Spark interface/WeakMap, this gets its own DripDrop interface + WeakMap.
interface DripDrop {
  pos: number;
  vel: number;
  col: number; // brightness scratch (firmware: uint16_t, clamped to <=255 where it matters)
  colIndex: number; // drop state: 0 init, 1 forming, 2 falling, 5 bouncing
}

const MAX_DRIPS = 4; // firmware: 1 + (255>>6) = 4 at max intensity
const dripState = new WeakMap<Segment, DripDrop[]>();

function modeDrip(seg: Segment): void {
  if (seg.length <= 1) return fallbackStatic(seg);

  let drops = dripState.get(seg);
  if (!drops) {
    drops = Array.from({ length: MAX_DRIPS }, () => ({
      pos: 0,
      vel: 0,
      col: 0,
      colIndex: 0,
    }));
    dripState.set(seg, drops);
  }

  if (!seg.check2) seg.fill(seg.color(1));

  // Firmware splits one segment into parallel "drip columns" via
  // nrOfVStrips()/indexToVStrip() for 2D-as-columns use; this sim is 1D-only
  // (nrOfVStrips() is always 1), so that indirection collapses to a single
  // direct pass and indexToVStrip(index, 0) is dropped entirely.
  const numDrops = 1 + (seg.intensity >> 6);
  let gravity = -0.0005 - seg.speed / 50000;
  gravity *= Math.max(1, seg.length - 1);
  const sourcedrop = 12;

  for (let j = 0; j < numDrops; j++) {
    const drop = drops[j];
    if (drop.colIndex === 0) {
      // init
      drop.pos = seg.length - 1;
      drop.vel = 0;
      drop.col = sourcedrop;
      drop.colIndex = 1;
    }

    // water source
    seg.setPixelColor(
      seg.length - 1,
      color_blend(BLACK, seg.color(0), sourcedrop),
    );

    if (drop.colIndex === 1) {
      if (drop.col > 255) drop.col = 255;
      seg.setPixelColor(
        Math.trunc(drop.pos),
        color_blend(BLACK, seg.color(0), drop.col & 0xff),
      );

      drop.col += map(seg.speed, 0, 255, 1, 6); // swelling

      if (seg.rng.random8() < Math.trunc(drop.col / 10)) {
        // random drop
        drop.colIndex = 2; // fall
        drop.col = 255;
      }
    }
    if (drop.colIndex > 1) {
      // falling
      if (drop.pos > 0) {
        // fall until end of segment
        drop.pos += drop.vel;
        if (drop.pos < 0) drop.pos = 0;
        drop.vel += gravity; // gravity is negative

        // some minor math so we don't expand bouncing droplets
        for (let i = 1; i < 7 - drop.colIndex; i++) {
          const pos = Math.min(
            Math.max(Math.trunc(drop.pos) + i, 0),
            seg.length - 1,
          ); // spread pixel with fade while falling
          seg.setPixelColor(
            pos,
            color_blend(BLACK, seg.color(0), Math.trunc(drop.col / i) & 0xff),
          );
        }

        if (drop.colIndex > 2) {
          // during bounce, some water is on the floor
          seg.setPixelColor(
            0,
            color_blend(seg.color(0), BLACK, drop.col & 0xff),
          );
        }
      } else {
        // we hit bottom
        if (drop.colIndex > 2) {
          // already hit once, so back to forming
          drop.colIndex = 0;
          drop.col = sourcedrop;
        } else {
          if (drop.colIndex === 2) {
            // init bounce
            drop.vel = -drop.vel / 4; // reverse velocity with damping
            drop.pos += drop.vel;
          }
          drop.col = sourcedrop * 2;
          drop.colIndex = 5; // bouncing
        }
      }
    }
  }
}

// --- Fireworks Starburst (89) ---------------------------------------------------
// Per-star struct array; each star bursts into fragments that fly outward
// (decelerating) and fade, mirrored on both sides of the ignition point.
// Firmware sizes numStars/STARBURST_MAX_FRAG off a per-segment memory budget
// (FAIR_DATA_PER_SEG / sizeof(star)); this sim has no memory ceiling to
// reconcile with, so numStars is just the length-driven formula uncapped, and
// STARBURST_MAX_FRAG uses firmware's ESP32 default (10; ESP8266 uses 8) --
// same category of assumption as the device-memory-budget notes elsewhere.
const STARBURST_MAX_FRAG = 10;

interface Star {
  color: RGB;
  birth: number;
  last: number;
  vel: number;
  pos: number;
  /** STARBURST_MAX_FRAG entries; <=0 = unused (firmware seeds unused slots
   * to -1 on ignition, but a fresh/zeroed struct's fields all start at 0 --
   * both read as "inactive" by the `>0` checks below, so it's a distinction
   * without a behavioral difference). */
  fragment: number[];
}

const starburstStars = new WeakMap<Segment, Star[]>();

function modeStarburst(seg: Segment): void {
  if (seg.length <= 1) return fallbackStatic(seg);

  const numStars = 1 + (seg.length >> 3);

  let stars = starburstStars.get(seg);
  if (!stars || stars.length !== numStars) {
    stars = Array.from({ length: numStars }, () => ({
      color: [0, 0, 0] as RGB,
      birth: 0,
      last: 0,
      vel: 0,
      pos: 0,
      fragment: new Array(STARBURST_MAX_FRAG).fill(0),
    }));
    starburstStars.set(seg, stars);
  }

  const it = seg.now;
  const maxSpeed = 375.0; // max velocity
  const particleIgnition = 250.0; // how long to "flash"
  const particleFadeTime = 1500.0; // fade out time

  for (let j = 0; j < numStars; j++) {
    // speed adjusts the chance of a burst; max speed is nearly always
    if (seg.rng.random8(144 - (seg.speed >> 1)) === 0 && stars[j].birth === 0) {
      // pick a random color and location
      const startPos = seg.rng.random16(seg.length - 1);
      const multiplier = seg.rng.random8() / 255;

      const star = stars[j];
      const wheelColor = seg.color_wheel(seg.rng.random8());
      star.color = [R(wheelColor), G(wheelColor), B(wheelColor)];
      star.pos = startPos;
      star.vel = maxSpeed * (seg.rng.random8() / 255) * multiplier;
      star.birth = it;
      star.last = it;
      // more fragments means a larger burst effect
      const num = seg.rng.random8(3, 6 + (seg.intensity >> 5));

      for (let i = 0; i < STARBURST_MAX_FRAG; i++) {
        star.fragment[i] = i < num ? startPos : -1;
      }
    }
  }

  if (!seg.check2) seg.fill(seg.color(1));

  for (let j = 0; j < numStars; j++) {
    const star = stars[j];
    if (star.birth !== 0) {
      const dt = (it - star.last) / 1000.0;

      for (let i = 0; i < STARBURST_MAX_FRAG; i++) {
        const varr = i >> 1;
        // all fragments travel right, will be mirrored on the other side
        if (star.fragment[i] > 0) {
          star.fragment[i] += star.vel * dt * (varr / 3.0);
        }
      }
      star.last = it;
      star.vel -= 3 * star.vel * dt;
    }

    let c: RGB = star.color;

    // If the star is brand new, it flashes white briefly. Otherwise it just
    // fades over time.
    let fade = 0.0;
    let age = it - star.birth;

    if (age < particleIgnition) {
      const blended = color_blend(
        WHITE,
        rgbw32(c[0], c[1], c[2]),
        Math.trunc(254.5 * (age / particleIgnition)) & 0xff,
      );
      c = [R(blended), G(blended), B(blended)];
    } else {
      // figure out how much to fade and shrink the star based on its age
      // relative to its lifetime
      if (age > particleIgnition + particleFadeTime) {
        fade = 1.0; // black hole, all faded out
        star.birth = 0;
        c = [R(seg.color(1)), G(seg.color(1)), B(seg.color(1))];
      } else {
        age -= particleIgnition;
        fade = age / particleFadeTime; // fading star
        const blended = color_blend(
          rgbw32(c[0], c[1], c[2]),
          seg.color(1),
          Math.trunc(254.5 * fade) & 0xff,
        );
        c = [R(blended), G(blended), B(blended)];
      }
    }

    const particleSize = (1.0 - fade) * 2.0;
    const packed = rgbw32(c[0], c[1], c[2]);

    for (let index = 0; index < STARBURST_MAX_FRAG * 2; index++) {
      const mirrored = (index & 1) === 1;
      const i = index >> 1;
      if (star.fragment[i] > 0) {
        let loc = star.fragment[i];
        if (mirrored) loc -= (loc - star.pos) * 2;
        let start = Math.trunc(loc - particleSize);
        let end = Math.trunc(loc + particleSize);
        // Firmware declares start/end as `unsigned`, so `if (start<0)
        // start=0` is dead code in C++ (an unsigned value can't be
        // negative) -- a negative loc-particleSize instead becomes a real
        // float->unsigned cast UB on actual hardware. This sim implements
        // the code's apparent intent (clamp to 0) rather than guess at a
        // specific platform's undefined behavior.
        if (start < 0) start = 0;
        if (start === end) end++;
        if (end > seg.length) end = seg.length;
        for (let p = start; p < end; p++) {
          seg.setPixelColor(p, packed);
        }
      }
    }
  }
}

// --- Android (27) ------------------------------------------------------------
// Android boot-spinner: a lit arc that grows/shrinks then slides around the
// strip. Firmware packs two values into SEGENV.aux1 (size<<1 | shrinking) and
// keeps a free-running frame counter in a 4-byte SEGENV.data scratch (there's
// no fourth scalar field alongside aux0/aux1/step, so it needs its own byte
// scratch the same way Dissolve/Blends back a typed-array view onto seg.data).
function modeAndroid(seg: Segment): void {
  const buf = seg.allocateData(4);
  const counter = new Uint32Array(buf.buffer, buf.byteOffset, 1);

  let size = seg.aux1 >> 1; // upper bits
  let shrinking = seg.aux1 & 0x01; // lowest bit

  if (seg.now >= seg.step) {
    seg.step = seg.now + 3 + Math.trunc((8 * (255 - seg.speed)) / seg.length);
    if (size > Math.trunc((seg.intensity * seg.length) / 255)) shrinking = 1;
    else if (size < 2) shrinking = 0;

    if (!shrinking) {
      // growing
      if (counter[0] % 3 === 1)
        seg.aux0++; // advance start position
      else size++;
    } else {
      // shrinking
      seg.aux0++;
      if (counter[0] % 3 !== 1) size--;
    }

    seg.aux1 = (size << 1) | shrinking; // save back
    counter[0]++;
    if (seg.aux0 >= seg.length) seg.aux0 = 0;
  }

  const start = seg.aux0;
  const end = (seg.aux0 + size) % seg.length;
  for (let i = 0; i < seg.length; i++) {
    if (
      (start < end && i >= start && i < end) ||
      (start >= end && (i >= start || i < end))
    ) {
      seg.setPixelColor(i, seg.color(0));
    } else {
      seg.setPixelColor(i, seg.color_from_palette(i, true, false, 1));
    }
  }
}

// --- Noise 1 / Noise16_1 (70) -----------------------------------------------
function modeNoise16_1(seg: Segment): void {
  const scale = 320; // the "zoom factor" for the noise
  seg.step += 1 + Math.trunc(seg.speed / 16);

  for (let i = 0; i < seg.length; i++) {
    const shiftX = beatsin8_t(11, seg.now); // swings @ 17bpm, lowest/highest default 0/255
    const shiftY = Math.trunc(seg.step / 42);
    const realX = (i + shiftX) * scale;
    const realY = (i + shiftY) * scale;
    const realZ = seg.step;
    const noise = inoise16(realX, realY, realZ) >>> 8;
    const index = sin8(noise * 3);
    seg.setPixelColor(i, seg.color_from_palette(index, false, false, 0));
  }
}

// --- Noise 2 / Noise16_2 (71) ------------------------------------------------
function modeNoise16_2(seg: Segment): void {
  const scale = 1000;
  seg.step += 1 + (seg.speed >> 1);

  for (let i = 0; i < seg.length; i++) {
    const shiftX = seg.step >> 6;
    const realX = (i + shiftX) * scale;
    const noise = inoise16(realX, 0, 4223) >>> 8;
    const index = sin8(noise * 3);
    seg.setPixelColor(i, seg.color_from_palette(index, false, false, 0, noise));
  }
}

// --- Noise 3 / Noise16_3 (72) ------------------------------------------------
function modeNoise16_3(seg: Segment): void {
  const scale = 800;
  seg.step += 1 + seg.speed;
  const shiftX = 4223;
  const shiftY = 1234;

  for (let i = 0; i < seg.length; i++) {
    const realX = (i + shiftX) * scale;
    const realY = (i + shiftY) * scale;
    const realZ = seg.step * 8;
    const noise = inoise16(realX, realY, realZ) >>> 8;
    const index = sin8(noise * 3);
    seg.setPixelColor(i, seg.color_from_palette(index, false, false, 0, noise));
  }
}

// --- Noise 4 / Noise16_4 (73) ------------------------------------------------
// https://github.com/aykevl/ledstrip-spark. Uses the 2-arg perlin16(x,y)
// overload (inoise16xy) -- a distinct scale/offset from the 3-arg inoise16
// used above, not that function with z=0.
function modeNoise16_4(seg: Segment): void {
  const stp = (seg.now * seg.speed) >> 7;
  for (let i = 0; i < seg.length; i++) {
    const index = inoise16xy(i << 12, stp);
    seg.setPixelColor(i, seg.color_from_palette(index, false, false, 0));
  }
}

// --- Perlin Move (147) -------------------------------------------------------
// WLED-SR effect by Andrew Tuline. Same 2-arg inoise16xy overload as Noise 4.
function modePerlinMove(seg: Segment): void {
  if (seg.length <= 1) return fallbackStatic(seg);
  seg.fade_out(255 - seg.custom1);
  const count = Math.trunc(seg.intensity / 16) + 1;
  const t = Math.trunc((seg.now * 128) / (260 - seg.speed));
  for (let i = 0; i < count; i++) {
    const locn = inoise16xy(t + i * 15000, t);
    const pixloc = map(locn, 50 * 256, 192 * 256, 0, seg.length - 1);
    seg.setPixelColor(
      pixloc,
      seg.color_from_palette(pixloc % 255, false, false, 0),
    );
  }
}

// --- Fireworks 1D / "Exploding Fireworks" (90) ------------------------------
// http://www.anirama.com/1000leds/1d-fireworks/. Shares the shape of the
// existing Spark struct (pos/vel/colIndex) used by Popcorn/Fireworks/Rain,
// but needs different fields (a firing-side flag, a fading brightness/tint
// counter) -- a new interface per the "don't touch the shared Spark type"
// instruction, not a variant of it. Firmware's only 1D/2D difference is X
// velocity/position (`is2D() ? ... : 0`); this sim is 1D-only, so those terms
// are dropped entirely rather than carried around always-zero.
interface FireworkSpark {
  pos: number;
  posX: number; // 0 or 1: which end this flare/spark launched from (1D only)
  vel: number;
  col: number; // brightness (flare) / fade-intensity counter (sparks)
  colIndex: number;
}

interface FireworksState {
  sparks: FireworkSpark[]; // sparks[0] doubles as the flare
  dyingGravity: number;
}

const fireworksState = new WeakMap<Segment, FireworksState>();

function modeExplodingFireworks(seg: Segment): void {
  if (seg.length <= 1) return fallbackStatic(seg);
  const rows = seg.length; // 1D: cols is always 1

  let state = fireworksState.get(seg);
  if (!state) {
    // Firmware caps spark count by a device memory budget (FAIR_DATA_PER_SEG)
    // that scales up further when few segments are active; this sim has no
    // memory ceiling to reconcile with (same category as Popcorn/Ripple), so
    // it always uses the uncapped formula (5 + rows/2, cols=1 in 1D) rather
    // than also computing and min-ing against the device-memory cap.
    const numSparks = 5 + (rows >> 1);
    state = {
      sparks: Array.from({ length: numSparks }, () => ({
        pos: 0,
        posX: 0,
        vel: 0,
        col: 0,
        colIndex: 0,
      })),
      dyingGravity: 0,
    };
    seg.aux0 = 0;
    fireworksState.set(seg, state);
  }
  const { sparks } = state;
  const flare = sparks[0];

  seg.fade_out(252);

  const gravity = (-0.0004 - seg.speed / 800000) * rows;

  if (seg.aux0 < 2) {
    // FLARE
    if (seg.aux0 === 0) {
      flare.pos = 0;
      flare.posX = seg.intensity > seg.rng.random8() ? 1 : 0;
      let peakHeight = 75 + seg.rng.random8(180);
      peakHeight = (peakHeight * (rows - 1)) >> 8;
      flare.vel = Math.sqrt(-2 * gravity * peakHeight);
      flare.col = 255;
      seg.aux0 = 1;
    }

    if (flare.vel > 12 * gravity) {
      const gray = flare.col & 0xff;
      const idx =
        flare.posX > 0
          ? rows - Math.trunc(flare.pos) - 1
          : Math.trunc(flare.pos);
      seg.setPixelColor(idx, rgbw32(gray, gray, gray));
      flare.pos += flare.vel;
      flare.pos = Math.min(Math.max(flare.pos, 0), rows - 1);
      flare.vel += gravity;
      flare.col -= 2;
    } else {
      seg.aux0 = 2; // ready to explode
    }
  } else if (seg.aux0 < 4) {
    // Explode! Size proportional to the flare's peak height.
    let nSparks = Math.trunc(flare.pos) + seg.rng.random8(4);
    nSparks = Math.max(nSparks, 4);
    nSparks = Math.min(nSparks, sparks.length);

    if (seg.aux0 === 2) {
      for (let i = 1; i < nSparks; i++) {
        sparks[i].pos = flare.pos;
        sparks[i].posX = flare.posX;
        sparks[i].vel = seg.rng.random16(20001) / 10000 - 0.9;
        sparks[i].vel *= rows < 32 ? 0.5 : 1;
        sparks[i].col = 345;
        sparks[i].colIndex = seg.rng.random8();
        sparks[i].vel *= flare.pos / rows;
        sparks[i].vel *= -gravity * 50;
      }
      state.dyingGravity = gravity / 2;
      seg.aux0 = 3;
    }

    if (sparks[1].col > 4) {
      // as long as our known spark is lit, work with all the sparks
      for (let i = 1; i < nSparks; i++) {
        sparks[i].pos += sparks[i].vel;
        sparks[i].vel += state.dyingGravity;
        if (sparks[i].col > 3) sparks[i].col -= 4;

        if (sparks[i].pos > 0 && sparks[i].pos < rows) {
          const prog = sparks[i].col;
          const spColor = seg.palette
            ? seg.color_wheel(sparks[i].colIndex)
            : seg.color(0);
          let c = BLACK;
          if (prog > 300) {
            // fade from white to spark color
            c = color_blend(spColor, WHITE, ((prog - 300) * 5) & 0xff);
          } else if (prog > 45) {
            // fade from spark color to black
            c = color_blend(BLACK, spColor, (prog - 45) & 0xff);
            const cooling = (300 - prog) >> 5;
            c = rgbw32(R(c), qsub8(G(c), cooling), qsub8(B(c), cooling * 2));
          }
          const idx = sparks[i].posX
            ? rows - Math.trunc(sparks[i].pos) - 1
            : Math.trunc(sparks[i].pos);
          seg.setPixelColor(idx, c);
        }
      }
      if (seg.check3) seg.blur(16);
      state.dyingGravity *= 0.8; // as sparks burn out they fall slower
    } else {
      seg.aux0 = 6 + seg.rng.random8(10); // wait this many frames
    }
  } else {
    seg.aux0--;
    if (seg.aux0 < 4) seg.aux0 = 0; // back to flare
  }
}

// --- TV Simulator (116) -----------------------------------------------------
// Adapted from "Fake TV Light for Engineers" (Adafruit). A "scene" color
// random-walks in hue/sat/bri, then cross-fades pixel-to-pixel via a custom
// constant-brightness HSB->RGB conversion (not this file's hsv2rgb_rainbow --
// a distinct algorithm from the Adafruit blog post) + forward gamma.
interface TvSimState {
  totalTime: number;
  fadeTime: number;
  startTime: number;
  sliderValues: number;
  sceeneStart: number;
  sceeneDuration: number;
  sceeneColorHue: number;
  sceeneColorSat: number;
  sceeneColorBri: number;
  actualColorR: number;
  actualColorG: number;
  actualColorB: number;
  pr: number;
  pg: number;
  pb: number;
}

const tvSimState = new WeakMap<Segment, TvSimState>();

function modeTvSimulator(seg: Segment): void {
  let s = tvSimState.get(seg);
  if (!s) {
    s = {
      totalTime: 0,
      fadeTime: 0,
      startTime: 0,
      sliderValues: 0,
      sceeneStart: 0,
      sceeneDuration: 0,
      sceeneColorHue: 0,
      sceeneColorSat: 0,
      sceeneColorBri: 0,
      actualColorR: 0,
      actualColorG: 0,
      actualColorB: 0,
      pr: 0,
      pg: 0,
      pb: 0,
    };
    tvSimState.set(seg, s);
  }

  const colorSpeed = map(seg.speed, 0, 255, 1, 20);
  const colorIntensity = map(seg.intensity, 0, 255, 10, 30);

  // Firmware reinitializes the scene timer whenever the speed/intensity
  // sliders change (not just on call count) -- detected explicitly by
  // comparing against the last-seen packed slider value, same idiom as the
  // real mode_tv_simulator().
  const sliderKey = (seg.speed << 8) | seg.intensity;
  if (sliderKey !== s.sliderValues) {
    s.sliderValues = sliderKey;
    seg.aux1 = 0;
  }

  // create a new sceene
  if (seg.now - s.sceeneStart >= s.sceeneDuration || seg.aux1 === 0) {
    s.sceeneStart = seg.now;
    s.sceeneDuration = seg.rng.random16(
      60 * 250 * colorSpeed,
      60 * 750 * colorSpeed,
    );
    s.sceeneColorHue = seg.rng.random16(0, 768);
    s.sceeneColorSat = seg.rng.random8(100, 130 + colorIntensity);
    s.sceeneColorBri = seg.rng.random8(200, 240);
    seg.aux1 = 1;
    seg.aux0 = 0;
  }

  // slightly change the color-tone in this sceene
  if (seg.aux0 === 0) {
    const j1 = seg.rng.random8(4 * colorIntensity);
    let hue: number;
    if (seg.rng.random8() < 128) {
      hue =
        j1 < s.sceeneColorHue
          ? s.sceeneColorHue - j1
          : 767 - s.sceeneColorHue - j1;
    } else {
      hue =
        j1 + s.sceeneColorHue < 767
          ? s.sceeneColorHue + j1
          : s.sceeneColorHue + j1 - 767;
    }

    const j2 = seg.rng.random8(2 * colorIntensity);
    const sat = s.sceeneColorSat - j2 < 0 ? 0 : s.sceeneColorSat - j2;

    const j3 = seg.rng.random8(100);
    const bri = s.sceeneColorBri - j3 < 0 ? 0 : s.sceeneColorBri - j3;

    // constant-brightness HSB->RGB: https://blog.adafruit.com/2012/03/14/constant-brightness-hsb-to-rgb-algorithm/
    const n = (hue >> 8) % 3;
    const x = (((((hue & 255) * sat) >> 8) * bri) >> 8) & 0xff;
    const sBase = (((256 - sat) * bri) >> 8) & 0xff;
    const temp = [
      sBase,
      (x + sBase) & 0xff,
      (bri - x) & 0xff,
      sBase,
      (x + sBase) & 0xff,
    ];
    s.actualColorR = temp[n + 2];
    s.actualColorG = temp[n + 1];
    s.actualColorB = temp[n];
  }

  // Apply gamma correction, further expand to 16/16/16
  const nr = gamma8(s.actualColorR) * 257;
  const ng = gamma8(s.actualColorG) * 257;
  const nb = gamma8(s.actualColorB) * 257;

  if (seg.aux0 === 0) {
    // initialize next iteration
    seg.aux0 = 1;
    s.totalTime = seg.rng.random16(250, 2500);
    s.fadeTime = seg.rng.random16(0, s.totalTime);
    if (seg.rng.random8(10) < 3) s.fadeTime = 0; // force scene cut 30% of time
    s.startTime = seg.now;
  }

  const elapsed = seg.now - s.startTime;

  let r: number;
  let g: number;
  let b: number;
  if (elapsed < s.fadeTime) {
    r = map(elapsed, 0, s.fadeTime, s.pr, nr);
    g = map(elapsed, 0, s.fadeTime, s.pg, ng);
    b = map(elapsed, 0, s.fadeTime, s.pb, nb);
  } else {
    r = nr;
    g = ng;
    b = nb;
  }

  seg.fill(rgbw32((r >> 8) & 0xff, (g >> 8) & 0xff, (b >> 8) & 0xff));

  if (elapsed >= s.totalTime) {
    s.pr = nr;
    s.pg = ng;
    s.pb = nb;
    seg.aux0 = 0;
  }
}

// --- Scanner Dual (60) -------------------------------------------------------
// Real firmware body is literally `SEGMENT.check1 = true; mode_larson_scanner();`
// -- Scanner Dual is just Scanner (40) with its already-ported check1 mirror
// branch forced on. Confirmed against FX.cpp mode_dual_larson_scanner() rather
// than assumed.
function modeScannerDual(seg: Segment): void {
  seg.check1 = true;
  modeLarsonScanner(seg);
}

// --- Stream / "Running Random" (39, mode_running_random) -------------------
// Real firmware's own display name is "Stream"; the C function is
// mode_running_random -- named to match the function, per this file's existing
// convention (e.g. modeRainbow backs the "Colorloop" display name).
// Stateless-looking but isn't quite: aux0 threads a PRNG seed across frames so
// the color at a given zone boundary keeps continuity as zones scroll, and
// aux1 remembers the last time-bucket so a boundary crossing is only detected
// once. Uses the effect's own inline LCG (seed*2053+13849), NOT seg.rng's
// General PRNG -- matching the real firmware's dedicated recurrence exactly
// (same recurrence already used for Twinkle/Twinklefox/Fairy's local prng16
// pattern elsewhere in this file).
function modeRunningRandom(seg: Segment): void {
  const cycleTime = 25 + 3 * (255 - seg.speed);
  const it = Math.trunc(seg.now / cycleTime);
  if (seg.call === 0) seg.aux0 = seg.rng.random16(); // hw_random() seeds the walk

  const zoneSize = ((255 - seg.intensity) >> 4) + 1;
  let prng16 = seg.aux0 & 0xffff;

  let z = it % zoneSize;
  let nzone = z === 0 && it !== seg.aux1;
  for (let i = seg.length - 1; i >= 0; i--) {
    if (nzone || z >= zoneSize) {
      const lastrand = prng16 >> 8;
      let diff = 0;
      // Guaranteed to terminate: the recurrence has full period over 16 bits,
      // so every top-byte value (incl. ones >=42 from lastrand) recurs often.
      while (Math.abs(diff) < 42) {
        prng16 = (prng16 * 2053 + 13849) & 0xffff;
        diff = (prng16 >> 8) - lastrand;
      }
      if (nzone) {
        seg.aux0 = prng16;
        nzone = false;
      }
      z = 0;
    }
    seg.setPixelColor(i, seg.color_wheel(prng16 >> 8));
    z++;
  }

  // seg.aux1 is a real firmware uint16_t (truncates on assignment); the "it
  // changed" check above compares this truncated value against a fresh,
  // untruncated `it`, exactly mirroring the field's storage width.
  seg.aux1 = it & 0xffff;
}

// --- Multi Comet (59) --------------------------------------------------------
// Small uint16_t[MAX_COMETS] scratch array of comet head positions -- cheaper
// than it looks. Uses seg.allocateData() (byte scratch, like modeDynamicImpl)
// rather than a WeakMap, since it's just plain position numbers.
const MAX_COMETS = 8;

function modeMultiComet(seg: Segment): void {
  const cycleTime = 10 + (255 - seg.speed);
  const it = Math.trunc(seg.now / cycleTime);
  if (seg.step === it) return;

  const buf = seg.allocateData(2 * MAX_COMETS);
  const comets = new Uint16Array(buf.buffer, buf.byteOffset, MAX_COMETS);

  seg.fadeToBlackBy((seg.intensity >> 1) + 128);

  const hasCol2 = seg.color(2) !== 0;
  for (let i = 0; i < MAX_COMETS; i++) {
    if (comets[i] < seg.length) {
      const index = comets[i];
      if (hasCol2) {
        seg.setPixelColor(
          index,
          i % 2 ? seg.color_from_palette(index, true, false, 0) : seg.color(2),
        );
      } else {
        seg.setPixelColor(index, seg.color_from_palette(index, true, false, 0));
      }
      comets[i]++;
    } else if (!seg.rng.random16(seg.length)) {
      comets[i] = 0;
    }
  }

  seg.step = it;
}

// --- Pac-Man (151) -----------------------------------------------------------
// By Bob Loeffler with help from @dedehai and @blazoncek. A per-character
// struct array (Pac-Man + N ghosts + power dots); real firmware packs
// numPowerDots+numGhosts into one aux field (seg.aux0 here) to detect a
// settings change and force a full reinit, and the array length is computed
// at runtime from segment length + custom sliders rather than a fixed
// constant -- same "reinit on settings change" shape as Tetrix/Oscillate, kept
// in a WeakMap since the state is a struct array, not plain scratch bytes.
const PACMAN_ORANGEYELLOW = 0xffcc00;
const PACMAN_PURPLEISH = 0xb000b0;
const PACMAN_ORANGEISH = 0xff8800;
const PACMAN_WHITEISH = 0x999999;
const PACMAN_YELLOW = 0xffff00;
const PACMAN_BLUE = 0x0000ff;
const PACMAN_GHOST_COLORS = [
  0xff0000,
  PACMAN_PURPLEISH,
  0x00ffff,
  PACMAN_ORANGEISH,
];
const PACMAN = 0; // PacMan is character[0]

interface PacmanChar {
  pos: number;
  topPos: number;
  color: number;
  direction: boolean; // true = moving away from LED 0
  blue: boolean;
  eaten: boolean;
}

interface PacmanState {
  characters: PacmanChar[];
  numGhosts: number;
  maxPowerDots: number;
}

const pacmanState = new WeakMap<Segment, PacmanState>();

function modePacman(seg: Segment): void {
  const maxPowerDots = Math.min(Math.trunc(seg.length / 10), 255);
  const numPowerDots = map(seg.intensity, 0, 255, 1, maxPowerDots);
  const numGhosts = map(seg.custom3, 0, 31, 2, 8);

  // Pack two 8-bit values into one 16-bit field (seg.aux0) to detect a
  // settings change and force a full reinitialize, same as real firmware.
  const combinedValue = ((numPowerDots & 0xff) << 8) | (numGhosts & 0xff);
  const settingsChanged = combinedValue !== seg.aux0;
  seg.aux0 = combinedValue;

  if (seg.length <= 16 + 2 * numGhosts) return fallbackStatic(seg);

  let state = pacmanState.get(seg);
  const expectedLen = numGhosts + maxPowerDots + 1;
  const isInit =
    seg.call === 0 ||
    settingsChanged ||
    !state ||
    state.characters.length !== expectedLen;
  if (!state || isInit) {
    const characters: PacmanChar[] = Array.from(
      { length: expectedLen },
      () => ({
        pos: 0,
        topPos: 0,
        color: 0,
        direction: true,
        blue: false,
        eaten: false,
      }),
    );
    state = { characters, numGhosts, maxPowerDots };
    pacmanState.set(seg, state);
  }
  const character = state.characters;

  // On first call (or after a settings change), topPos isn't known yet -> the
  // full segment length stands in for it.
  let maxBlinkPos = isInit ? seg.length - 1 : character[PACMAN].topPos;
  if (maxBlinkPos < 20) maxBlinkPos = 20;
  const startBlinkingGhostsLED =
    seg.length < 64
      ? Math.trunc(seg.length / 3)
      : map(seg.custom1, 0, 255, 20, maxBlinkPos);

  if (isInit) {
    character[PACMAN].color = PACMAN_YELLOW;
    character[PACMAN].pos = 0;
    character[PACMAN].topPos = 0;
    character[PACMAN].direction = true;
    character[PACMAN].blue = false;

    for (let i = 1; i <= numGhosts; i++) {
      character[i].color = PACMAN_GHOST_COLORS[(i - 1) % 4];
      character[i].pos = -2 * (i + 1);
      character[i].direction = true;
      character[i].blue = false;
    }

    for (let i = 0; i < numPowerDots; i++) {
      character[i + numGhosts + 1].color = PACMAN_ORANGEYELLOW;
      character[i + numGhosts + 1].eaten = false;
    }
    character[numGhosts + 1].pos = seg.length - 1; // last power dot at the end
  }

  if (seg.now > seg.step) {
    seg.step = seg.now;
    seg.aux1++;
  }

  if (!seg.check2) seg.fill(BLACK); // check2: Smear mode

  if (seg.check1) {
    // check1: white dots PacMan eats; check3: compact (every LED) vs spaced
    const step = seg.check3 ? 1 : 2;
    for (let i = seg.length - 1; i > character[PACMAN].topPos; i -= step) {
      seg.setPixelColor(i, PACMAN_WHITEISH);
    }
  }

  // Update power dot positions dynamically (dot 0 stays anchored at the end,
  // set once above -- only dots 1..numPowerDots-1 are repositioned each frame).
  const everyXLeds = Math.trunc(((seg.length - 10) << 8) / numPowerDots);
  for (let i = 1; i < numPowerDots; i++) {
    character[i + numGhosts + 1].pos = 10 + ((i * everyXLeds) >> 8);
  }

  // Blink power dots every 10 ticks
  if (seg.aux1 % 10 === 0) {
    const dotColor =
      character[numGhosts + 1].color === PACMAN_ORANGEYELLOW
        ? BLACK
        : PACMAN_ORANGEYELLOW;
    for (let i = 0; i < numPowerDots; i++) {
      character[i + numGhosts + 1].color = dotColor;
    }
  }

  // Blink blue ghosts when PacMan is nearing the start
  if (
    seg.aux1 % 15 === 0 &&
    character[1].blue &&
    character[PACMAN].pos <= startBlinkingGhostsLED
  ) {
    const ghostColor =
      character[1].color === PACMAN_BLUE ? PACMAN_WHITEISH : PACMAN_BLUE;
    for (let i = 1; i <= numGhosts; i++) character[i].color = ghostColor;
  }

  // Draw uneaten power dots
  for (let i = 0; i < numPowerDots; i++) {
    const dot = character[i + numGhosts + 1];
    if (!dot.eaten && dot.pos >= 0 && dot.pos < seg.length) {
      seg.setPixelColor(dot.pos, dot.color);
    }
  }

  // Check if PacMan ate a power dot
  for (let j = 0; j < numPowerDots; j++) {
    const dot = character[j + numGhosts + 1];
    if (character[PACMAN].pos === dot.pos && !dot.eaten) {
      for (let i = 0; i <= numGhosts; i++) character[i].direction = false;
      for (let i = 1; i <= numGhosts; i++) {
        character[i].color = PACMAN_BLUE;
        character[i].blue = true;
      }
      dot.eaten = true;
      break; // only one power dot per frame
    }
  }

  // Reset when PacMan reaches the start with blue ghosts
  if (character[1].blue && character[PACMAN].pos <= 0) {
    for (let i = 0; i <= numGhosts; i++) character[i].direction = true;
    for (let i = 1; i <= numGhosts; i++) {
      character[i].color = PACMAN_GHOST_COLORS[(i - 1) % 4];
      character[i].blue = false;
    }
    if (character[numGhosts + 1].eaten) {
      for (let i = 0; i < numPowerDots; i++) {
        character[i + numGhosts + 1].eaten = false;
      }
      character[PACMAN].topPos = 0;
    }
  }

  const updatePositions = seg.aux1 % map(seg.speed, 0, 255, 15, 1) === 0;
  if (updatePositions) {
    character[PACMAN].pos += character[PACMAN].direction ? 1 : -1;
    for (let i = 1; i <= numGhosts; i++) {
      character[i].pos += character[i].direction ? 1 : -1;
    }
  }

  if (character[PACMAN].pos >= 0 && character[PACMAN].pos < seg.length) {
    seg.setPixelColor(character[PACMAN].pos, character[PACMAN].color);
  }
  for (let i = 1; i <= numGhosts; i++) {
    if (character[i].pos >= 0 && character[i].pos < seg.length) {
      seg.setPixelColor(character[i].pos, character[i].color);
    }
  }

  if (character[PACMAN].topPos < character[PACMAN].pos) {
    character[PACMAN].topPos = character[PACMAN].pos;
  }

  seg.blur(seg.custom2 >> 1);
}

// --- Noise Pal (107) ---------------------------------------------------------
// Slow noise palette by Andrew Tuline. Two runtime-built palettes cross-blend
// via nblendPaletteTowardPalette; the blended result is indexed by 2D Perlin
// noise per pixel. The two working palettes are per-instance state kept in a
// WeakMap (not SEGENV.data reinterpreted as a struct), same pattern as
// Aurora/Tetrix. A real firmware quirk kept faithfully: with the default
// palette (0), the strip stays fully black for the first 4-6.5s (until the
// first random target palette is rolled and the gradual per-byte blend has
// had time to climb away from the zeroed starting palette) -- this is exactly
// what real WLED does too, not a bug introduced here.
interface NoisePalState {
  palette0: RGB[];
  palette1: RGB[];
}

const noisePalState = new WeakMap<Segment, NoisePalState>();

function blackPalette16(): RGB[] {
  return Array.from({ length: 16 }, () => [0, 0, 0] as RGB);
}

/** CHSV(h,s,v) -> RGB via the sim's existing rainbow HSV conversion -- WLED's
 * CRGB(const CHSV&) constructor is just hsv2rgb_rainbow(h<<8, s, v). */
function chsvToRgb(h8: number, s: number, v: number): RGB {
  return unpack(hsv2rgb_rainbow((h8 & 0xff) << 8, s, v));
}

/** CRGBPalette16(CHSV,CHSV,CHSV,CHSV) -- fill_gradient_RGB's 4-color, onethird
 * /twothirds-split overload (fastled_slim.cpp), reusing the same single-range
 * fillGradient this sim's loadPalette already uses. */
function noisePalTargetPalette(c1: RGB, c2: RGB, c3: RGB, c4: RGB): RGB[] {
  const out = blackPalette16();
  fillGradient(out, 0, c1, 5, c2);
  fillGradient(out, 5, c2, 10, c3);
  fillGradient(out, 10, c3, 15, c4);
  return out;
}

function modeNoisePal(seg: Segment): void {
  let state = noisePalState.get(seg);
  if (!state) {
    // Fresh state mirrors freshly-allocated (zeroed) firmware memory: both
    // working palettes start all-black.
    state = { palette0: blackPalette16(), palette1: blackPalette16() };
    noisePalState.set(seg, state);
  }

  const scale = 15 + (seg.intensity >> 2);
  const changePaletteMs = 4000 + seg.speed * 10;

  if (seg.now - seg.step > changePaletteMs) {
    seg.step = seg.now;
    const baseI = seg.rng.random8();
    // hw_random8() is real hardware entropy on-device (order of evaluation is
    // unspecified there too); this sim just evaluates left-to-right.
    const c1 = chsvToRgb(
      baseI + seg.rng.random8(64),
      255,
      seg.rng.random8(128, 255),
    );
    const c2 = chsvToRgb(baseI + 128, 255, seg.rng.random8(128, 255));
    const c3 = chsvToRgb(
      baseI + seg.rng.random8(92),
      192,
      seg.rng.random8(128, 255),
    );
    const c4 = chsvToRgb(
      baseI + seg.rng.random8(92),
      255,
      seg.rng.random8(128, 255),
    );
    state.palette1 = noisePalTargetPalette(c1, c2, c3, c4);
  }

  nblendPaletteTowardPalette(state.palette0, state.palette1, 48);

  // A real (non-default) palette selection overrides palette0 wholesale, every
  // frame -- cloned rather than aliased, since this sim's fixed-palette tables
  // are shared read-only data (unlike firmware's always-by-value CRGBPalette16).
  if (seg.palette > 0) {
    state.palette0 = seg.getCurrentPalette().map((c) => [...c] as RGB);
  }

  for (let i = 0; i < seg.length; i++) {
    const index = perlin8(i * scale, seg.aux0 + i * scale);
    seg.setPixelColor(
      i,
      colorFromPalette(state.palette0, index, 255, LINEARBLEND),
    );
  }

  seg.aux0 = (seg.aux0 + beatsin8_t(10, seg.now, 1, 4)) & 0xffff;
}

// --- Stream 2 / "Random Chase" (61, mode_random_chase) -----------------------
// Custom mode by Keith Lord (WS2812FX RandomChase.h). Firmware runs this on
// WLED's own shared, deterministic `prng` object (prng.h) -- the exact class
// this sim's PRNG/seg.rng already is -- saving its ambient seed, switching to
// a local per-segment seed (aux0) for the effect's own per-pixel draws, then
// restoring the ambient seed afterward so other effects sharing that PRNG
// aren't disturbed. The initial seeding draws (call==0) happen *before* the
// save point, so they deliberately do consume/advance the ambient sequence
// once at startup -- ported faithfully, not "fixed" into the save/restore
// bracket.
function modeRandomChase(seg: Segment): void {
  if (seg.call === 0) {
    seg.step = rgbw32(
      seg.rng.random8(),
      seg.rng.random8(),
      seg.rng.random8(),
      0,
    );
    seg.aux0 = seg.rng.random16();
  }
  const prevSeed = seg.rng.getSeed(); // save so other effects aren't disturbed
  const cycleTime = 25 + 3 * (255 - seg.speed);
  const it = Math.trunc(seg.now / cycleTime);
  let color = seg.step;
  seg.rng.setSeed(seg.aux0);

  for (let i = seg.length - 1; i >= 0; i--) {
    const r =
      seg.rng.random8(6) !== 0 ? (color >>> 16) & 0xff : seg.rng.random8();
    const g =
      seg.rng.random8(6) !== 0 ? (color >>> 8) & 0xff : seg.rng.random8();
    const b = seg.rng.random8(6) !== 0 ? color & 0xff : seg.rng.random8();
    color = rgbw32(r, g, b, 0);
    seg.setPixelColor(i, color);
    if (i === seg.length - 1 && seg.aux1 !== (it & 0xffff)) {
      // new first color for the next frame
      seg.step = color;
      seg.aux0 = seg.rng.getSeed();
    }
  }

  seg.aux1 = it & 0xffff;

  seg.rng.setSeed(prevSeed); // restore -- don't leak this effect's PRNG state
}

// --- Fill Noise8 (69, mode_fillnoise8) ----------------------------------------
function modeFillNoise8(seg: Segment): void {
  if (seg.call === 0) seg.step = seg.rng.random16(); // stand-in for hw_random()
  for (let i = 0; i < seg.length; i++) {
    const index = inoise8(i * seg.length, seg.step + i * seg.length);
    seg.setPixelColor(i, seg.color_from_palette(index, false, false, 0));
  }
  seg.step += beatsin8_t(seg.speed, seg.now, 1, 6);
}

// --- Shimmer (161, mode_shimmer) ----------------------------------------------
// By DedeHai (Damian Schneider). A soft gradient band travels across the
// strip, pauses at the far end for an intensity-controlled interval, then
// resets and repeats. Ported: the base traveling-glow band (must-have, per
// the batch scope). NOT ported: the optional "Granular" (custom2) modulation
// layer that can additionally texture the band with either a sine "Zebra"
// stripe pattern or Perlin noise (`perlin16`, a different 2-arg 16-bit noise
// function from the `inoise8` primitive this batch added) -- its firmware
// default is already off (c2=0 in the real metadata string), so this port's
// behavior matches stock defaults exactly; the modulation itself is a
// lower-priority visual extra, not implemented here.
function modeShimmer(seg: Segment): void {
  const buf = seg.allocateData(4); // persistent last-update timestamp
  const lastTime = new Uint32Array(buf.buffer, buf.byteOffset, 1);

  const radius = ((seg.custom1 * seg.length) >> 7) + 1; // [1, 2*len+1] px
  const traversalDistance = (seg.length + 2 * radius) << 8; // subpixels to cross
  const traversalTime = 200 + (255 - seg.speed) * 80; // [200, 20600] ms
  const movementSpeed = Math.trunc((traversalDistance << 5) / traversalTime);
  let position = seg.step; // current position in subpixels (persisted directly)
  const inputState = (seg.intensity << 8) | seg.custom1;

  if (seg.call === 0 || inputState !== seg.aux1) {
    position = -(radius << 8);
    seg.aux0 = 0; // aux0 is the pause timer
    lastTime[0] = seg.now;
    seg.aux1 = inputState; // save user input state
  }

  if (seg.speed) {
    const deltaTime = (seg.now - lastTime[0]) & 0x7f; // clamp to avoid overflow
    lastTime[0] = seg.now;

    if (seg.aux0 > 0) {
      seg.aux0 = seg.aux0 > deltaTime ? seg.aux0 - deltaTime : 0;
    } else {
      const moveStep = 1 + ((movementSpeed * deltaTime) >> 5);
      position += moveStep;
      const endPosition = (seg.length + radius) << 8;
      if (position > endPosition) {
        seg.aux0 = seg.intensity * 236; // [0, 60180] ms pause
        if (seg.check3) seg.aux0 = seg.rng.random16(seg.aux0 + 1000); // "Sporadic"
        position = -(radius << 8); // reset to start (out of frame)
      }
      seg.step = position; // save back
    }

    if (seg.check2) position = (seg.length << 8) - position; // "Reverse"
  } else {
    position = seg.length << 7; // static in the center at speed=0
  }

  for (let i = 0; i < seg.length; i++) {
    const dist = Math.abs(position - (i << 8));
    if (dist < radius << 8) {
      const color = seg.color_from_palette(
        Math.trunc((i * 255) / seg.length),
        false,
        false,
        0,
      );
      const blend = Math.trunc(dist / radius);
      seg.setPixelColor(i, color_blend(color, seg.color(1), blend));
    } else {
      seg.setPixelColor(i, seg.color(1));
    }
  }
}

// --- Running Dual (52, mode_running_dual via running_base(false,true)) -----
// Real firmware's running_base(saw,dual) also backs the already-ported
// Running Lights (15) / Saw (16), but those two were deliberately kept
// standalone rather than refactored into a shared base (see decisions.md,
// batch 5) -- same precedent applied here rather than reopening them.
function sinGap(inp: number): number {
  const in16 = inp & 0xffff;
  if (in16 & 0x100) return 0;
  return sin8(in16 + 192);
}

function modeRunningDual(seg: Segment): void {
  const xScale = seg.intensity >> 2;
  const counter = (seg.now * seg.speed) >> 9;
  for (let i = 0; i < seg.length; i++) {
    const a = i * xScale - counter;
    const s = sinGap(a);
    let ca = color_blend(
      seg.color(1),
      seg.color_from_palette(i, true, false, 0),
      s,
    );
    const b = (seg.length - 1 - i) * xScale - counter;
    const t = sinGap(b);
    const cb = color_blend(
      seg.color(1),
      seg.color_from_palette(i, true, false, 2),
      t,
    );
    ca = color_blend(ca, cb, 127);
    seg.setPixelColor(i, ca);
  }
}

// --- Tricolor Chase (54, "Chase 3") ------------------------------------------
function tricolorChase(seg: Segment, color1: number, color2: number): void {
  const cycleTime = 50 + ((255 - seg.speed) << 1);
  const it = Math.trunc(seg.now / cycleTime);
  const width = 1 + (seg.intensity >> 4);
  let index = it % (width * 3);

  for (let i = 0; i < seg.length; i++) {
    if (index > width * 3 - 1) index = 0;
    let color = color1;
    if (index > (width << 1) - 1) {
      color = seg.color_from_palette(i, true, false, 1);
    } else if (index > width - 1) {
      color = color2;
    }
    seg.setPixelColor(seg.length - i - 1, color);
    index++;
  }
}

function modeTricolorChase(seg: Segment): void {
  tricolorChase(seg, seg.color(2), seg.color(0));
}

// --- Tricolor Wipe (55) -------------------------------------------------------
function modeTricolorWipe(seg: Segment): void {
  const cycleTime = 1000 + (255 - seg.speed) * 200;
  const perc = seg.now % cycleTime;
  const prog = Math.trunc((perc * 65535) / cycleTime);
  const ledIndex = (prog * seg.length * 3) >> 16;
  let ledOffset = ledIndex;

  for (let i = 0; i < seg.length; i++) {
    seg.setPixelColor(i, seg.color_from_palette(i, true, false, 2));
  }

  if (ledIndex < seg.length) {
    for (let i = 0; i < seg.length; i++) {
      seg.setPixelColor(i, i > ledOffset ? seg.color(0) : seg.color(1));
    }
  } else if (ledIndex < seg.length * 2) {
    ledOffset = ledIndex - seg.length;
    for (let i = ledOffset + 1; i < seg.length; i++) {
      seg.setPixelColor(i, seg.color(1));
    }
  } else {
    ledOffset = ledIndex - seg.length * 2;
    for (let i = 0; i <= ledOffset; i++) {
      seg.setPixelColor(i, seg.color(0));
    }
  }
}

// --- Color Clouds (218) -----------------------------------------------------
/**
 * Soft drifting Perlin clouds of color. Two independent 2D Perlin fields: one
 * gates brightness (the "clouds"), one drives hue. custom1/2/3 (cloud density /
 * colorfulness / gaps) aren't exposed to the sim harness, so they default 0 --
 * hue is then spatially uniform but still drifts in time, brightness still
 * varies per pixel. `cozy` (check3) folds the hue into a soft palette-edge sweep.
 */
function modeColorClouds(seg: Segment): void {
  if (seg.call === 0) {
    seg.aux0 = seg.rng.random16();
    seg.aux1 = seg.rng.random16();
  }
  const volX0 = seg.aux0;
  const hueX0 = seg.aux1;
  const hueOffset0 = (volX0 + hueX0) & 0xff;

  const cozy = seg.check3;
  const volSpeed = 1 + seg.speed;
  const hueSpeed = 1 + seg.intensity;
  const volSqueeze = 8 + seg.custom1;
  const hueSqueeze = seg.custom2;
  const volCutoff = 12500 + seg.custom3 * 900;
  const volSaturate = 52000;

  const now = seg.now;
  const volT = Math.trunc((now * volSpeed) / 8);
  const hueT = Math.trunc((now * hueSpeed) / 8);
  const hueOffset = beat88(64, now) >> 8;

  for (let i = 0; i < seg.length; i++) {
    const volX = i * volSqueeze * 64;
    let vol = inoise16xy(volX0 + volX, volT);
    vol = map(vol, volCutoff, volSaturate, 0, 255);
    vol = Math.max(0, Math.min(255, vol));

    const hueX = i * hueSqueeze * 8;
    let hue = (inoise16xy(hueX0 + hueX, hueT) >> 7) & 0xff;
    hue = (hue + hueOffset0) & 0xff;
    hue = (hue + hueOffset) & 0xff;
    if (cozy) hue = cos8(128 + (hue >> 1));

    let pixel: number;
    if (seg.palette) {
      pixel = seg.color_from_palette(hue, false, true, 0, vol);
    } else {
      pixel = hsv2rgb_spectrum((hue & 0xff) << 8, 255, vol);
    }

    if (R(pixel) + G(pixel) + B(pixel) <= 2) pixel = 0;
    seg.setPixelColor(i, pixel);
  }
}

// === Particle-system 1D effects (fx 202-213) =================================
// Built on the ported ParticleSystem1D engine (particles-1d.ts). Each mirrors
// its FX.cpp mode_particleXXX: init the system on the first frame (stashed
// per-Segment), then set params + emit + update per frame.

// --- PS Spray 1D (208) -------------------------------------------------------
// mode_particle1Dspray: one emitter sprays particles, gravity + bounce + blur.
function modeParticleSpray1D(seg: Segment): void {
  let ps: ParticleSystem1D | null;
  if (seg.call === 0) {
    ps = initParticleSystem1D(seg, 1);
    if (!ps) return fallbackStatic(seg);
    ps.setKillOutOfBounds(true);
    ps.setWallHardness(150);
    ps.setParticleSize(1);
  } else {
    ps = getParticleSystem1D(seg);
    if (!ps) return fallbackStatic(seg);
  }

  ps.updateSystem();
  ps.setBounce(seg.check2);
  ps.setMotionBlur(seg.custom2);
  const gravity = -(seg.custom3 - 16); // 0-15 down, 17-31 up
  ps.setGravity(Math.abs(gravity));

  const src = ps.sources[0];
  src.source.hue = seg.aux0 & 0xff;
  src.var = 20;
  src.minLife = 200;
  src.maxLife = 400;
  src.source.x = map(seg.custom1, 0, 255, 0, ps.maxX);
  src.v = map(seg.speed, 0, 255, -127 + src.var, 127 - src.var);
  src.sourceFlags.reversegrav = gravity < 0;

  if (seg.rng.random16(1 + ((255 - seg.intensity) >> 3)) === 0) {
    ps.sprayEmit(src);
    seg.aux0++;
  }

  ps.setColorByAge(seg.check1);
  ps.setColorByPosition(seg.check3);
  for (let i = 0; i < ps.usedParticles; i++)
    ps.particleFlags[i].reversegrav = src.sourceFlags.reversegrav;
  ps.update();
}

// int8 coercion for the few PS effects that rely on C++ int8 velocity wrap.
const s8i = (v: number): number => (v << 24) >> 24;

// --- PS DripDrop (202) -------------------------------------------------------
// mode_particleDrip: drops fall, splash at the bottom; rain mode randomizes.
function modeParticleDrip(seg: Segment): void {
  let ps: ParticleSystem1D | null;
  if (seg.call === 0) {
    ps = initParticleSystem1D(seg, 4);
    if (!ps) return fallbackStatic(seg);
    ps.setKillOutOfBounds(true);
    ps.sources[0].source.hue = seg.rng.random16() & 0xff;
    seg.aux1 = 0xffff;
  } else {
    ps = getParticleSystem1D(seg);
    if (!ps) return fallbackStatic(seg);
  }

  ps.updateSystem();
  ps.setBounce(true);
  ps.setWallHardness(50);
  ps.setMotionBlur(seg.custom2);
  ps.setGravity(seg.custom3 >> 1);
  ps.setParticleSize(seg.check3 ? 1 : 0);
  ps.enableParticleCollisions(seg.check2);
  const src = ps.sources[0];
  src.sourceFlags.collide = false;

  if (seg.check1) {
    // rain: emit at random position, short life
    if (seg.custom1 === 0) ps.setBounce(false);
    src.var = 5;
    src.v = -(8 + (seg.speed >> 2));
    src.minLife = 30;
    src.maxLife = 200;
    src.source.x = seg.rng.random16(ps.maxX);
  } else {
    // drip: from the top
    src.var = 0;
    src.v = -(seg.speed >> 1);
    src.minLife = 3000;
    src.maxLife = 3000;
    src.source.x = ps.maxX - PS_P_RADIUS_1D;
  }

  if (seg.aux1 !== seg.intensity) seg.aux0 = 1; // must not be 0 (% 0)
  seg.aux1 = seg.intensity;

  if (seg.call % seg.aux0 === 0) {
    const interval = Math.trunc(300 / (seg.intensity + 1));
    seg.aux0 = interval + seg.rng.random16(interval + 5);
    src.source.hue = seg.rng.random8();
    ps.sprayEmit(src);
  }

  for (let i = 0; i < ps.usedParticles; i++) {
    const p = ps.particles[i];
    if (p.ttl) {
      if (ps.particleFlags[i].collide === false) {
        if (p.x < PS_P_RADIUS_1D << 1) {
          // reached the bottom
          if (p.ttl > 120) p.ttl = 120;
          if (seg.custom1 > 0) {
            // splash
            p.ttl = 0;
            src.maxLife = 160;
            src.minLife = 40;
            src.var = 10 + (seg.custom1 >> 3);
            src.v = 0;
            src.source.hue = p.hue;
            src.source.x = PS_P_RADIUS_1D;
            src.sourceFlags.collide = true;
            for (let j = 0; j < 2 + (seg.custom1 >> 2); j++) ps.sprayEmit(src);
          }
        }
      } else {
        p.ttl--; // age splash particles faster
      }
    }
    if (seg.check1 && p.hue < 245) p.hue += 8;
    if (seg.speed > 200)
      ps.particleMoveUpdate(ps.particles[i], ps.particleFlags[i]);
  }

  ps.update();
}

// --- PS Pinball (203) --------------------------------------------------------
// mode_particlePinball: bouncing balls / rolling balls, palette-colored.
function modeParticlePinball(seg: Segment): void {
  let ps: ParticleSystem1D | null;
  if (seg.call === 0) {
    ps = initParticleSystem1D(seg, 1, 128, true);
    if (!ps) return fallbackStatic(seg);
    ps.sources[0].sourceFlags.collide = true;
    ps.sources[0].source.x = -1000;
    seg.aux0 = 1;
    seg.aux1 = 5000;
  } else {
    ps = getParticleSystem1D(seg);
    if (!ps) return fallbackStatic(seg);
  }

  ps.updateSystem();
  ps.setGravity(map(seg.custom3, 0, 31, 0, 8));
  ps.setBounce(seg.custom3 > 0);
  ps.setMotionBlur(seg.custom2);
  ps.enableParticleCollisions(seg.check1, 255);
  ps.setColorByPosition(seg.check3);
  let maxParticles = Math.max(
    20,
    Math.trunc(seg.intensity / (1 + (seg.check2 ? 1 : 0) * (seg.custom1 >> 5))),
  );
  if (seg.custom1 < 255) ps.setParticleSize(seg.custom1);
  else {
    ps.perParticleSize = true;
    maxParticles *= 2;
  }
  ps.setUsedParticles(maxParticles);

  const src = ps.sources[0];
  const settingsSum =
    seg.speed +
    seg.intensity +
    (seg.check2 ? 1 : 0) +
    seg.custom1 +
    ps.usedParticles;
  let updateballs = false;
  if (seg.aux1 !== settingsSum) {
    seg.step = seg.call;
    updateballs = true;
    src.maxLife = seg.custom3 ? 1000 : 0xffff;
    src.minLife = src.maxLife >> 1;
  }

  if (seg.check2) {
    // rolling balls
    ps.setGravity(0);
    ps.setWallHardness(255);
    let speedsum = 0;
    for (let i = 0; i < ps.usedParticles; i++) {
      ps.particles[i].ttl = 500;
      if (updateballs) {
        ps.particleFlags[i].collide = true;
        if (ps.particles[i].x === 0) {
          ps.particles[i].x = seg.rng.random16(ps.maxX);
          ps.particles[i].vx = seg.rng.random16() & 0x01 ? 1 : -1;
        }
        ps.particles[i].hue = seg.rng.random8();
        if (ps.advPartProps) {
          ps.advPartProps[i].sat = 255;
          ps.advPartProps[i].size = seg.rng.random8();
        }
      }
      speedsum += Math.abs(ps.particles[i].vx);
    }
    const avgSpeed = Math.trunc(speedsum / ps.usedParticles);
    const setSpeed = 2 + (seg.speed >> 2);
    if (avgSpeed < setSpeed) {
      for (let i = 0; i < setSpeed - avgSpeed; i++) {
        const idx = seg.rng.random16(ps.usedParticles);
        if (Math.abs(ps.particles[idx].vx) < 120)
          ps.particles[idx].vx += ps.particles[idx].vx >= 0 ? 1 : -1;
      }
    } else if (avgSpeed > setSpeed + 8) ps.applyFriction(1);
  } else {
    // bouncing balls
    ps.setWallHardness(220);
    src.var = seg.speed >> 3;
    const newspeed = 2 + (seg.speed >> 1) - (seg.speed >> 3);
    src.v = newspeed;
    for (let i = 0; i < ps.usedParticles; i++) {
      if (ps.particles[i].ttl < 50) ps.particles[i].ttl = 0;
      else if (
        ps.particles[i].vx === 0 &&
        ps.particles[i].x < PS_P_RADIUS_1D + seg.custom1
      )
        ps.particles[i].ttl -= 50;
      if (updateballs && seg.custom3 === 0)
        ps.particles[i].vx = ps.particles[i].vx > 0 ? newspeed : -newspeed;
    }
    if (seg.call > seg.step) {
      const interval = 260 - seg.intensity;
      seg.step += interval + seg.rng.random16(interval);
      src.source.hue = seg.rng.random16() & 0xff;
      src.sat = 255;
      src.size = seg.rng.random8();
      ps.sprayEmit(src);
    }
  }
  seg.aux1 = settingsSum;
  ps.update();
}

// --- PS Dancing Shadows (204) ------------------------------------------------
// mode_particleDancingShadows: spotlights sweep across, casting dark gaps.
// (SPOT_TYPES_COUNT is shared with the classic Dancing Shadows port above.)
function modeParticleDancingShadows(seg: Segment): void {
  let ps: ParticleSystem1D | null;
  if (seg.call === 0) {
    ps = initParticleSystem1D(seg, 1);
    if (!ps) return fallbackStatic(seg);
    ps.sources[0].maxLife = 1000;
    ps.sources[0].minLife = 1000;
  } else {
    ps = getParticleSystem1D(seg);
    if (!ps) return fallbackStatic(seg);
  }

  ps.updateSystem();
  ps.setMotionBlur(seg.custom1);
  ps.setSmearBlur(seg.check1 ? 120 : 0);
  ps.setParticleSize(seg.check3 ? 1 : 0);
  ps.setColorByPosition(seg.check2);
  ps.setUsedParticles(map(seg.intensity, 0, 255, 10, 255));

  let deadparticles = 0;
  for (let i = 0; i < ps.usedParticles; i++) {
    if ((seg.call & 0x07) === 0 && ps.particleFlags[i].outofbounds) {
      if (ps.particles[i].vx * ps.particles[i].x > 0) ps.particles[i].ttl = 0;
    }
    ps.particleFlags[i].perpetual = true;
    if (seg.call % Math.trunc(32 / (1 + (seg.custom2 >> 3))) === 0)
      ps.particles[i].hue =
        (ps.particles[i].hue + 2 + (seg.custom2 >> 5)) & 0xff;
    if (seg.aux0 !== seg.speed)
      ps.particles[i].vx =
        ps.particles[i].vx > 0 ? seg.speed >> 3 : -seg.speed >> 3;
    if (ps.particles[i].ttl === 0) deadparticles++;
  }
  seg.aux0 = seg.speed;

  if (deadparticles > 5 && (seg.call & 0x03) === 0) {
    const type = seg.rng.random16(SPOT_TYPES_COUNT);
    let speed = s8i(
      2 + seg.rng.random16(2 + (seg.speed >> 1)) + (seg.speed >> 4),
    );
    const width = seg.rng.random16(1, 10);
    let ttl = 300;
    let position: number;
    if (seg.rng.random16() & 0x01) {
      position = ps.maxXpixel;
      speed = -speed;
    } else position = -width;

    ps.sources[0].v = speed;
    ps.sources[0].source.hue = seg.rng.random8();
    for (let i = 0; i < width; i++) {
      if (width > 1) {
        switch (type) {
          case 0: // solid
            break;
          case 1: // gradient
            ttl = cubicwave8(map(i, 0, width - 1, 0, 255));
            ttl = (ttl * ttl) >> 8;
            break;
          case 2: // 2x gradient
            ttl = cubicwave8(2 * map(i, 0, width - 1, 0, 255));
            ttl = (ttl * ttl) >> 8;
            break;
          case 3: // 2x dot
            if (i > 0) position++;
            i++;
            break;
          case 4: // 3x dot
            if (i > 0) position += 2;
            i += 2;
            break;
          case 5: // 4x dot
            if (i > 0) position += 3;
            i += 3;
            break;
        }
      }
      ps.sources[0].source.x = position * PS_P_RADIUS_1D;
      const partidx = ps.sprayEmit(ps.sources[0]);
      if (partidx >= 0) ps.particles[partidx].ttl = ttl;
      position++;
    }
  }

  ps.update();
}

// --- PS Fireworks 1D (205) ---------------------------------------------------
// mode_particleFireworks1D: a rocket launches, arcs to apogee, then bursts.
const fireworks1dForce = new WeakMap<Segment, { v: number }>();
function modeParticleFireworks1D(seg: Segment): void {
  let ps: ParticleSystem1D | null;
  if (seg.call === 0) {
    ps = initParticleSystem1D(seg, 4, 150, true);
    if (!ps) return fallbackStatic(seg);
    ps.setKillOutOfBounds(true);
    ps.sources[0].sourceFlags.custom1 = true; // rocket on standby
    fireworks1dForce.set(seg, { v: 0 });
  } else {
    ps = getParticleSystem1D(seg);
    if (!ps) return fallbackStatic(seg);
  }
  const fc = fireworks1dForce.get(seg) ?? { v: 0 };

  ps.updateSystem();
  ps.setMotionBlur(seg.custom2);
  const gravity = 1 + (seg.speed >> 3);
  ps.setGravity(seg.speed ? gravity : 0);
  ps.setParticleSize(seg.check3 ? 1 : 0);

  const src = ps.sources[0];
  if (src.sourceFlags.custom1) {
    // rocket on standby
    src.source.ttl--;
    if (src.source.ttl === 0) {
      seg.aux0 = seg.rng.random8() < seg.custom1 ? 1 : 0;
      src.sourceFlags.custom1 = false;
      src.source.hue = seg.rng.random16() & 0xff;
      src.var = 10 * (seg.check2 ? 1 : 0);
      src.v = -10 * (seg.check2 ? 1 : 0);
      src.minLife = 180;
      src.maxLife = seg.check2 ? 700 : 240;
      src.source.x = seg.aux0 * ps.maxX;
      const speed = Math.trunc(
        Math.sqrt(
          Math.trunc(
            (gravity * ((ps.maxX >> 2) + seg.rng.random16(ps.maxX >> 1))) / 16,
          ),
        ),
      );
      src.source.vx = Math.min(speed, 127);
      src.source.ttl = 4000;
      src.sat = 30;
      src.sourceFlags.reversegrav = false;
      if (seg.aux0) {
        src.sourceFlags.reversegrav = true;
        src.source.vx = -src.source.vx;
        src.v = -src.v;
      }
    }
  } else {
    // rocket launched
    let rocketgravity = -gravity;
    let currentspeed = src.source.vx;
    if (seg.aux0) {
      rocketgravity = -rocketgravity;
      currentspeed = -currentspeed;
    }
    ps.applyForceOne(src.source, rocketgravity, fc);
    ps.particleMoveUpdate(src.source, src.sourceFlags);
    ps.particleMoveUpdate(src.source, src.sourceFlags); // twice: faster + ages twice
    const rocketheight = seg.aux0 ? ps.maxX - src.source.x : src.source.x;

    if (currentspeed < 0 && src.source.ttl > 50) src.source.ttl = 50 - gravity;

    if (src.source.ttl < 2) {
      // explode
      src.sourceFlags.custom1 = true;
      src.var =
        5 +
        Math.trunc(
          (((ps.maxX >> 1) + rocketheight) * (20 + (seg.intensity << 1))) /
            (ps.maxX << 2),
        );
      src.minLife = 1200;
      src.maxLife = 2600;
      src.source.ttl = 100 + seg.rng.random16(64 - (seg.speed >> 2));
      src.sat = seg.custom3 < 16 ? 10 + (seg.custom3 << 4) : 255;
      src.size = seg.check3 ? seg.rng.random16(seg.intensity) : 0;
      let explosionsize = 8 + (ps.maxXpixel >> 2) + (src.source.x >> (5 - 1));
      explosionsize += seg.rng.random16((explosionsize * seg.intensity) >> 8);
      ps.setColorByAge(false);
      ps.setColorByPosition(false);
      for (let e = 0; e < explosionsize; e++) {
        const idx = ps.sprayEmit(src);
        if (idx < 0) break;
        if (seg.custom3 > 23) {
          if (seg.custom3 === 31) {
            ps.setColorByAge(seg.check1);
            ps.setColorByPosition(!seg.check1);
          } else {
            ps.particles[idx].hue =
              (map(
                Math.abs(ps.particles[idx].vx),
                0,
                src.var,
                0,
                16 + seg.rng.random16(200),
              ) +
                src.source.hue) &
              0xff;
          }
        } else if (seg.check1) {
          src.source.hue = seg.rng.random16() & 0xff;
        }
      }
    }
  }
  if ((seg.call & 0x01) === 0 && !src.sourceFlags.custom1) ps.sprayEmit(src);
  if ((seg.call & 0x03) === 0) ps.applyFriction(1);

  ps.update();

  for (let i = 0; i < ps.usedParticles; i++) {
    if (ps.particles[i].ttl > 20) ps.particles[i].ttl -= 20;
    else ps.particles[i].ttl = 0;
  }
}

// --- PS Sparkler (206) -------------------------------------------------------
// mode_particleSparkler: stationary sparklers each spit short-lived sparks.
function modeParticleSparkler(seg: Segment): void {
  let ps: ParticleSystem1D | null;
  if (seg.call === 0) {
    ps = initParticleSystem1D(seg, 16, 128, true);
    if (!ps) return fallbackStatic(seg);
  } else {
    ps = getParticleSystem1D(seg);
    if (!ps) return fallbackStatic(seg);
  }

  ps.updateSystem();
  const sparklersettings = newPSsettings1D();
  sparklersettings.wrap = !seg.check2;
  sparklersettings.bounce = seg.check2;

  let numSparklers = ps.numSources;
  ps.setMotionBlur(seg.custom2);
  ps.setParticleSize(seg.check3 ? 60 : 0);

  for (let i = 0; i < numSparklers; i++) {
    const s = ps.sources[i];
    s.source.hue = seg.rng.random16() & 0xff;
    s.var = 0;
    s.minLife = 150 + seg.intensity;
    s.maxLife = 250 + (seg.intensity << 1);
    const speed = seg.speed >> 1;
    if (seg.check1) s.var = seg.intensity >> 3;
    s.source.vx = s.source.vx > 0 ? speed : -speed;
    s.source.ttl = 400;
    s.sat = seg.custom1;
    if (seg.speed === 255) s.source.x = seg.rng.random16(ps.maxX);
    else ps.particleMoveUpdate(s.source, s.sourceFlags, sparklersettings);
  }

  numSparklers = Math.min(1 + (seg.custom3 >> 1), numSparklers);

  if (seg.aux0 !== seg.custom3) {
    for (let i = 1; i < numSparklers; i++) {
      ps.sources[i].source.x =
        (ps.sources[0].source.x + Math.trunc(ps.maxX / numSparklers) * i) %
        ps.maxX;
    }
  }
  seg.aux0 = seg.custom3;

  const denom = (271 - seg.intensity) >> 4;
  for (let i = 0; i < numSparklers; i++) {
    if (seg.rng.random16(Math.max(1, denom)) === 0) ps.sprayEmit(ps.sources[i]);
  }

  ps.update();

  const cool = 64 - (seg.intensity >> 2);
  for (let i = 0; i < ps.usedParticles; i++) {
    if (ps.particles[i].ttl > cool) ps.particles[i].ttl -= cool;
    else ps.particles[i].ttl = 0;
  }
}

// --- PS Hourglass (207) ------------------------------------------------------
// mode_particleHourglass: particles rest, then drop one-by-one and re-stack.
interface HourglassState {
  settingTracker: number;
  direction: boolean;
}
const hourglassState = new WeakMap<Segment, HourglassState>();
function modeParticleHourglass(seg: Segment): void {
  const positionOffset = PS_P_RADIUS_1D / 2;
  let ps: ParticleSystem1D | null;
  let st: HourglassState;
  if (seg.call === 0) {
    ps = initParticleSystem1D(seg, 0, 255, false);
    if (!ps) return fallbackStatic(seg);
    ps.setBounce(true);
    ps.setWallHardness(100);
    st = { settingTracker: 0, direction: false };
    hourglassState.set(seg, st);
  } else {
    ps = getParticleSystem1D(seg);
    if (!ps) return fallbackStatic(seg);
    st = hourglassState.get(seg) ?? { settingTracker: 0, direction: false };
  }

  ps.updateSystem();
  ps.setUsedParticles(1 + ((seg.intensity * 255) >> 8));
  ps.setMotionBlur(seg.custom2);
  ps.setGravity(map(seg.custom3, 0, 31, 1, 30));
  ps.enableParticleCollisions(true, 64);

  const colormode = seg.custom1 >> 5;

  if (seg.intensity !== st.settingTracker) {
    st.settingTracker = seg.intensity;
    for (let i = 0; i < ps.usedParticles; i++) {
      ps.particleFlags[i].reversegrav = true;
      st.direction = false;
      seg.aux1 = 1;
    }
    seg.aux0 = ps.usedParticles - 1;
  }

  for (let i = 0; i < ps.usedParticles - 1; i++) {
    if (
      ps.particles[i].x < ps.particles[i + 1].x &&
      !ps.particleFlags[i].fixed &&
      !ps.particleFlags[i + 1].fixed
    ) {
      const tmp = ps.particles[i].x;
      ps.particles[i].x = ps.particles[i + 1].x;
      ps.particles[i + 1].x = tmp;
    }
  }

  const calcTargetPos = (i: number): number =>
    ps!.particleFlags[i].reversegrav
      ? ps!.maxX - i * PS_P_RADIUS_1D - positionOffset
      : (ps!.usedParticles - i) * PS_P_RADIUS_1D - positionOffset;

  for (let i = 0; i < ps.usedParticles; i++) {
    if (!ps.particleFlags[i].fixed && Math.abs(ps.particles[i].vx) < 5) {
      const targetposition = calcTargetPos(i);
      const belowtarget = ps.particleFlags[i].reversegrav
        ? ps.particles[i].x > targetposition
        : ps.particles[i].x < targetposition;
      const closeToTarget =
        Math.abs(targetposition - ps.particles[i].x) < PS_P_RADIUS_1D;
      if (belowtarget || closeToTarget) {
        ps.particles[i].x = targetposition;
        ps.particleFlags[i].fixed = true;
      }
    }
    if (colormode === 7) ps.setColorByPosition(true);
    else {
      ps.setColorByPosition(false);
      const basehue = (seg.custom1 & 0x1f) << 3;
      switch (colormode) {
        case 0:
          ps.particles[i].hue = 120;
          break;
        case 1:
          ps.particles[i].hue = basehue;
          break;
        case 2:
        case 3:
          ps.particles[i].hue = ((seg.custom1 & 0x1f) << 1) + (i % 3) * 74;
          break;
        case 4:
          ps.particles[i].hue =
            basehue + Math.trunc((i * 255) / ps.usedParticles);
          break;
        case 5:
          ps.particles[i].hue =
            basehue + Math.trunc((i * 1024) / ps.usedParticles);
          break;
        case 6:
          ps.particles[i].hue = i + (seg.now >> 3);
          break;
      }
    }
    if (seg.check1 && !ps.particleFlags[i].reversegrav)
      ps.particles[i].hue += 120;
    ps.particles[i].hue &= 0xff;
  }

  if (seg.aux1 === 1) {
    for (let i = 0; i < ps.usedParticles; i++) {
      ps.particleFlags[i].collide = true;
      ps.particleFlags[i].perpetual = true;
      ps.particles[i].ttl = 260;
      ps.particles[i].x = calcTargetPos(i);
      ps.particleFlags[i].fixed = true;
    }
  }

  if (seg.aux1 === 0) {
    if (seg.now >= seg.step) {
      if (seg.check3 && st.direction) seg.step = seg.now + 100;
      else seg.step = seg.now + Math.max(100, seg.speed * 100);
      if (seg.aux0 < ps.usedParticles) {
        ps.particleFlags[seg.aux0].reversegrav = st.direction;
        ps.particleFlags[seg.aux0].fixed = false;
      } else {
        st.direction = !st.direction;
        seg.aux1 = (seg.check2 ? 1 : 0) * seg.length + 100;
      }
      // aux0 is uint16 in firmware: underflow wraps to 65535 (not < usedParticles),
      // which is what triggers the direction flip on the next frame -- emulate it.
      if (!st.direction) seg.aux0 = (seg.aux0 - 1) & 0xffff;
      else seg.aux0 = (seg.aux0 + 1) & 0xffff;
    }
  } else if (seg.check2) seg.aux1--;

  ps.update();
}

// --- PS 1D Balance (209) -----------------------------------------------------
// mode_particleBalance: particles slide back and forth like a tilting board.
function modeParticleBalance(seg: Segment): void {
  let ps: ParticleSystem1D | null;
  if (seg.call === 0) {
    ps = initParticleSystem1D(seg, 1, 128);
    if (!ps) return fallbackStatic(seg);
    ps.setParticleSize(1);
  } else {
    ps = getParticleSystem1D(seg);
    if (!ps) return fallbackStatic(seg);
  }

  ps.updateSystem();
  ps.setMotionBlur(seg.custom2);
  ps.setBounce(!seg.check2);
  ps.setWrap(seg.check2);
  const hardness = seg.custom1 > 0 ? map(seg.custom1, 0, 255, 50, 250) : 200;
  ps.enableParticleCollisions(seg.custom1 > 0, hardness);
  ps.setWallHardness(200);
  ps.setUsedParticles(map(seg.intensity, 0, 255, 10, 255));
  if (ps.usedParticles > seg.aux1) {
    for (let i = 0; i < ps.usedParticles; i++) {
      ps.particles[i].x = i * PS_P_RADIUS_1D;
      ps.particles[i].ttl = 300;
      ps.particleFlags[i].perpetual = true;
      ps.particleFlags[i].collide = true;
    }
  }
  seg.aux1 = ps.usedParticles;

  for (let i = 0; i < ps.usedParticles - 1; i++) {
    if (ps.particles[i].x > ps.particles[i + 1].x) {
      if (
        seg.check2 &&
        ps.particles[i].x - ps.particles[i + 1].x > 3 * PS_P_RADIUS_1D
      )
        continue;
      const tmp = ps.particles[i].x;
      ps.particles[i].x = ps.particles[i + 1].x;
      ps.particles[i + 1].x = tmp;
    }
  }

  if (seg.call % (((255 - seg.speed) >> 6) + 1) === 0) {
    const increment = (seg.speed >> 6) + 1;
    seg.aux0 = (seg.aux0 + increment) & 0xff;
    let xgravity = seg.check3
      ? perlin8(seg.aux0, 0) - 128
      : cos8(seg.aux0) - 128;
    xgravity = Math.trunc((xgravity * ((seg.custom3 + 1) << 2)) / 128);
    ps.applyForce(xgravity);
  }

  const randomindex = seg.rng.random16(ps.usedParticles);
  ps.particles[randomindex].vx = s8i(
    Math.trunc((ps.particles[randomindex].vx * 200) / 255),
  );

  if ((seg.call & 0x0f) === 0 && seg.custom3 > 4) ps.applyFriction(1);

  ps.setColorByPosition(seg.check1);
  if (!seg.check1) {
    for (let i = 0; i < ps.usedParticles; i++)
      ps.particles[i].hue = Math.trunc((1024 * i) / ps.usedParticles) & 0xff;
  }
  ps.update();
}

// --- PS Chase (210) ----------------------------------------------------------
// mode_particleChase: evenly-spaced particles march + wrap, palette gradient.
interface ChaseState {
  huedir: number;
  stepdir: number;
}
const chaseState = new WeakMap<Segment, ChaseState>();
function modeParticleChase(seg: Segment): void {
  let ps: ParticleSystem1D | null;
  let cs: ChaseState;
  if (seg.call === 0) {
    ps = initParticleSystem1D(seg, 1, 191, true);
    if (!ps) return fallbackStatic(seg);
    seg.aux0 = 0xffff;
    cs = { huedir: 1, stepdir: 1 };
    chaseState.set(seg, cs);
  } else {
    ps = getParticleSystem1D(seg);
    if (!ps) return fallbackStatic(seg);
    cs = chaseState.get(seg) ?? { huedir: 1, stepdir: 1 };
  }
  const adv = ps.advPartProps;
  if (!adv) return fallbackStatic(seg);

  ps.updateSystem();
  ps.setColorByPosition(seg.check3);
  ps.setMotionBlur(7 + (seg.custom3 << 3));
  let numParticles =
    1 +
    map(
      seg.intensity,
      0,
      255,
      0,
      Math.trunc(ps.usedParticles / (1 + (seg.custom1 >> 5))),
    );
  numParticles = Math.min(numParticles, ps.usedParticles);
  let huestep = 1 + (Math.trunc((seg.custom2 << 19) / numParticles) >> 16);
  const settingssum =
    seg.speed +
    seg.intensity +
    seg.custom1 +
    seg.custom2 +
    (seg.check1 ? 1 : 0) +
    (seg.check2 ? 1 : 0) +
    (seg.check3 ? 1 : 0);
  if (seg.aux0 !== settingssum) {
    if (seg.check1)
      seg.step = (adv[0].size >> 1) + Math.trunc(ps.maxX / numParticles);
    else {
      seg.step = Math.trunc((ps.maxX + (PS_P_RADIUS_1D << 6)) / numParticles);
      seg.step = Math.trunc(seg.step / PS_P_RADIUS_1D) * PS_P_RADIUS_1D;
    }
    for (let i = 0; i < ps.usedParticles; i++) {
      adv[i].sat = 255;
      ps.particles[i].x = (i - 1) * seg.step;
      ps.particles[i].vx = seg.speed >> 2;
      adv[i].size = seg.custom1;
      if (seg.custom2 < 255) ps.particles[i].hue = (i * huestep) & 0xff;
      else ps.particles[i].hue = seg.rng.random16() & 0xff;
    }
    seg.aux0 = settingssum;
  }

  if (seg.check1)
    huestep = 1 + ((Math.max(huestep, 3) * (sin16(seg.now * 3) + 32767)) >> 15);

  for (let i = ps.usedParticles - 1; i >= 0; i--) {
    if (ps.particles[i].x > ps.maxX + PS_P_RADIUS_1D + adv[i].size) {
      const nextindex = (i + 1) % ps.usedParticles;
      ps.particles[i].x = ps.particles[nextindex].x - seg.step;
      if (seg.check1)
        adv[i].size = Math.max(
          1 + (seg.custom1 >> 1),
          (sin16(seg.now << 1) + 32767) >> 8,
        );
      if (seg.custom2 < 255)
        ps.particles[i].hue = (ps.particles[nextindex].hue - huestep) & 0xff;
      else ps.particles[i].hue = seg.rng.random16() & 0xff;
    }
    ps.particles[i].ttl = 300;
  }

  if (seg.check1) {
    if (cs.stepdir === 0) cs.stepdir = 1;
    if (cs.huedir === 0) cs.huedir = 1;
    if (
      seg.step >=
      adv[0].size + PS_P_RADIUS_1D * 4 + Math.trunc(ps.maxX / numParticles)
    )
      cs.stepdir = -1;
    else if (
      seg.step <=
      (adv[0].size >> 1) + Math.trunc(ps.maxX / numParticles)
    )
      cs.stepdir = 1;
    if (seg.aux1 > 512) cs.huedir = -1;
    else if (seg.aux1 < 50) cs.huedir = 1;
    if (seg.call % Math.trunc(1024 / (1 + (seg.speed >> 2))) === 0)
      seg.aux1 += cs.huedir;
    let globalhuestep = 0;
    if (seg.call % (1 + ((sin16(seg.now) + 32767) >> 12)) === 0)
      globalhuestep = 2;
    if ((seg.call & 0x1f) === 0) seg.step += cs.stepdir;
    for (let i = 0; i < ps.usedParticles; i++) {
      ps.particles[i].hue = (ps.particles[i].hue - globalhuestep) & 0xff;
      ps.particles[i].vx =
        1 +
        (seg.speed >> 2) +
        (((sin16(seg.now >> 1) + 32767) * (seg.speed >> 2)) >> 16);
    }
  }

  ps.update();
}

// --- PS Starburst (211) ------------------------------------------------------
// mode_particleStarburst: periodic bursts of shrinking, whitening fragments.
function modeParticleStarburst(seg: Segment): void {
  let ps: ParticleSystem1D | null;
  if (seg.call === 0) {
    ps = initParticleSystem1D(seg, 1, 200, true);
    if (!ps) return fallbackStatic(seg);
    ps.setKillOutOfBounds(true);
    ps.enableParticleCollisions(true, 200);
    ps.sources[0].source.ttl = 1;
    ps.sources[0].sat = 0;
  } else {
    ps = getParticleSystem1D(seg);
    if (!ps) return fallbackStatic(seg);
  }
  const adv = ps.advPartProps;
  if (!adv) return fallbackStatic(seg);

  ps.updateSystem();
  ps.setMotionBlur(seg.custom2);
  ps.setGravity(seg.check1 ? 8 : 0);

  const src = ps.sources[0];
  const was = src.source.ttl;
  src.source.ttl = was - 1;
  if (was === 0) {
    const explosionsize = 4 + seg.rng.random16(seg.intensity >> 2);
    src.source.hue = seg.rng.random16() & 0xff;
    src.var = 10 + (explosionsize << 1);
    src.minLife = 150;
    src.maxLife = 300;
    src.source.x = seg.rng.random16(ps.maxX);
    src.source.ttl = 10 + seg.rng.random16(255 - seg.speed);
    src.size = seg.custom1;
    src.sourceFlags.collide = seg.check3;
    for (let e = 0; e < explosionsize; e++) {
      if (seg.check2) src.source.hue = seg.rng.random16() & 0xff;
      ps.sprayEmit(src);
    }
  }

  for (let i = 0; i < ps.usedParticles; i++) {
    if (adv[i].size) adv[i].size--;
    if (adv[i].sat < 250) adv[i].sat += 2 + (seg.custom3 >> 3);
  }

  if (seg.call % 5 === 0) ps.applyFriction(1);

  ps.update();
}

// --- PS Fire 1D (213) --------------------------------------------------------
// mode_particleFire1D: rising flame particles from base sources, aging to cool.
function modeParticleFire1D(seg: Segment): void {
  let ps: ParticleSystem1D | null;
  if (seg.call === 0) {
    ps = initParticleSystem1D(seg, 5);
    if (!ps) return fallbackStatic(seg);
    ps.setKillOutOfBounds(true);
    ps.setParticleSize(1);
  } else {
    ps = getParticleSystem1D(seg);
    if (!ps) return fallbackStatic(seg);
  }

  ps.updateSystem();
  ps.setMotionBlur(128 + (seg.custom2 >> 1));
  ps.setColorByAge(true);
  let emitparticles = 1;
  let j = seg.rng.random16();
  for (let i = 0; i < 3; i++) {
    if (ps.sources[i].source.ttl > 50) ps.sources[i].source.ttl -= 10;
    else ps.sources[i].source.ttl = 100 + seg.rng.random16(200);
  }
  for (let i = 0; i < ps.numSources; i++) {
    j = (j + 1) % ps.numSources;
    const s = ps.sources[j];
    s.source.x = 0;
    s.var = 2 + (seg.speed >> 4);
    if (j > 2) {
      s.minLife = 150 + seg.intensity + (j << 2);
      s.maxLife = 200 + seg.intensity + (j << 3);
      s.v = seg.speed >> (2 + (j << 1));
      if (emitparticles) {
        emitparticles--;
        ps.sprayEmit(s);
      }
    } else {
      s.minLife = s.source.ttl + seg.intensity;
      s.maxLife = s.minLife + 50;
      s.v = seg.speed >> 2;
      if (seg.call & 0x01) ps.sprayEmit(s);
    }
  }

  for (let i = 0; i < ps.usedParticles; i++) {
    ps.particles[i].x += ps.particles[i].ttl >> 7;
    if (ps.particles[i].ttl > 3 + ((255 - seg.custom1) >> 1))
      ps.particles[i].ttl -= map(seg.custom1, 0, 255, 1, 3);
  }

  ps.update();
}

/**
 * Registry of ported effect bodies, keyed by real WLED fx id (v16.0.0). The
 * value is a per-frame function; an id absent here has no simulation yet and
 * the UI falls back to the CSS preview family (see index.ts isPorted).
 */
// ============================================================================
// 2D effects (matrix preview -- decisions.md 2026-07-17). Bodies take a
// Segment2D; every one keeps the firmware's "not a 2D setup" static fallback
// so a degenerate 1×N matrix never crashes.
// ============================================================================

const DARKSLATEGRAY = 0x2f4f4f;

// --- Black Hole (183) -------------------------------------------------------
function mode2DBlackHole(seg: Segment2D): void {
  if (!seg.is2D()) return fallbackStatic(seg);
  const cols = seg.width;
  const rows = seg.height;

  seg.fadeToBlackBy(16 + (seg.speed >> 3)); // fading trails
  const t = Math.trunc(seg.now / 128);
  // outer stars
  for (let i = 0; i < 8; i++) {
    const x = beatsin8_t(
      seg.custom1 >> 3,
      seg.now,
      0,
      cols - 1,
      0,
      (i % 2 ? 128 : 0) + t * i,
    );
    const y = beatsin8_t(
      seg.intensity >> 3,
      seg.now,
      0,
      rows - 1,
      0,
      (i % 2 ? 192 : 64) + t * i,
    );
    seg.addPixelColorXY(
      x,
      y,
      seg.color_from_palette(i * 32, false, false, seg.check1 ? 0 : 255),
    );
  }
  // inner stars
  for (let i = 0; i < 4; i++) {
    const x = beatsin8_t(
      seg.custom2 >> 3,
      seg.now,
      Math.trunc(cols / 4),
      cols - 1 - Math.trunc(cols / 4),
      0,
      (i % 2 ? 128 : 0) + t * i,
    );
    const y = beatsin8_t(
      seg.custom3,
      seg.now,
      Math.trunc(rows / 4),
      rows - 1 - Math.trunc(rows / 4),
      0,
      (i % 2 ? 192 : 64) + t * i,
    );
    seg.addPixelColorXY(
      x,
      y,
      seg.color_from_palette(255 - i * 64, false, false, seg.check1 ? 0 : 255),
    );
  }
  // central white dot
  seg.setPixelColorXY(Math.trunc(cols / 2), Math.trunc(rows / 2), WHITE);
  if (seg.check3) seg.blur(16, cols * rows < 100);
}

// --- Colored Bursts (167) ---------------------------------------------------
function mode2DColoredBursts(seg: Segment2D): void {
  if (!seg.is2D()) return fallbackStatic(seg);
  const cols = seg.width;
  const rows = seg.height;

  if (seg.call === 0) seg.aux0 = 0; // start with red hue

  const dot = seg.check3;
  const grad = seg.check1;
  const numLines = Math.trunc(seg.intensity / 16) + 1;

  seg.aux0 = (seg.aux0 + 1) & 0xffff; // hue
  seg.fadeToBlackBy(40 - (seg.check2 ? 8 : 0));
  const palette = seg.getCurrentPalette();
  for (let i = 0; i < numLines; i++) {
    const x1 = beatsin8_t(2 + Math.trunc(seg.speed / 16), seg.now, 0, cols - 1);
    const x2 = beatsin8_t(1 + Math.trunc(seg.speed / 16), seg.now, 0, rows - 1);
    const y1 = beatsin8_t(
      5 + Math.trunc(seg.speed / 16),
      seg.now,
      0,
      cols - 1,
      0,
      i * 24,
    );
    const y2 = beatsin8_t(
      3 + Math.trunc(seg.speed / 16),
      seg.now,
      0,
      rows - 1,
      0,
      i * 48 + 64,
    );
    const color = colorFromPalette(
      palette,
      Math.trunc((i * 255) / numLines) + (seg.aux0 & 0xff),
      255,
      LINEARBLEND,
    );

    const xsteps = Math.abs(x1 - y1) + 1;
    const ysteps = Math.abs(x2 - y2) + 1;
    const steps = xsteps >= ysteps ? xsteps : ysteps;
    // gradient line
    for (let j = 1; j <= steps; j++) {
      const rate = Math.trunc((j * 255) / steps);
      const dx = lerp8by8(x1, y1, rate);
      const dy = lerp8by8(x2, y2, rate);
      seg.addPixelColorXY(dx, dy, color);
      if (grad) seg.fadePixelColorXY(dx, dy, rate);
    }

    if (dot) {
      // white points at the ends of the line
      seg.setPixelColorXY(x1, x2, WHITE);
      seg.setPixelColorXY(y1, y2, DARKSLATEGRAY);
    }
  }
  seg.blur(seg.custom3 >> 1, seg.check2);
}

// --- DNA (152) --------------------------------------------------------------
function mode2DDna(seg: Segment2D): void {
  if (!seg.is2D()) return fallbackStatic(seg);
  const cols = seg.width;
  const rows = seg.height;

  seg.fadeToBlackBy(64);
  const palette = seg.getCurrentPalette();
  for (let i = 0; i < cols; i++) {
    seg.setPixelColorXY(
      i,
      beatsin8_t(Math.trunc(seg.speed / 8), seg.now, 0, rows - 1, 0, i * 4),
      colorFromPalette(
        palette,
        i * 5 + Math.trunc(seg.now / 17),
        beatsin8_t(5, seg.now, 55, 255, 0, i * 10),
        LINEARBLEND,
      ),
    );
    seg.setPixelColorXY(
      i,
      beatsin8_t(
        Math.trunc(seg.speed / 8),
        seg.now,
        0,
        rows - 1,
        0,
        i * 4 + 128,
      ),
      colorFromPalette(
        palette,
        i * 5 + 128 + Math.trunc(seg.now / 17),
        beatsin8_t(5, seg.now, 55, 255, 0, i * 10 + 128),
        LINEARBLEND,
      ),
    );
  }
  seg.blur(Math.trunc(seg.intensity / (8 - (seg.check1 ? 2 : 0))), seg.check1);
}

// --- DNA Spiral (182) -------------------------------------------------------
function mode2DDnaSpiral(seg: Segment2D): void {
  if (!seg.is2D()) return fallbackStatic(seg);
  const cols = seg.width;
  const rows = seg.height;

  if (seg.call === 0) seg.fill(BLACK);

  const speeds = Math.trunc(seg.speed / 2) + 7;
  const freq = Math.trunc(seg.intensity / 8);

  const ms = Math.trunc(seg.now / 20);
  seg.fadeToBlackBy(135);
  const palette = seg.getCurrentPalette();

  for (let i = 0; i < rows; i++) {
    let x =
      beatsin8_t(speeds, seg.now, 0, cols - 1, 0, i * freq) +
      beatsin8_t((speeds - 7) & 0xff, seg.now, 0, cols - 1, 0, i * freq + 128);
    let x1 =
      beatsin8_t(speeds, seg.now, 0, cols - 1, 0, 128 + i * freq) +
      beatsin8_t(
        (speeds - 7) & 0xff,
        seg.now,
        0,
        cols - 1,
        0,
        128 + 64 + i * freq,
      );
    const hue = Math.trunc((i * 128) / rows) + ms;
    // skip every 4th row every now and then (fade it more)
    if ((i + Math.trunc(ms / 8)) & 3) {
      x = Math.trunc(x / 2);
      x1 = Math.trunc(x1 / 2);
      const steps = Math.abs(x - x1) + 1;
      const positive = x1 >= x; // direction of drawing
      for (let k = 1; k <= steps; k++) {
        const rate = Math.trunc((k * 255) / steps);
        const dx = positive ? x + k - 1 : x - k + 1; // lerp without holes
        seg.addPixelColorXY(
          dx,
          i,
          colorFromPalette(palette, hue, 255, LINEARBLEND),
        );
        seg.fadePixelColorXY(dx, i, rate);
      }
      seg.setPixelColorXY(x, i, DARKSLATEGRAY);
      seg.setPixelColorXY(x1, i, WHITE);
    }
  }
  seg.blur(
    Math.trunc((seg.custom1 * 3) / (6 + (seg.check1 ? 1 : 0))),
    seg.check1,
  );
}

// --- Drift (164) ------------------------------------------------------------
function mode2DDrift(seg: Segment2D): void {
  if (!seg.is2D()) return fallbackStatic(seg);
  const cols = seg.width;
  const rows = seg.height;

  const colsCenter = (cols >> 1) + (cols % 2);
  const rowsCenter = (rows >> 1) + (rows % 2);

  seg.fadeToBlackBy(128);
  // MAX() on two ints upstream, so the /2 truncates before the float assign
  const maxDim = Math.max(cols, rows) >> 1;
  const t = Math.trunc(seg.now / (32 - (seg.speed >> 3)));
  const t20 = Math.trunc(t / 20);
  const palette = seg.getCurrentPalette();
  for (let i = 1.0; i < maxDim; i += 0.25) {
    const angle = (t * (maxDim - i) * Math.PI) / 180; // radians()
    const mySin = Math.trunc(sin_approx(angle) * i);
    const myCos = Math.trunc(cos_approx(angle) * i);
    const color = colorFromPalette(
      palette,
      Math.trunc(i * 20 + t20),
      255,
      LINEARBLEND,
    );
    seg.setPixelColorXY(colsCenter + mySin, rowsCenter + myCos, color);
    if (seg.check1)
      seg.setPixelColorXY(colsCenter + myCos, rowsCenter + mySin, color);
  }
  seg.blur(seg.intensity >> (3 - (seg.check2 ? 1 : 0)), seg.check2);
}

// --- Firenoise (149) --------------------------------------------------------
// the effect's built-in non-palette fire ramp (CRGBPalette16 literal)
const FIRENOISE_PAL: RGB[] = [
  [0, 0, 0],
  [0, 0, 0],
  [0, 0, 0],
  [0, 0, 0],
  [255, 0, 0],
  [255, 0, 0],
  [255, 0, 0],
  [255, 140, 0],
  [255, 140, 0],
  [255, 140, 0],
  [255, 165, 0],
  [255, 165, 0],
  [255, 255, 0],
  [255, 165, 0],
  [255, 255, 0],
  [255, 255, 0],
];

function mode2DFirenoise(seg: Segment2D): void {
  if (!seg.is2D()) return fallbackStatic(seg);
  const cols = seg.width;
  const rows = seg.height;

  if (seg.call === 0) seg.fill(BLACK);

  const xscale = seg.intensity * 4;
  const yscale = seg.speed * 8;

  const pal = seg.check1 ? seg.getCurrentPalette() : FIRENOISE_PAL;
  for (let j = 0; j < cols; j++) {
    for (let i = 0; i < rows; i++) {
      const indexx = perlin8(
        Math.trunc((j * yscale * rows) / 255),
        i * xscale + Math.trunc(seg.now / 4),
      );
      seg.setPixelColorXY(
        j,
        i,
        colorFromPalette(
          pal,
          Math.min(Math.trunc((i * indexx) / 11), 225),
          Math.trunc((i * 255) / rows),
          LINEARBLEND,
        ),
      );
    }
  }
}

// --- Frizzles (177) ---------------------------------------------------------
function mode2DFrizzles(seg: Segment2D): void {
  if (!seg.is2D()) return fallbackStatic(seg);
  const cols = seg.width;
  const rows = seg.height;

  seg.fadeToBlackBy(16 + (seg.check1 ? 10 : 0));
  const palette = seg.getCurrentPalette();
  for (let i = 8; i > 0; i--) {
    seg.addPixelColorXY(
      beatsin8_t((Math.trunc(seg.speed / 8) + i) & 0xff, seg.now, 0, cols - 1),
      beatsin8_t(
        (Math.trunc(seg.intensity / 8) - i) & 0xff,
        seg.now,
        0,
        rows - 1,
      ),
      colorFromPalette(
        palette,
        beatsin8_t(12, seg.now, 0, 255),
        255,
        LINEARBLEND,
      ),
    );
  }
  seg.blur(seg.custom1 >> (3 + (seg.check1 ? 1 : 0)), seg.check1);
}

// --- Julia (168) ------------------------------------------------------------
interface JuliaState {
  xcen: number;
  ycen: number;
  xymag: number;
}
const JULIA_STATE = new WeakMap<Segment, JuliaState>();

function mode2DJulia(seg: Segment2D): void {
  if (!seg.is2D()) return fallbackStatic(seg);
  const cols = seg.width;
  const rows = seg.height;

  let st = JULIA_STATE.get(seg);
  if (!st || seg.call === 0) {
    st = { xcen: 0, ycen: 0, xymag: 1.0 };
    JULIA_STATE.set(seg, st);
    // firmware re-centers the location widgets on restart
    seg.custom1 = 128;
    seg.custom2 = 128;
    seg.custom3 = 16;
    seg.intensity = 24;
  }

  st.xcen += (seg.custom1 - 128) / 100000;
  st.ycen += (seg.custom2 - 128) / 100000;
  st.xymag += ((seg.custom3 - 16) << 3) / 100000;
  if (st.xymag < 0.01) st.xymag = 0.01;
  if (st.xymag > 1.0) st.xymag = 1.0;

  const clampf = (v: number, lo: number, hi: number): number =>
    v < lo ? lo : v > hi ? hi : v;
  const xmin = clampf(st.xcen - st.xymag, -1.2, 1.2);
  const xmax = clampf(st.xcen + st.xymag, -1.2, 1.2);
  const ymin = clampf(st.ycen - st.xymag, -0.8, 1.0);
  const ymax = clampf(st.ycen + st.xymag, -0.8, 1.0);

  const maxIterations = Math.trunc(seg.intensity / 2);
  const maxCalc = 16.0;

  let reAl = -0.94299; // PixelBlaze example
  let imAg = 0.3162;
  reAl += sin16(seg.now * 34) / 655340;
  imAg += sin16(seg.now * 26) / 655340;

  const dx = (xmax - xmin) / cols;
  const dy = (ymax - ymin) / rows;

  let y = ymin;
  for (let j = 0; j < rows; j++) {
    let x = xmin;
    for (let i = 0; i < cols; i++) {
      // iterate z = z^2 + c; does z tend towards infinity?
      let a = x;
      let b = y;
      let iter = 0;
      while (iter < maxIterations) {
        const aa = a * a;
        const bb = b * b;
        if (aa + bb > maxCalc) break;
        b = 2 * a * b + imAg;
        a = aa - bb + reAl;
        iter++;
      }
      if (iter === maxIterations) {
        seg.setPixelColorXY(i, j, 0);
      } else {
        seg.setPixelColorXY(
          i,
          j,
          seg.color_from_palette(
            Math.trunc((iter * 255) / maxIterations),
            false,
            false,
            0,
          ),
        );
      }
      x += dx;
    }
    y += dy;
  }
  if (seg.check1) seg.blur(100, true);
}

// --- Lissajous (176) --------------------------------------------------------
function mode2DLissajous(seg: Segment2D): void {
  if (!seg.is2D()) return fallbackStatic(seg);
  const cols = seg.width;
  const rows = seg.height;

  seg.fadeToBlackBy(seg.intensity);
  const phase = Math.trunc((seg.now * (1 + seg.custom3)) / 32);

  for (let i = 0; i < 256; i++) {
    let xlocn = sin8(Math.trunc(phase / 2) + Math.trunc((i * seg.speed) / 32));
    let ylocn = cos8(Math.trunc(phase / 2) + i * 2);
    xlocn =
      cols < 2
        ? 1
        : Math.trunc((map(2 * xlocn, 0, 511, 0, 2 * (cols - 1)) + 1) / 2);
    ylocn =
      rows < 2
        ? 1
        : Math.trunc((map(2 * ylocn, 0, 511, 0, 2 * (rows - 1)) + 1) / 2);
    seg.setPixelColorXY(
      xlocn,
      ylocn,
      seg.color_from_palette(Math.trunc(seg.now / 100) + i, false, false, 0),
    );
  }
  seg.blur(seg.custom1 >> (1 + (seg.check1 ? 3 : 0)), seg.check1);
}

// --- Matrix (153) -----------------------------------------------------------
function mode2DMatrix(seg: Segment2D): void {
  if (!seg.is2D()) return fallbackStatic(seg);
  const cols = seg.width;
  const rows = seg.height;
  const XY = (x: number, y: number): number => (x % cols) + (y % rows) * cols;

  const dataSize = (seg.length + 7) >> 3; // 1 bit per LED for trails
  const data = seg.allocateData(dataSize);

  if (seg.call === 0) {
    seg.fill(BLACK);
    seg.step = 0;
  }

  const fade = map(seg.custom1, 0, 255, 50, 250); // trail size
  const speed = (256 - seg.speed) >> map(Math.min(rows, 150), 0, 150, 0, 3);

  let spawnColor: number;
  let trailColor: number;
  if (seg.check1) {
    spawnColor = seg.color(0);
    trailColor = seg.color(1);
  } else {
    spawnColor = rgbw32(175, 255, 175, 0);
    trailColor = rgbw32(27, 130, 39, 0);
  }

  let emptyScreen = true;
  if (seg.now - seg.step >= speed) {
    seg.step = seg.now;
    // falling codes keep color and add trail pixels; all others fade
    seg.fadeToBlackBy(fade);
    for (let row = rows - 1; row >= 0; row--) {
      for (let col = 0; col < cols; col++) {
        let index = XY(col, row) >> 3;
        let bitNum = XY(col, row) & 0x07;
        if ((data[index] >> bitNum) & 1) {
          seg.setPixelColorXY(col, row, trailColor); // trail
          data[index] &= ~(1 << bitNum);
          if (row < rows - 1) {
            seg.setPixelColorXY(col, row + 1, spawnColor);
            index = XY(col, row + 1) >> 3;
            bitNum = XY(col, row + 1) & 0x07;
            data[index] |= 1 << bitNum;
            emptyScreen = false;
          }
        }
      }
    }

    // spawn new falling code
    if (seg.rng.random8() <= seg.intensity || emptyScreen) {
      const spawnX = seg.rng.random8(cols);
      seg.setPixelColorXY(spawnX, 0, spawnColor);
      const index = XY(spawnX, 0) >> 3;
      const bitNum = XY(spawnX, 0) & 0x07;
      data[index] |= 1 << bitNum;
    }
  }
}

// --- Metaballs (154) --------------------------------------------------------
function mode2DMetaballs(seg: Segment2D): void {
  if (!seg.is2D()) return fallbackStatic(seg);
  const cols = seg.width;
  const rows = seg.height;

  const speed = 0.25 * (1 + (seg.speed >> 6));
  const sqrt32 = (v: number): number => Math.trunc(Math.sqrt(v));

  // two random moving points
  const x2 = map(
    perlin8(Math.trunc(seg.now * speed), 25355, 685),
    0,
    255,
    0,
    cols - 1,
  );
  const y2 = map(
    perlin8(Math.trunc(seg.now * speed), 355, 11685),
    0,
    255,
    0,
    rows - 1,
  );
  const x3 = map(
    perlin8(Math.trunc(seg.now * speed), 55355, 6685),
    0,
    255,
    0,
    cols - 1,
  );
  const y3 = map(
    perlin8(Math.trunc(seg.now * speed), 25355, 22685),
    0,
    255,
    0,
    rows - 1,
  );

  // and one Lissajous function
  const x1 = beatsin8_t(Math.trunc(23 * speed) & 0xff, seg.now, 0, cols - 1);
  const y1 = beatsin8_t(Math.trunc(28 * speed) & 0xff, seg.now, 0, rows - 1);

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      // weighted sum of distances of the 3 points from this pixel
      let dx = Math.abs(x - x1);
      let dy = Math.abs(y - y1);
      let dist = 2 * sqrt32(dx * dx + dy * dy);

      dx = Math.abs(x - x2);
      dy = Math.abs(y - y2);
      dist += sqrt32(dx * dx + dy * dy);

      dx = Math.abs(x - x3);
      dy = Math.abs(y - y3);
      dist += sqrt32(dx * dx + dy * dy);

      const color = dist ? Math.trunc(1000 / dist) : 255;

      if (color > 0 && color < 60) {
        seg.setPixelColorXY(
          x,
          y,
          seg.color_from_palette(
            map(color * 9, 9, 531, 0, 255),
            false,
            false,
            0,
          ),
        );
      } else {
        seg.setPixelColorXY(x, y, seg.color_from_palette(0, false, false, 0));
      }
      // show the 3 points, too
      seg.setPixelColorXY(x1, y1, WHITE);
      seg.setPixelColorXY(x2, y2, WHITE);
      seg.setPixelColorXY(x3, y3, WHITE);
    }
  }
}

// --- Noise2D (146) ----------------------------------------------------------
function mode2DNoise(seg: Segment2D): void {
  if (!seg.is2D()) return fallbackStatic(seg);
  const cols = seg.width;
  const rows = seg.height;

  const scale = seg.intensity + 2;
  const palette = seg.getCurrentPalette();
  const z = Math.trunc(seg.now / (16 - Math.trunc(seg.speed / 16)));

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const pixelHue8 = perlin8(x * scale, y * scale, z);
      seg.setPixelColorXY(x, y, colorFromPalette(palette, pixelHue8));
    }
  }
}

// --- Plasma Ball (178) ------------------------------------------------------
function mode2DPlasmaball(seg: Segment2D): void {
  if (!seg.is2D()) return fallbackStatic(seg);
  const cols = seg.width;
  const rows = seg.height;

  seg.fadeToBlackBy(seg.custom1 >> 2);
  const t = Math.trunc((seg.now * 8) / (256 - seg.speed));
  const palette = seg.getCurrentPalette();
  for (let i = 0; i < cols; i++) {
    const thisVal = perlin8(i * 30, t, t);
    const thisMax = map(thisVal, 0, 255, 0, cols - 1);
    for (let j = 0; j < rows; j++) {
      const thisVal_ = perlin8(t, j * 30, t);
      const thisMax_ = map(thisVal_, 0, 255, 0, rows - 1);
      const x = i + thisMax_ - Math.trunc(cols / 2);
      const y = j + thisMax - Math.trunc(cols / 2);
      const cx = i + thisMax_;
      const cy = j + thisMax;

      const lit =
        (x - y > -2 && x - y < 2) ||
        (cols - 1 - x - y > -2 && cols - 1 - x - y < 2) ||
        cols - cx === 0 ||
        cols - 1 - cx === 0 ||
        rows - cy === 0 ||
        rows - 1 - cy === 0;
      seg.addPixelColorXY(
        i,
        j,
        lit
          ? colorFromPalette(palette, beat8(5, seg.now), thisVal, LINEARBLEND)
          : BLACK,
      );
    }
  }
  seg.blur(seg.custom2 >> 5);
}

// --- Polar Lights (174) -----------------------------------------------------
function mode2DPolarLights(seg: Segment2D): void {
  if (!seg.is2D()) return fallbackStatic(seg);
  const cols = seg.width;
  const rows = seg.height;

  if (seg.call === 0) {
    seg.fill(BLACK);
    seg.step = 0;
  }

  const adjustHeight = map(rows, 8, 32, 28, 12);
  const adjScale = map(cols, 8, 64, 310, 63);
  const scale = map(seg.intensity, 0, 255, 30, adjScale);
  const speed = map(seg.speed, 0, 255, 128, 16);

  for (let x = 0; x < cols; x++) {
    for (let y = 0; y < rows; y++) {
      seg.step++;
      let palindex = qsub8(
        perlin8(
          (seg.step % 2) + x * scale,
          y * 16 + (seg.step % 16),
          Math.trunc(seg.step / speed),
        ),
        Math.trunc(Math.abs(rows / 2 - y) * adjustHeight),
      );
      const palbrightness = palindex;
      if (seg.check1) palindex = 255 - palindex; // flip palette
      seg.setPixelColorXY(
        x,
        y,
        seg.color_from_palette(palindex, false, false, 255, palbrightness),
      );
    }
  }
}

// --- Pulser (162) -----------------------------------------------------------
function mode2DPulser(seg: Segment2D): void {
  if (!seg.is2D()) return fallbackStatic(seg);
  const cols = seg.width;
  const rows = seg.height;

  seg.fadeToBlackBy(8 - (seg.intensity >> 5));
  const a = Math.trunc(seg.now / (18 - Math.trunc(seg.speed / 16)));
  const x = Math.trunc(a / 14) % cols;
  const y = map(sin8(a * 5) + sin8(a * 4) + sin8(a * 2), 0, 765, rows - 1, 0);
  seg.setPixelColorXY(
    x,
    y,
    colorFromPalette(
      seg.getCurrentPalette(),
      map(y, 0, rows - 1, 0, 255),
      255,
      LINEARBLEND,
    ),
  );

  seg.blur(seg.intensity >> 4);
}

// --- Sindots (181) ----------------------------------------------------------
function mode2DSindots(seg: Segment2D): void {
  if (!seg.is2D()) return fallbackStatic(seg);
  const cols = seg.width;
  const rows = seg.height;

  if (seg.call === 0) seg.fill(BLACK);

  seg.fadeToBlackBy((seg.custom1 >> 3) + (seg.check1 ? 24 : 0));

  const t1 = Math.trunc(seg.now / (257 - seg.speed)) & 0xff;
  const t2 = (Math.trunc(sin8(t1) / 4) * 2) & 0xff;
  const palette = seg.getCurrentPalette();
  for (let i = 0; i < 13; i++) {
    const x = Math.trunc(
      (sin8(t1 + Math.trunc((i * seg.intensity) / 8)) * (cols - 1)) / 255,
    );
    const y = Math.trunc(
      (sin8(t2 + Math.trunc((i * seg.intensity) / 8)) * (rows - 1)) / 255,
    );
    seg.setPixelColorXY(
      x,
      y,
      colorFromPalette(palette, Math.trunc((i * 255) / 13), 255, LINEARBLEND),
    );
  }
  seg.blur(seg.custom2 >> (3 + (seg.check1 ? 1 : 0)), seg.check1);
}

// --- Squared Swirl (150) ----------------------------------------------------
function mode2DSquaredSwirl(seg: Segment2D): void {
  if (!seg.is2D()) return fallbackStatic(seg);
  const cols = seg.width;
  const rows = seg.height;
  const kBorderWidth = 2;

  seg.fadeToBlackBy(1 + Math.trunc(seg.intensity / 5));
  seg.blur(seg.custom3 >> 1);

  // two out-of-sync sine waves
  const i = beatsin8_t(19, seg.now, kBorderWidth, cols - kBorderWidth);
  const j = beatsin8_t(22, seg.now, kBorderWidth, cols - kBorderWidth);
  const k = beatsin8_t(17, seg.now, kBorderWidth, cols - kBorderWidth);
  const m = beatsin8_t(18, seg.now, kBorderWidth, rows - kBorderWidth);
  const n = beatsin8_t(15, seg.now, kBorderWidth, rows - kBorderWidth);
  const p = beatsin8_t(20, seg.now, kBorderWidth, rows - kBorderWidth);

  const palette = seg.getCurrentPalette();
  seg.addPixelColorXY(
    i,
    m,
    colorFromPalette(palette, Math.trunc(seg.now / 29), 255, LINEARBLEND),
  );
  seg.addPixelColorXY(
    j,
    n,
    colorFromPalette(palette, Math.trunc(seg.now / 41), 255, LINEARBLEND),
  );
  seg.addPixelColorXY(
    k,
    p,
    colorFromPalette(palette, Math.trunc(seg.now / 73), 255, LINEARBLEND),
  );
}

// --- Sun Radiation (166) ----------------------------------------------------
/** FastLED HeatColor: black-body radiation ramp, packed RGB. */
function heatColor(temperature: number): number {
  const t192 = scale8_video(temperature & 0xff, 191);
  let heatramp = t192 & 0x3f; // 0..63
  heatramp <<= 2; // 0..252
  if (t192 & 0x80) return rgbw32(255, 255, heatramp, 0); // hottest
  if (t192 & 0x40) return rgbw32(255, heatramp, 0, 0); // middle
  return rgbw32(heatramp, 0, 0, 0); // coolest
}

function mode2DSunRadiation(seg: Segment2D): void {
  if (!seg.is2D()) return fallbackStatic(seg);
  const cols = seg.width;
  const rows = seg.height;

  const bump = seg.allocateData((cols + 2) * (rows + 2));
  if (seg.call === 0) seg.fill(BLACK);

  const t = Math.trunc(seg.now / 4);
  let index = 0;
  const someVal = Math.trunc(seg.speed / 4);
  for (let j = 0; j < rows + 2; j++) {
    for (let i = 0; i < cols + 2; i++) {
      // signed byte stored in a Uint8Array, read back via s8 below
      bump[index++] = (perlin8(i * someVal, j * someVal, t) - 127) >> 2;
    }
  }
  const sb = (v: number): number => (v << 24) >> 24;
  const abs8 = (v: number): number => Math.abs(sb(v));

  let yindex = cols + 3;
  let vly = -(Math.trunc(rows / 2) + 1);
  for (let y = 0; y < rows; y++) {
    ++vly;
    let vlx = -(Math.trunc(cols / 2) + 1);
    for (let x = 0; x < cols; x++) {
      ++vlx;
      const nx = sb(bump[x + yindex + 1]) - sb(bump[x + yindex - 1]);
      const ny =
        sb(bump[x + yindex + (cols + 2)]) - sb(bump[x + yindex - (cols + 2)]);
      const difx = abs8(vlx * 7 - nx);
      const dify = abs8(vly * 7 - ny);
      const temp = difx * difx + dify * dify;
      let col = 255 - Math.trunc(temp / 8); // 8 is the size of the effect
      if (col < 0) col = 0;
      seg.setPixelColorXY(
        x,
        y,
        heatColor(Math.trunc(col / (3.0 - seg.intensity / 128))),
      );
    }
    yindex += cols + 2;
  }
}

// --- Tartan (173) -----------------------------------------------------------
function mode2DTartan(seg: Segment2D): void {
  if (!seg.is2D()) return fallbackStatic(seg);
  const cols = seg.width;
  const rows = seg.height;

  if (seg.call === 0) seg.fill(BLACK);

  const offsetX = beatsin16_t(3, seg.now, -360, 360);
  const offsetY = beatsin16_t(2, seg.now, -360, 360);
  const sharpness = Math.trunc(seg.custom3 / 8); // 0-3
  const palette = seg.getCurrentPalette();
  const hueScale = beatsin16_t(10, seg.now, 1, 10);

  for (let x = 0; x < cols; x++) {
    for (let y = 0; y < rows; y++) {
      let hue = x * hueScale + offsetY;
      let bri = sin8(Math.trunc((x * seg.speed) / 2) + offsetX);
      // intensity = bri^(sharpness+1) >> 8*sharpness (size_t math, > 32 bits)
      let intensity = Math.floor(bri ** (sharpness + 1) / 2 ** (8 * sharpness));
      seg.setPixelColorXY(
        x,
        y,
        colorFromPalette(palette, hue, intensity, LINEARBLEND),
      );
      hue = y * 3 + offsetX;
      bri = sin8(Math.trunc((y * seg.intensity) / 2) + offsetY);
      intensity = Math.floor(bri ** (sharpness + 1) / 2 ** (8 * sharpness));
      seg.addPixelColorXY(
        x,
        y,
        colorFromPalette(palette, hue, intensity, LINEARBLEND),
      );
    }
  }
}

// --- Spaceships (118) -------------------------------------------------------
function mode2DSpaceships(seg: Segment2D): void {
  if (!seg.is2D()) return fallbackStatic(seg);
  const cols = seg.width;
  const rows = seg.height;

  const tb = seg.now >> 12; // every ~4s
  if (tb > seg.step) {
    let dir = seg.aux0 + 1;
    dir += seg.rng.random8(3) - 1;
    if (dir > 7) seg.aux0 = 0;
    else if (dir < 0) seg.aux0 = 7;
    else seg.aux0 = dir;
    seg.step = tb + seg.rng.random8(4);
  }

  seg.fadeToBlackBy(map(seg.speed, 0, 255, 248, 16));
  seg.move(seg.aux0, 1);

  const palette = seg.getCurrentPalette();
  for (let i = 0; i < 8; i++) {
    const x = beatsin8_t(12 + i, seg.now, 2, cols - 3);
    const y = beatsin8_t(15 + i, seg.now, 2, rows - 3);
    const color = colorFromPalette(
      palette,
      beatsin8_t(12 + i, seg.now, 0, 255),
      255,
    );
    seg.addPixelColorXY(x, y, color);
    if (cols > 24 || rows > 24) {
      seg.addPixelColorXY(x + 1, y, color);
      seg.addPixelColorXY(x - 1, y, color);
      seg.addPixelColorXY(x, y + 1, color);
      seg.addPixelColorXY(x, y - 1, color);
    }
  }
  seg.blur(seg.intensity >> 3, seg.check1);
}

// --- Crazy Bees (119) -------------------------------------------------------
const MAX_BEES = 5;
interface Bee {
  posX: number;
  posY: number;
  aimX: number;
  aimY: number;
  hue: number;
  deltaX: number;
  deltaY: number;
  signX: number;
  signY: number;
  error: number;
}
const BEES_STATE = new WeakMap<Segment, Bee[]>();

function beeAimed(bee: Bee, seg: Segment2D, w: number, h: number): void {
  bee.aimX = seg.rng.random8(0, w);
  bee.aimY = seg.rng.random8(0, h);
  bee.hue = seg.rng.random8();
  bee.deltaX = Math.abs(bee.aimX - bee.posX);
  bee.deltaY = Math.abs(bee.aimY - bee.posY);
  bee.signX = bee.posX < bee.aimX ? 1 : -1;
  bee.signY = bee.posY < bee.aimY ? 1 : -1;
  bee.error = bee.deltaX - bee.deltaY;
}

function mode2DCrazyBees(seg: Segment2D): void {
  if (!seg.is2D()) return fallbackStatic(seg);
  const cols = seg.width;
  const rows = seg.height;

  const n = Math.min(MAX_BEES, Math.trunc((rows * cols) / 256) + 1);

  let bees = BEES_STATE.get(seg);
  if (!bees || seg.call === 0) {
    bees = Array.from({ length: MAX_BEES }, () => ({
      posX: 0,
      posY: 0,
      aimX: 0,
      aimY: 0,
      hue: 0,
      deltaX: 0,
      deltaY: 0,
      signX: 1,
      signY: 1,
      error: 0,
    }));
    for (let i = 0; i < n; i++) {
      bees[i].posX = seg.rng.random8(0, cols);
      bees[i].posY = seg.rng.random8(0, rows);
      beeAimed(bees[i], seg, cols, rows);
    }
    BEES_STATE.set(seg, bees);
  }

  if (seg.now > seg.step) {
    seg.step = seg.now + Math.trunc((FRAMETIME * 16) / ((seg.speed >> 4) + 1));
    seg.fadeToBlackBy(
      32 + Math.trunc(((seg.check1 ? 1 : 0) * seg.intensity) / 25),
    );
    seg.blur(
      Math.trunc(seg.intensity / (2 + (seg.check1 ? 9 : 0))),
      seg.check1,
    );
    for (let i = 0; i < n; i++) {
      const bee = bees[i];
      const flowerColor = seg.color_from_palette(bee.hue, false, true, 255);
      seg.addPixelColorXY(bee.aimX + 1, bee.aimY, flowerColor);
      seg.addPixelColorXY(bee.aimX, bee.aimY + 1, flowerColor);
      seg.addPixelColorXY(bee.aimX - 1, bee.aimY, flowerColor);
      seg.addPixelColorXY(bee.aimX, bee.aimY - 1, flowerColor);
      if (bee.posX !== bee.aimX || bee.posY !== bee.aimY) {
        seg.setPixelColorXY(
          bee.posX,
          bee.posY,
          hsv2rgb_rainbow(bee.hue << 8, 60, 255),
        );
        const error2 = bee.error * 2;
        if (error2 > -bee.deltaY) {
          bee.error -= bee.deltaY;
          bee.posX = (bee.posX + bee.signX) & 0xff;
        }
        if (error2 < bee.deltaX) {
          bee.error += bee.deltaX;
          bee.posY = (bee.posY + bee.signY) & 0xff;
        }
      } else {
        beeAimed(bee, seg, cols, rows);
      }
    }
  }
}

// --- Ghost Rider (120) ------------------------------------------------------
const LIGHTERS_AM = 64;
interface GhostRiderState {
  gPosX: number;
  gPosY: number;
  gAngle: number;
  angleSpeed: number;
  Vspeed: number;
  lightersPosX: Uint16Array;
  lightersPosY: Uint16Array;
  angle: Uint16Array;
  time: Uint16Array;
  reg: Uint8Array;
}
const GHOST_RIDER_STATE = new WeakMap<Segment, GhostRiderState>();

function mode2DGhostRider(seg: Segment2D): void {
  if (!seg.is2D()) return fallbackStatic(seg);
  const cols = seg.width;
  const rows = seg.height;

  const maxLighters = Math.min(cols + rows, LIGHTERS_AM);
  const radians = (deg: number): number => (deg * Math.PI) / 180;

  let st = GHOST_RIDER_STATE.get(seg);
  if (!st || seg.aux0 !== cols || seg.aux1 !== rows) {
    seg.aux0 = cols;
    seg.aux1 = rows;
    st = {
      gPosX: (cols >> 1) * 10,
      gPosY: (rows >> 1) * 10,
      gAngle: seg.rng.random16(),
      angleSpeed: seg.rng.random8(0, 20) - 10,
      Vspeed: 5,
      lightersPosX: new Uint16Array(LIGHTERS_AM),
      lightersPosY: new Uint16Array(LIGHTERS_AM),
      angle: new Uint16Array(LIGHTERS_AM),
      time: new Uint16Array(LIGHTERS_AM),
      reg: new Uint8Array(LIGHTERS_AM),
    };
    for (let i = 0; i < maxLighters; i++) {
      st.lightersPosX[i] = st.gPosX;
      st.lightersPosY[i] = st.gPosY + i;
      st.time[i] = i * 2;
    }
    GHOST_RIDER_STATE.set(seg, st);
  }

  if (seg.now > seg.step) {
    seg.step = seg.now + Math.trunc(1024 / (cols + rows));

    seg.fadeToBlackBy((seg.speed >> 2) + 64);

    seg.wu_pixel(
      Math.trunc((st.gPosX * 256) / 10),
      Math.trunc((st.gPosY * 256) / 10),
      WHITE,
    );

    // int16_t gPosX/gPosY upstream: `+=` converts the whole sum, so the
    // truncation is on the sum, not on the product.
    st.gPosX =
      Math.trunc(st.gPosX + st.Vspeed * sin_approx(radians(st.gAngle))) | 0;
    st.gPosY =
      Math.trunc(st.gPosY + st.Vspeed * cos_approx(radians(st.gAngle))) | 0;
    st.gAngle = (st.gAngle + st.angleSpeed) & 0xffff;
    if (st.gPosX < 0) st.gPosX = (cols - 1) * 10;
    if (st.gPosX > (cols - 1) * 10) st.gPosX = 0;
    if (st.gPosY < 0) st.gPosY = (rows - 1) * 10;
    if (st.gPosY > (rows - 1) * 10) st.gPosY = 0;

    const palette = seg.getCurrentPalette();
    for (let i = 0; i < maxLighters; i++) {
      st.time[i] += seg.rng.random8(5, 20);
      if (
        st.time[i] >= 255 ||
        st.lightersPosX[i] <= 0 ||
        st.lightersPosX[i] >= (cols - 1) * 10 ||
        st.lightersPosY[i] <= 0 ||
        st.lightersPosY[i] >= (rows - 1) * 10
      ) {
        st.reg[i] = 1;
      }
      if (st.reg[i]) {
        st.lightersPosY[i] = st.gPosY;
        st.lightersPosX[i] = st.gPosX;
        st.angle[i] = (st.gAngle + (seg.rng.random8(20) - 10)) & 0xffff;
        st.time[i] = 0;
        st.reg[i] = 0;
      } else {
        // uint16 wrap on purpose: leaving the frame re-registers the lighter.
        // The Uint16Array store truncates the sum, matching the uint16_t `+=`.
        st.lightersPosX[i] += -7 * sin_approx(radians(st.angle[i]));
        st.lightersPosY[i] += -7 * cos_approx(radians(st.angle[i]));
      }
      seg.wu_pixel(
        Math.trunc((st.lightersPosX[i] * 256) / 10),
        Math.trunc((st.lightersPosY[i] * 256) / 10),
        colorFromPalette(palette, 256 - st.time[i]),
      );
    }
    seg.blur(seg.intensity >> 3);
  }
}

// --- Blobs (121) ------------------------------------------------------------
const MAX_BLOBS = 8;
interface BlobState {
  x: Float64Array;
  y: Float64Array;
  sX: Float64Array;
  sY: Float64Array;
  r: Float64Array;
  grow: Uint8Array;
  color: Uint8Array;
}
const BLOBS_STATE = new WeakMap<Segment, BlobState>();

function mode2DFloatingBlobs(seg: Segment2D): void {
  if (!seg.is2D()) return fallbackStatic(seg);
  const cols = seg.width;
  const rows = seg.height;

  const amount = (seg.intensity >> 5) + 1;

  let blob = BLOBS_STATE.get(seg);
  if (!blob || seg.aux0 !== cols || seg.aux1 !== rows) {
    seg.aux0 = cols;
    seg.aux1 = rows;
    blob = {
      x: new Float64Array(MAX_BLOBS),
      y: new Float64Array(MAX_BLOBS),
      sX: new Float64Array(MAX_BLOBS),
      sY: new Float64Array(MAX_BLOBS),
      r: new Float64Array(MAX_BLOBS),
      grow: new Uint8Array(MAX_BLOBS),
      color: new Uint8Array(MAX_BLOBS),
    };
    for (let i = 0; i < MAX_BLOBS; i++) {
      blob.r[i] = seg.rng.random8(1, cols > 8 ? Math.trunc(cols / 4) : 2);
      blob.sX[i] = seg.rng.random8(3, cols) / (256 - seg.speed);
      blob.sY[i] = seg.rng.random8(3, rows) / (256 - seg.speed);
      blob.x[i] = seg.rng.random8(0, cols - 1);
      blob.y[i] = seg.rng.random8(0, rows - 1);
      blob.color[i] = seg.rng.random8();
      blob.grow[i] = blob.r[i] < 1 ? 1 : 0;
      if (blob.sX[i] === 0) blob.sX[i] = 1;
      if (blob.sY[i] === 0) blob.sY[i] = 1;
    }
    BLOBS_STATE.set(seg, blob);
  }

  seg.fadeToBlackBy((seg.custom2 >> 3) + 1);

  for (let i = 0; i < amount; i++) {
    if (seg.step < seg.now) blob.color[i] += 4; // slowly change color
    const maxSpeed = Math.max(Math.abs(blob.sX[i]), Math.abs(blob.sY[i]));
    if (blob.grow[i]) {
      blob.r[i] += maxSpeed * 0.05;
      if (blob.r[i] >= Math.min(cols / 4, 2)) blob.grow[i] = 0;
    } else {
      blob.r[i] -= maxSpeed * 0.05;
      if (blob.r[i] < 1) blob.grow[i] = 1;
    }
    const c = seg.color_from_palette(blob.color[i], false, false, 0);
    if (blob.r[i] > 1)
      seg.fillCircle(
        Math.round(blob.x[i]),
        Math.round(blob.y[i]),
        Math.round(blob.r[i]),
        c,
      );
    else seg.setPixelColorXY(Math.round(blob.x[i]), Math.round(blob.y[i]), c);
    // move x
    if (blob.x[i] + blob.r[i] >= cols - 1)
      blob.x[i] += blob.sX[i] * ((cols - 1 - blob.x[i]) / blob.r[i] + 0.005);
    else if (blob.x[i] - blob.r[i] <= 0)
      blob.x[i] += blob.sX[i] * (blob.x[i] / blob.r[i] + 0.005);
    else blob.x[i] += blob.sX[i];
    // move y
    if (blob.y[i] + blob.r[i] >= rows - 1)
      blob.y[i] += blob.sY[i] * ((rows - 1 - blob.y[i]) / blob.r[i] + 0.005);
    else if (blob.y[i] - blob.r[i] <= 0)
      blob.y[i] += blob.sY[i] * (blob.y[i] / blob.r[i] + 0.005);
    else blob.y[i] += blob.sY[i];
    // bounce x
    if (blob.x[i] < 0.01) {
      blob.sX[i] = seg.rng.random8(3, cols) / (256 - seg.speed);
      blob.x[i] = 0.01;
    } else if (blob.x[i] > cols - 1.01) {
      blob.sX[i] = seg.rng.random8(3, cols) / (256 - seg.speed);
      blob.sX[i] = -blob.sX[i];
      blob.x[i] = cols - 1.01;
    }
    // bounce y
    if (blob.y[i] < 0.01) {
      blob.sY[i] = seg.rng.random8(3, rows) / (256 - seg.speed);
      blob.y[i] = 0.01;
    } else if (blob.y[i] > rows - 1.01) {
      blob.sY[i] = seg.rng.random8(3, rows) / (256 - seg.speed);
      blob.sY[i] = -blob.sY[i];
      blob.y[i] = rows - 1.01;
    }
  }
  seg.blur(seg.custom1 >> 2);

  if (seg.step < seg.now) seg.step = seg.now + 2000; // change colors every 2s
}

// --- Drift Rose (123) -------------------------------------------------------
function mode2DDriftRose(seg: Segment2D): void {
  if (!seg.is2D()) return fallbackStatic(seg);
  const cols = seg.width;
  const rows = seg.height;

  const CX = (cols - (cols % 2)) / 2 - 0.5;
  const CY = (rows - (rows % 2)) / 2 - 0.5;
  const L = Math.min(cols, rows) / 2;

  seg.fadeToBlackBy(32 + (seg.speed >> 3));
  const palette = seg.getCurrentPalette();
  for (let i = 1; i < 37; i++) {
    const angle = (i * 10 * Math.PI) / 180;
    const x =
      Math.trunc(
        (CX + sin_approx(angle) * (beatsin8_t(i, seg.now, 0, L * 2) - L)) * 255,
      ) >>> 0;
    const y =
      Math.trunc(
        (CY + cos_approx(angle) * (beatsin8_t(i, seg.now, 0, L * 2) - L)) * 255,
      ) >>> 0;
    if (seg.palette === 0)
      seg.wu_pixel(x, y, hsv2rgb_rainbow((i * 10) << 8, 255, 255));
    else seg.wu_pixel(x, y, colorFromPalette(palette, i * 10));
  }
  seg.blur(seg.intensity >> 4, seg.check1);
}

// --- Rotozoomer (114) -------------------------------------------------------
const ROTOZOOM_ANGLE = new WeakMap<Segment, { a: number }>();

function mode2DPlasmaRotozoom(seg: Segment2D): void {
  if (!seg.is2D()) return fallbackStatic(seg);
  const cols = seg.width;
  const rows = seg.height;

  const plasma = seg.allocateData(seg.length);
  let rot = ROTOZOOM_ANGLE.get(seg);
  if (!rot || seg.call === 0) {
    rot = { a: 0 };
    ROTOZOOM_ANGLE.set(seg, rot);
  }

  const ms = Math.trunc(seg.now / 15);

  // plasma
  for (let j = 0; j < rows; j++) {
    const index = j * cols;
    for (let i = 0; i < cols; i++) {
      if (seg.check1)
        plasma[index + i] = (((i * 4) ^ (j * 4)) + Math.trunc(ms / 6)) & 0xff;
      else plasma[index + i] = perlin8(i * 40, j * 40, ms);
    }
  }

  // rotozoom
  const f = (sin_approx(rot.a / 2) + (128 - seg.intensity) / 128 + 1.1) / 1.5;
  const kosinus = cos_approx(rot.a) * f;
  const sinus = sin_approx(rot.a) * f;
  const abs8f = (v: number): number => Math.abs((Math.trunc(v) << 24) >> 24);
  for (let i = 0; i < cols; i++) {
    const u1 = i * kosinus;
    const v1 = i * sinus;
    for (let j = 0; j < rows; j++) {
      const u = abs8f(u1 - j * sinus) % cols;
      const v = abs8f(v1 + j * kosinus) % rows;
      seg.setPixelColorXY(
        i,
        j,
        seg.color_from_palette(plasma[v * cols + u], false, false, 255),
      );
    }
  }
  rot.a -= 0.03 + (seg.speed - 128) * 0.0002; // rotation speed
  if (rot.a < -6283.18530718) rot.a += 6283.18530718; // 1000*2*PI
}

// --- Distortion Waves (124) -------------------------------------------------
/** WLED rgb2hsv (colors.cpp), 8-bit hue only (CHSV32 h>>8). */
function rgb2hsvHue8(r: number, g: number, b: number): number {
  const maxval = Math.max(r, g, b);
  if (maxval === 0) return 0;
  const minval = Math.min(r, g, b);
  const delta = maxval - minval;
  if (delta === 0) return 0;
  let h16: number;
  if (maxval === r) h16 = Math.trunc((10923 * (g - b)) / delta) & 0xffff;
  else if (maxval === g)
    h16 = (21845 + Math.trunc((10923 * (b - r)) / delta)) & 0xffff;
  else h16 = (43690 + Math.trunc((10923 * (r - g)) / delta)) & 0xffff;
  return h16 >> 8;
}

function mode2DDistortionWaves(seg: Segment2D): void {
  if (!seg.is2D()) return fallbackStatic(seg);
  const cols = seg.width;
  const rows = seg.height;

  const speed = Math.trunc(seg.speed / 32);
  let scale = Math.trunc(seg.intensity / 32);
  if (seg.check2) scale += Math.trunc(192 / (cols + rows)); // zoom out some more

  const a = Math.trunc(seg.now / 32);
  const a2 = Math.trunc(a / 2);
  const a3 = Math.trunc(a / 3);
  const colsScaled = cols * scale;
  const rowsScaled = rows * scale;

  const cx = beatsin16_t((10 - speed) & 0xffff, seg.now, 0, colsScaled);
  const cy = beatsin16_t((12 - speed) & 0xffff, seg.now, 0, rowsScaled);
  const cx1 = beatsin16_t((13 - speed) & 0xffff, seg.now, 0, colsScaled);
  const cy1 = beatsin16_t((15 - speed) & 0xffff, seg.now, 0, rowsScaled);
  const cx2 = beatsin16_t((17 - speed) & 0xffff, seg.now, 0, colsScaled);
  const cy2 = beatsin16_t((14 - speed) & 0xffff, seg.now, 0, rowsScaled);

  const palette = seg.getCurrentPalette();
  let xoffs = 0;
  for (let x = 0; x < cols; x++) {
    xoffs += scale;
    let yoffs = 0;
    for (let y = 0; y < rows; y++) {
      yoffs += scale;

      let rdistort: number;
      let gdistort: number;
      let bdistort: number;
      if (seg.check3) {
        // alternate mode from the original code
        rdistort = cos8(((x + y) * 8 + a2) & 255) >> 1;
        gdistort = cos8(((x + y) * 8 + a3 + 32) & 255) >> 1;
        bdistort = cos8(((x + y) * 8 + a + 64) & 255) >> 1;
      } else {
        rdistort =
          cos8(
            (cos8(((x << 3) + a) & 255) + cos8(((y << 3) - a2) & 255) + a3) &
              255,
          ) >> 1;
        gdistort =
          cos8(
            (cos8(((x << 3) - a2) & 255) +
              cos8(((y << 3) + a3) & 255) +
              a +
              32) &
              255,
          ) >> 1;
        bdistort =
          cos8(
            (cos8(((x << 3) + a3) & 255) +
              cos8(((y << 3) - a) & 255) +
              a2 +
              64) &
              255,
          ) >> 1;
      }

      let valueR =
        (rdistort +
          ((a -
            (((xoffs - cx) * (xoffs - cx) + (yoffs - cy) * (yoffs - cy)) >>
              7)) <<
            1)) &
        0xff;
      let valueG =
        (gdistort +
          ((a2 -
            (((xoffs - cx1) * (xoffs - cx1) + (yoffs - cy1) * (yoffs - cy1)) >>
              7)) <<
            1)) &
        0xff;
      let valueB =
        (bdistort +
          ((a3 -
            (((xoffs - cx2) * (xoffs - cx2) + (yoffs - cy2) * (yoffs - cy2)) >>
              7)) <<
            1)) &
        0xff;

      valueR = cos8(valueR);
      valueG = cos8(valueG);
      valueB = cos8(valueB);

      if (seg.palette === 0) {
        seg.setPixelColorXY(x, y, rgbw32(valueR, valueG, valueB, 0));
      } else {
        const brightness = Math.trunc((valueR + valueG + valueB) / 3);
        if (seg.check1) {
          seg.setPixelColorXY(
            x,
            y,
            colorFromPalette(palette, brightness, 255, LINEARBLEND_NOWRAP),
          );
        } else {
          const hue = rgb2hsvHue8(valueR >> 2, valueG >> 2, valueB >> 2);
          seg.setPixelColorXY(x, y, colorFromPalette(palette, hue, brightness));
        }
      }
    }
  }

  // palette mode and not filling: smear-blur covers palette wrap artifacts
  if (!seg.check1 && seg.palette) seg.blur(200, true);
}

// --- Soap (125) -------------------------------------------------------------
interface SoapState {
  noise3d: Uint8Array;
  pixels: Uint32Array;
  noisecoord: [number, number, number];
}
const SOAP_STATE = new WeakMap<Segment, SoapState>();

function soapPixels(
  seg: Segment2D,
  isRow: boolean,
  noise3d: Uint8Array,
  pixels: Uint32Array,
): void {
  const cols = seg.width;
  const rows = seg.height;
  const XY = (x: number, y: number): number => x + y * cols;
  const tRC = isRow ? rows : cols;
  const tCR = isRow ? cols : rows;
  const amplitude = Math.max(1, (tCR - 8) >> 3) * (1 + (seg.custom1 >> 5));
  const palette = seg.getCurrentPalette();

  const scaleChannel = (c: number, s: number): number => (c * (1 + s)) >> 8;
  const ledsbuff = new Uint32Array(tCR);

  for (let i = 0; i < tRC; i++) {
    const amount = (noise3d[isRow ? i * cols : i] - 128) * amplitude;
    const delta = Math.abs(amount) >> 8;
    const fraction = Math.abs(amount) & 255;
    for (let j = 0; j < tCR; j++) {
      let zD: number;
      let zF: number;
      if (amount < 0) {
        zD = j - delta;
        zF = zD - 1;
      } else {
        zD = j + delta;
        zF = zD + 1;
      }
      let yA = Math.abs(zD) % tCR;
      let yB = Math.abs(zF) % tCR;
      let xA = i;
      let xB = i;
      if (isRow) {
        [xA, yA] = [yA, xA];
        [xB, yB] = [yB, xB];
      }
      const indxA = XY(xA, yA);
      const indxB = XY(xB, yB);
      const pixelA =
        zD >= 0 && zD < tCR
          ? pixels[indxA]
          : colorFromPalette(palette, ((~noise3d[indxA] & 0xff) * 3) & 0xff);
      const pixelB =
        zF >= 0 && zF < tCR
          ? pixels[indxB]
          : colorFromPalette(palette, ((~noise3d[indxB] & 0xff) * 3) & 0xff);
      const eA = ease8InOutCubic(255 - fraction);
      const eB = ease8InOutCubic(fraction);
      const r = qadd8(scaleChannel(R(pixelA), eA), scaleChannel(R(pixelB), eB));
      const g = qadd8(scaleChannel(G(pixelA), eA), scaleChannel(G(pixelB), eB));
      const b = qadd8(scaleChannel(B(pixelA), eA), scaleChannel(B(pixelB), eB));
      ledsbuff[j] = ((r << 16) | (g << 8) | b) >>> 0;
    }
    for (let j = 0; j < tCR; j++) {
      const c = ledsbuff[j];
      const px = isRow ? j : i;
      const py = isRow ? i : j;
      pixels[XY(px, py)] = c;
      seg.setPixelColorXY(px, py, c);
    }
  }
}

function mode2DSoap(seg: Segment2D): void {
  if (!seg.is2D()) return fallbackStatic(seg);
  const cols = seg.width;
  const rows = seg.height;
  const XY = (x: number, y: number): number => x + y * cols;

  const segSize = cols * rows;
  let st = SOAP_STATE.get(seg);
  const fresh = !st || st.noise3d.length !== segSize;
  if (fresh) {
    st = {
      noise3d: new Uint8Array(segSize),
      pixels: new Uint32Array(segSize),
      noisecoord: [
        seg.rng.random16() * 65536 + seg.rng.random16(),
        seg.rng.random16() * 65536 + seg.rng.random16(),
        seg.rng.random16() * 65536 + seg.rng.random16(),
      ],
    };
    SOAP_STATE.set(seg, st);
  }
  const { noise3d, pixels, noisecoord } = st!;

  const scale32x = Math.trunc(160000 / cols);
  const scale32y = Math.trunc(160000 / rows);
  const mov = Math.trunc((Math.min(cols, rows) * (seg.speed + 2)) / 2);
  const smoothness = Math.min(250, seg.intensity);

  if (!fresh) {
    for (let i = 0; i < 3; i++) noisecoord[i] = (noisecoord[i] + mov) >>> 0;
  }

  for (let i = 0; i < cols; i++) {
    const ioffset = scale32x * (i - Math.trunc(cols / 2));
    for (let j = 0; j < rows; j++) {
      const joffset = scale32y * (j - Math.trunc(rows / 2));
      const data =
        inoise16(
          (noisecoord[0] + ioffset) >>> 0,
          (noisecoord[1] + joffset) >>> 0,
          noisecoord[2],
        ) >> 8;
      noise3d[XY(i, j)] =
        scale8(noise3d[XY(i, j)], smoothness) + scale8(data, 255 - smoothness);
    }
  }

  // init also if dimensions changed
  if (fresh || seg.aux0 !== cols || seg.aux1 !== rows) {
    seg.aux0 = cols;
    seg.aux1 = rows;
    const palette = seg.getCurrentPalette();
    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < rows; j++) {
        const c = colorFromPalette(
          palette,
          ((~noise3d[XY(i, j)] & 0xff) * 3) & 0xff,
        );
        pixels[XY(i, j)] = c;
        seg.setPixelColorXY(i, j, c);
      }
    }
  }

  soapPixels(seg, true, noise3d, pixels); // rows
  soapPixels(seg, false, noise3d, pixels); // cols
}

// --- Octopus (126) ----------------------------------------------------------
interface OctopusState {
  angle: Uint8Array;
  radius: Uint8Array;
  offsX: number;
  offsY: number;
}
const OCTOPUS_STATE = new WeakMap<Segment, OctopusState>();

function mode2DOctopus(seg: Segment2D): void {
  if (!seg.is2D()) return fallbackStatic(seg);
  const cols = seg.width;
  const rows = seg.height;
  const XY = (x: number, y: number): number => (x % cols) + (y % rows) * cols;
  const mapp = Math.trunc(180 / Math.max(cols, rows));

  let st = OCTOPUS_STATE.get(seg);
  if (
    !st ||
    seg.call === 0 ||
    seg.aux0 !== cols ||
    seg.aux1 !== rows ||
    seg.custom1 !== st.offsX ||
    seg.custom2 !== st.offsY
  ) {
    seg.step = 0; // t
    seg.aux0 = cols;
    seg.aux1 = rows;
    st = {
      angle: new Uint8Array(cols * rows),
      radius: new Uint8Array(cols * rows),
      offsX: seg.custom1,
      offsY: seg.custom2,
    };
    const cX =
      Math.trunc(cols / 2) + Math.trunc(((seg.custom1 - 128) * cols) / 255);
    const cY =
      Math.trunc(rows / 2) + Math.trunc(((seg.custom2 - 128) * rows) / 255);
    for (let x = 0; x < cols; x++) {
      for (let y = 0; y < rows; y++) {
        const dx = x - cX;
        const dy = y - cY;
        st.angle[XY(x, y)] = Math.trunc(40.7436 * Math.atan2(dy, dx)) & 0xff;
        st.radius[XY(x, y)] =
          Math.trunc(Math.sqrt(dx * dx + dy * dy) * mapp) & 0xff;
      }
    }
    OCTOPUS_STATE.set(seg, st);
  }

  seg.step += Math.trunc(seg.speed / 32) + 1; // 1-4 range
  const palette = seg.getCurrentPalette();
  for (let x = 0; x < cols; x++) {
    for (let y = 0; y < rows; y++) {
      const angle = st.angle[XY(x, y)];
      const radius = st.radius[XY(x, y)];
      let intensity = sin8(
        sin8(Math.trunc((angle * 4 - radius) / 4) + Math.trunc(seg.step / 2)) +
          radius -
          seg.step +
          angle * (Math.trunc(seg.custom3 / 4) + 1),
      );
      intensity = map((intensity * intensity) & 0xffff, 0, 65535, 0, 255);
      seg.setPixelColorXY(
        x,
        y,
        colorFromPalette(palette, Math.trunc(seg.step / 2) - radius, intensity),
      );
    }
  }
}

// --- Waving Cell (127) ------------------------------------------------------
function mode2DWavingCell(seg: Segment2D): void {
  if (!seg.is2D()) return fallbackStatic(seg);
  const cols = seg.width;
  const rows = seg.height;

  const t = (seg.now * (seg.speed + 1)) >>> 3; // uint32 wrap + shift
  const aX = Math.trunc(seg.custom1 / 16) + 9;
  const aY = Math.trunc(seg.custom2 / 16) + 1;
  const aZ = seg.custom3 + 1;
  const palette = seg.getCurrentPalette();
  for (let x = 0; x < cols; x++) {
    for (let y = 0; y < rows; y++) {
      const wave =
        sin8(x * aX + (Math.imul(((y << 8) + t) | 0, aY) >>> 8)) + cos8(y * aZ);
      const colorIndex = (wave + (t >>> (8 - (seg.check2 ? 3 : 0)))) & 0xff;
      seg.setPixelColorXY(x, y, colorFromPalette(palette, colorIndex));
    }
  }
  seg.blur(seg.intensity);
}

// --- Hiphotic (180) ---------------------------------------------------------
function mode2DHiphotic(seg: Segment2D): void {
  if (!seg.is2D()) return fallbackStatic(seg);
  const cols = seg.width;
  const rows = seg.height;
  const a = Math.trunc(seg.now / ((seg.custom3 >> 1) + 1));

  for (let x = 0; x < cols; x++) {
    for (let y = 0; y < rows; y++) {
      const idx = sin8(
        cos8(Math.trunc((x * seg.speed) / 16) + Math.trunc(a / 3)) +
          sin8(Math.trunc((y * seg.intensity) / 16) + Math.trunc(a / 4)) +
          a,
      );
      seg.setPixelColorXY(x, y, seg.color_from_palette(idx, false, false, 0));
    }
  }
}

// --- Game Of Life (172) -----------------------------------------------------
// The firmware packs per-cell state into bitfield Cell structs in SEGENV.data;
// here it's parallel byte arrays in a WeakMap (auto-cleared when the sim
// resets, since reset() builds a fresh Segment).
interface GolState {
  alive: Uint8Array;
  faded: Uint8Array;
  toggle: Uint8Array;
  osc: Uint8Array;
  ship: Uint8Array;
  edge: Uint8Array;
}
const GOL_STATE = new WeakMap<Segment, GolState>();

function mode2DGameOfLife(seg: Segment2D): void {
  if (!seg.is2D()) return fallbackStatic(seg);
  const cols = seg.width;
  const rows = seg.height;
  const maxIndex = cols * rows;

  let st = GOL_STATE.get(seg);
  if (!st || st.alive.length !== maxIndex) {
    st = {
      alive: new Uint8Array(maxIndex),
      faded: new Uint8Array(maxIndex),
      toggle: new Uint8Array(maxIndex),
      osc: new Uint8Array(maxIndex),
      ship: new Uint8Array(maxIndex),
      edge: new Uint8Array(maxIndex),
    };
    GOL_STATE.set(seg, st);
  }

  let generation = seg.aux0;
  let gliderLength = seg.aux1;
  const mutate = seg.check3;
  const blur = map(seg.custom1, 0, 255, 255, 4);

  const bgColor = seg.color(1);
  let birthColor = seg.color_from_palette(128, false, false, 255);

  const setup = seg.call === 0;
  if (setup) {
    // glider length LCM(rows,cols)*4, computed once
    let a = rows;
    let b = cols;
    while (b) {
      const t = b;
      b = a % b;
      a = t;
    }
    gliderLength = Math.trunc((cols * rows) / a) << 2;
  }

  if (Math.abs(seg.now - seg.step) > 2000) seg.step = 0; // timebase jump fix
  let paused = seg.step > seg.now;

  // Setup new Game of Life
  if ((!paused && generation === 0) || setup) {
    seg.step = seg.now + 1280; // show initial state for 1.28 seconds
    generation = 1;
    paused = true;
    st.alive.fill(0);
    st.faded.fill(0);
    st.toggle.fill(0);
    st.osc.fill(0);
    st.ship.fill(0);

    for (let i = 0; i < maxIndex; i++) {
      const isAlive = seg.rng.random8(3) === 0; // ~33%
      st.alive[i] = isAlive ? 1 : 0;
      st.faded[i] = isAlive ? 0 : 1;
      const x = i % cols;
      const y = Math.trunc(i / cols);
      st.edge[i] =
        x === 0 || x === cols - 1 || y === 0 || y === rows - 1 ? 1 : 0;

      seg.setPixelColor(
        i,
        isAlive
          ? seg.color_from_palette(seg.rng.random8(), false, false, 0)
          : bgColor,
      );
    }
  }
  seg.aux1 = gliderLength;

  if (
    paused ||
    seg.now - seg.step < Math.trunc(1000 / map(seg.speed, 0, 255, 1, 42))
  ) {
    // redraw if paused or between updates, to remove blur
    for (let i = maxIndex; i--;) {
      if (!st.alive[i]) {
        const cellColor = seg.getPixelColor(i);
        if (cellColor !== bgColor) {
          if (st.faded[i]) {
            seg.setPixelColor(i, bgColor);
          } else {
            let blended = color_blend(cellColor, bgColor, 2);
            if (blended === cellColor) {
              blended = bgColor;
              st.faded[i] = 1;
            }
            seg.setPixelColor(i, blended);
          }
        }
      }
    }
    seg.aux0 = generation;
    return;
  }

  // repeat detection
  const updateOscillator = generation % 16 === 0;
  const updateSpaceship = gliderLength !== 0 && generation % gliderLength === 0;
  let repeatingOscillator = true;
  let repeatingSpaceship = true;
  let emptyGrid = true;

  const parentIdx = [0, 0, 0];
  let cIndex = maxIndex - 1;
  for (let y = rows; y--;) {
    for (let x = cols; x--; cIndex--) {
      const alive = st.alive[cIndex];

      if (alive) emptyGrid = false;
      if (st.osc[cIndex] !== alive) repeatingOscillator = false;
      if (st.ship[cIndex] !== alive) repeatingSpaceship = false;
      if (updateOscillator) st.osc[cIndex] = alive;
      if (updateSpaceship) st.ship[cIndex] = alive;

      let neighbors = 0;
      let aliveParents = 0;
      for (let i = -1; i <= 1; i++) {
        for (let j = -1; j <= 1; j++) {
          if (!i && !j) continue;
          let nX = x + j;
          let nY = y + i;
          if (st.edge[cIndex]) {
            nX = (nX + cols) % cols;
            nY = (nY + rows) % rows;
          }
          const nIndex = nX + nY * cols;
          if (st.alive[nIndex]) {
            neighbors++;
            if (!st.toggle[nIndex] && neighbors < 4) {
              // alive and not dying
              parentIdx[aliveParents++] = nIndex;
            }
          }
        }
      }

      if (alive && (neighbors < 2 || neighbors > 3)) {
        // loneliness or overpopulation
        st.toggle[cIndex] = 1;
        if (blur === 255) st.faded[cIndex] = 1;
        seg.setPixelColor(
          cIndex,
          st.faded[cIndex]
            ? bgColor
            : color_blend(seg.getPixelColor(cIndex), bgColor, blur),
        );
      } else if (!alive) {
        const mutationRoll = mutate ? seg.rng.random8(128) : 1;
        if (
          (neighbors === 3 && mutationRoll !== 0) ||
          (mutate && neighbors === 2 && mutationRoll === 0)
        ) {
          // reproduction or mutation
          st.toggle[cIndex] = 1;
          st.faded[cIndex] = 0;
          if (aliveParents) {
            // color based on a random parent
            birthColor = seg.getPixelColor(
              parentIdx[seg.rng.random8(aliveParents)],
            );
          }
          seg.setPixelColor(cIndex, birthColor);
        } else if (!st.faded[cIndex]) {
          // no change; fade dead cells
          const cellColor = seg.getPixelColor(cIndex);
          let blended = color_blend(cellColor, bgColor, blur);
          if (blended === cellColor) {
            blended = bgColor;
            st.faded[cIndex] = 1;
          }
          seg.setPixelColor(cIndex, blended);
        }
      }
    }
  }

  // swap alive status where toggled
  for (let i = maxIndex; i--;) {
    st.alive[i] ^= st.toggle[i];
    st.toggle[i] = 0;
  }

  if (repeatingOscillator || repeatingSpaceship || emptyGrid) {
    generation = 0; // reset on next call
    seg.step += 1024; // pause final generation for ~1 second
  } else {
    ++generation;
    seg.step = seg.now;
  }
  seg.aux0 = generation;
}

// --- PS Fire (188) ----------------------------------------------------------
// int8 coercion for particle-velocity writes outside the engine (the engine's
// own s8 is private; effects that poke particles directly need it too).
const s8_2d = (v: number): number => (v << 24) >> 24;
const s16 = (v: number): number => (v << 16) >> 16;

// frame-skip timestamp (firmware keeps it in 4 additionalbytes past the PS)
const FIRE_LASTCALL = new WeakMap<Segment, { v: number }>();

function modeParticleFire2D(seg: Segment2D): void {
  if (!seg.is2D()) return fallbackStatic(seg);
  let ps: ParticleSystem2D | null;
  if (seg.call === 0) {
    ps = initParticleSystem2D(seg, seg.width); // one source per column, engine limits
    if (!ps) return fallbackStatic(seg);
    seg.aux0 = seg.rng.random16(); // wind position in the perlin noise
    FIRE_LASTCALL.set(seg, { v: 0 });
  } else {
    ps = getParticleSystem2D(seg);
  }
  if (!ps) return fallbackStatic(seg);

  ps.updateSystem();
  ps.setWrapX(seg.check2);
  ps.setMotionBlur(seg.check1 ? 170 : 0);
  ps.setSmearBlur(seg.check1 ? 0 : 60);

  const firespeed = Math.max(100, seg.speed);
  if (seg.speed < 100) {
    // slow: limit update rate (90FPS-20FPS), skipping frames
    const lastcall = FIRE_LASTCALL.get(seg) ?? { v: 0 };
    const period = seg.now - lastcall.v;
    if (period < map(seg.speed, 0, 99, 50, 10)) {
      seg.call--; // skipped frame: keep the counter in step
      return;
    }
    lastcall.v = seg.now;
    FIRE_LASTCALL.set(seg, lastcall);
  }

  const spread = (ps.maxX >> 5) * (seg.custom3 + 1); // fire width around center
  const numFlames = Math.min(
    ps.numSources,
    4 + (Math.trunc(spread / PS_P_RADIUS) << 1),
  );
  const percycle = Math.trunc((numFlames * 2) / 3);

  // update the flame sprays
  for (let i = 0; i < numFlames; i++) {
    const src = ps.sources[i];
    if (seg.call & 1 && src.source.ttl > 0) {
      src.source.ttl--; // every second frame
    } else {
      // dead flame: re-seed its properties
      src.source.x =
        (ps.maxX >> 1) - (spread >> 1) + seg.rng.random16(Math.max(1, spread));
      src.source.y = -(PS_P_RADIUS << 2); // below the frame
      src.source.ttl =
        20 +
        Math.trunc(
          seg.rng.random16((seg.custom1 * seg.custom1) >> 8) /
            (1 + (firespeed >> 5)),
        );
      src.maxLife = seg.rng.random16(seg.height >> 1) + 16;
      src.minLife = src.maxLife >> 1;
      src.vx = seg.rng.random16(5) - 2; // sideways
      src.vy = (seg.height >> 1) + (firespeed >> 4) + (seg.custom1 >> 4); // upwards
      src.var = 2 + seg.rng.random16(2 + (firespeed >> 4));
    }
  }

  if (seg.call % 3 === 0) {
    // update noise position and add wind
    seg.aux0 = (seg.aux0 + 1) & 0xffff;
    if (seg.call % 10 === 0) seg.aux1 = (seg.aux1 + 1) & 0xffff;
    const windspeed = s8_2d(
      ((perlin8(seg.aux0, seg.aux1) - 127) * seg.custom2) >> 7,
    );
    ps.applyForce(windspeed, 0);
  }
  seg.step++;

  if (seg.check3) {
    // turbulence in the bottom quarter
    if (seg.call % map(firespeed, 0, 255, 4, 15) === 0) {
      for (let i = 0; i < ps.usedParticles; i++) {
        const p = ps.particles[i];
        if (p.y < Math.trunc(ps.maxY / 4)) {
          const curl = perlin8(p.x, p.y, (seg.step << 4) & 0xffff) - 127;
          p.vx = s8_2d(p.vx + ((curl * (firespeed + 10)) >> 9));
        }
      }
    }
  }

  // emit faster sparks at the first flame position
  if (seg.rng.random8() < 10 + (seg.intensity >> 2)) {
    for (let i = 0; i < ps.usedParticles; i++) {
      const p = ps.particles[i];
      if (p.ttl === 0) {
        p.ttl = seg.rng.random16(seg.height) + 30;
        p.x = ps.sources[0].source.x;
        p.y = ps.sources[0].source.y;
        p.vx = ps.sources[0].source.vx;
        p.vy = s8_2d(
          (seg.height >> 1) +
            (firespeed >> 4) +
            ((30 + (seg.intensity >> 1) + seg.custom1) >> 4),
        );
        break; // one spark per frame
      }
    }
  }

  let j = seg.rng.random16() & 0xff; // start at a random flame
  for (let i = 0; i < percycle; i++) {
    j = (j + 1) % numFlames;
    ps.flameEmit(ps.sources[j]);
  }

  ps.updateFire(seg.intensity);
}

// --- PS Vortex (190) --------------------------------------------------------
function modeParticleVortex(seg: Segment2D): void {
  if (!seg.is2D()) return fallbackStatic(seg);
  let ps: ParticleSystem2D | null;
  if (seg.call === 0) {
    ps = initParticleSystem2D(seg, 8);
    if (!ps) return fallbackStatic(seg);
    ps.setMotionBlur(130);
    for (let i = 0; i < Math.min(ps.numSources, 8); i++) {
      ps.sources[i].source.x = (ps.maxX + 1) >> 1; // center
      ps.sources[i].source.y = (ps.maxY + 1) >> 1;
      ps.sources[i].maxLife = 900;
      ps.sources[i].minLife = 800;
    }
    ps.setKillOutOfBounds(true);
  } else {
    ps = getParticleSystem2D(seg);
  }
  if (!ps) return fallbackStatic(seg);

  ps.updateSystem();
  const spraycount = Math.min(ps.numSources, 1 + (seg.custom1 >> 5));
  ps.setSmearBlur(seg.check1 ? 90 : 0);

  // spray colors, evenly offset
  for (let i = 0; i < spraycount; i++) {
    ps.sources[i].source.hue = (Math.trunc(0xff / spraycount) * i) & 0xff;
  }

  // rotation direction and speed (step doubles as the signed current speed)
  let direction = seg.check2;
  let currentspeed = seg.step | 0;

  if (seg.custom2 > 0) {
    // automatic direction change
    let changeinterval = 1040 - (seg.custom2 << 2);
    direction = (seg.aux1 & 0x01) !== 0;
    if (seg.check3)
      changeinterval = 20 + changeinterval + seg.rng.random16(changeinterval);
    if (seg.call % changeinterval === 0) {
      seg.aux1 |= 0x02;
      if (direction) seg.aux1 &= ~0x01;
      else seg.aux1 |= 0x01;
    }
  }

  const targetspeed = (direction ? 1 : -1) * (seg.speed << 3);
  const speeddiff = targetspeed - currentspeed;
  let speedincrement = Math.trunc(speeddiff / 50);
  if (speedincrement === 0) {
    if (speeddiff < 0) speedincrement = -1;
    else if (speeddiff > 0) speedincrement = 1;
  }
  currentspeed += speedincrement;
  seg.aux0 = (seg.aux0 + currentspeed) & 0xffff;
  seg.step = currentspeed;

  const angleoffset = Math.trunc(0xffff / spraycount);
  const skip = Math.trunc(PS_P_HALFRADIUS_2D / (seg.intensity + 1)) + 1;
  if (seg.call % skip === 0) {
    let j = seg.rng.random16(spraycount);
    for (let i = 0; i < spraycount; i++) {
      ps.sources[j].var = seg.custom3 >> 1;
      ps.angleEmit(
        ps.sources[j],
        (seg.aux0 + angleoffset * j) & 0xffff,
        (seg.intensity >> 2) + 1,
      );
      j = (j + 1) % spraycount;
    }
  }
  ps.update();
}

// --- PS Fireworks (189) -----------------------------------------------------
function modeParticleFireworks2D(seg: Segment2D): void {
  if (!seg.is2D()) return fallbackStatic(seg);
  let ps: ParticleSystem2D | null;
  if (seg.call === 0) {
    ps = initParticleSystem2D(seg, 8);
    if (!ps) return fallbackStatic(seg);
    ps.setKillOutOfBounds(true);
    ps.setWallHardness(120); // ground bounce is fixed
    const numRockets = Math.min(ps.numSources, 8);
    for (let j = 0; j < numRockets; j++) {
      ps.sources[j].source.ttl = 500 * j; // stagger launches
      ps.sources[j].source.vy = -1; // negative = standby, will relaunch
    }
  } else {
    ps = getParticleSystem2D(seg);
  }
  if (!ps) return fallbackStatic(seg);

  ps.updateSystem();
  const numRockets = map(seg.speed, 0, 255, 4, Math.min(ps.numSources, 8));

  ps.setWrapX(seg.check1);
  ps.setBounceY(seg.check2);
  ps.setGravity(map(seg.custom3, 0, 31, seg.check2 ? 1 : 0, 10));
  ps.setMotionBlur(map(seg.custom2, 0, 255, 0, 245));

  // update the rockets
  for (let j = 0; j < numRockets; j++) {
    const src = ps.sources[j];
    ps.applyGravity(src.source);
    ps.particleMoveUpdate(src.source, src.sourceFlags);
    if (src.source.ttl === 0) {
      if (src.source.vy > 0) {
        src.source.vy = 0; // died moving up: stop -> explodes below
      } else if (src.source.vy < 0) {
        // exploded and standby over: relaunch
        src.source.y = PS_P_RADIUS;
        src.source.x = (ps.maxX >> 2) + seg.rng.random16(ps.maxX >> 1);
        src.source.vy = seg.custom3 + seg.rng.random16(seg.custom1 >> 3) + 5;
        src.source.vx = seg.rng.random16(7) - 3;
        src.source.sat = 30; // exhaust is off-white
        src.source.ttl = seg.rng.random16(seg.custom1) + (seg.custom1 >> 1);
        src.maxLife = 40; // exhaust particle life
        src.minLife = 10;
        src.vx = 0;
        src.vy = -5;
        src.var = 4;
      }
    }
  }

  // emit per rocket state: up = exhaust, stopped = explode, falling = standby
  let circularexplosion = false;
  let speed = 0;
  let currentspeed: number;
  let percircle = 0;
  let angle = 0;
  let baseangle = 0;
  let angleincrement = 0;
  let hueincrement = 0;
  let frequency = 0;
  let counter = 0;

  for (let j = 0; j < numRockets; j++) {
    const src = ps.sources[j];
    let emitparticles: number;
    if (src.source.vy > 0) {
      emitparticles = 1; // exhaust
    } else if (src.source.vy < 0) {
      emitparticles = 0; // standby
    } else {
      // explode!
      src.source.hue = seg.rng.random16() & 0xff;
      src.source.sat = seg.rng.random16(55) + 200;
      src.maxLife = 200;
      src.minLife = 100;
      src.source.ttl =
        seg.rng.random16(2000 - (seg.speed << 2)) + 550 - (seg.speed << 1);
      src.var = (seg.intensity >> 4) + 5;
      src.source.vy = -1; // no more particles until relaunch
      emitparticles =
        seg.rng.random16(seg.intensity >> 2) + (seg.intensity >> 2) + 5;

      if (seg.rng.random16() & 1) {
        // 50% chance for circular explosion
        circularexplosion = true;
        speed = 2 + seg.rng.random16(3) + (seg.intensity >> 6);
        angleincrement = 2730 + seg.rng.random16(5461);
        angle = seg.rng.random16();
        baseangle = angle;
        percircle = Math.trunc(0xffff / angleincrement) + 1;
        hueincrement = seg.rng.random16() & 127;
        const circles = 1 + seg.rng.random16(3) + (seg.intensity >> 6);
        frequency = seg.rng.random16() & 127;
        emitparticles = percircle * circles;
        src.var = angle & 1;
      }
    }
    let i = 0;
    for (; i < emitparticles; i++) {
      if (circularexplosion) {
        const sineMod =
          0xefff + sin16((((angle * frequency) >> 4) + baseangle) & 0xffff);
        currentspeed = (Math.trunc(speed / 2) + ((sineMod * speed) >> 16)) >> 1;
        ps.angleEmit(src, angle & 0xffff, currentspeed);
        counter++;
        if (counter > percircle) {
          counter = 0;
          speed += 3 + (seg.intensity >> 6); // second wave
          src.source.hue = (src.source.hue + hueincrement) & 0xff;
          src.source.sat = 100 + seg.rng.random16(156);
        }
        angle = (angle + angleincrement) & 0xffff;
      } else {
        ps.sprayEmit(src);
        if (j % 3 === 0) src.source.hue = seg.rng.random16() & 0xff;
      }
    }
    if (i === 0) src.source.y = 1000; // falling: keep away from the ground
    circularexplosion = false;
  }
  if (seg.check3) {
    // fast: move particles twice
    for (let i = 0; i < ps.usedParticles; i++) {
      ps.particleMoveUpdate(ps.particles[i], ps.particleFlags[i], null, null);
    }
  }
  ps.update();
}

// --- PS Volcano (187) -------------------------------------------------------
function modeParticleVolcano(seg: Segment2D): void {
  if (!seg.is2D()) return fallbackStatic(seg);
  const volcanosettings = newPSsettings2D();
  volcanosettings.bounceX = true;
  let ps: ParticleSystem2D | null;
  if (seg.call === 0) {
    ps = initParticleSystem2D(seg, 1);
    if (!ps) return fallbackStatic(seg);
    ps.setBounceY(true);
    ps.setGravity(); // default gforce
    ps.setKillOutOfBounds(true);
    ps.setMotionBlur(230);
    const numSprays = Math.min(ps.numSources, 1);
    for (let i = 0; i < numSprays; i++) {
      ps.sources[i].source.hue = seg.rng.random16() & 0xff;
      ps.sources[i].source.x = Math.trunc(ps.maxX / (numSprays + 1)) * (i + 1);
      ps.sources[i].maxLife = 300;
      ps.sources[i].minLife = 250;
      ps.sources[i].sourceFlags.collide = true;
      ps.sources[i].sourceFlags.perpetual = true;
    }
  } else {
    ps = getParticleSystem2D(seg);
  }
  if (!ps) return fallbackStatic(seg);

  const numSprays = Math.min(ps.numSources, 1);

  // every nth frame, cycle color and emit particles
  if (seg.call % (11 - Math.trunc(seg.intensity / 25)) === 0) {
    for (let i = 0; i < numSprays; i++) {
      const src = ps.sources[i];
      src.source.y = PS_P_RADIUS + 5; // just above the bounce edge
      src.source.vy = 0;
      src.source.hue = (src.source.hue + 1) & 0xff;
      src.source.vx =
        src.source.vx > 0 ? seg.custom1 >> 2 : -(seg.custom1 >> 2);
      src.vy = seg.speed >> 2; // emitting speed (upwards)
      src.vx = 0;
      src.var = seg.custom3 >> 1; // nozzle size
      ps.sprayEmit(src);
      ps.setWallHardness(255); // full hardness for source bounce
      ps.particleMoveUpdate(src.source, src.sourceFlags, volcanosettings);
    }
  }

  ps.updateSystem();
  ps.setColorByAge(seg.check1);
  ps.setBounceX(seg.check2);
  ps.setWallHardness(seg.custom2);

  if (seg.check3) ps.enableParticleCollisions(true, seg.custom2);
  else ps.enableParticleCollisions(false);

  ps.update();
}

// --- PS Ballpit (192) -------------------------------------------------------
function modeParticlePit(seg: Segment2D): void {
  if (!seg.is2D()) return fallbackStatic(seg);
  let ps: ParticleSystem2D | null;
  if (seg.call === 0) {
    ps = initParticleSystem2D(seg, 0, true);
    if (!ps) return fallbackStatic(seg);
    ps.setKillOutOfBounds(true);
    ps.setGravity();
    ps.setUsedParticles(170); // 75% of available particles
  } else {
    ps = getParticleSystem2D(seg);
  }
  if (!ps) return fallbackStatic(seg);

  ps.updateSystem();
  ps.setWrapX(seg.check1);
  ps.setBounceX(seg.check2);
  ps.setBounceY(seg.check3);
  ps.setWallHardness(Math.min(seg.custom2, 150));
  if (seg.custom2 > 0) ps.enableParticleCollisions(true, seg.custom2);
  else ps.enableParticleCollisions(false);

  if (seg.call % (128 - (seg.intensity >> 1)) === 0 && seg.intensity > 0) {
    for (let i = 0; i < ps.usedParticles; i++) {
      const p = ps.particles[i];
      if (p.ttl === 0) {
        // emit at a random position above the top of the matrix
        p.ttl = 1500 - (seg.speed << 2) + seg.rng.random16(500);
        p.x = seg.rng.random16(ps.maxX);
        p.y = ps.maxY << 1;
        p.vx = s8_2d(seg.rng.random16(seg.speed >> 1) - (seg.speed >> 2));
        p.vy = s8_2d(map(seg.speed, 0, 255, -5, -100));
        p.hue = seg.rng.random16() & 0xff;
        ps.particleFlags[i].collide = true;
        p.sat = ((seg.custom3 << 3) + 7) & 0xff;
        if (seg.custom1 === 255) {
          ps.perParticleSize = true;
          ps.advPartProps![i].size = seg.rng.random16(seg.custom1) & 0xff;
        } else {
          ps.setParticleSize(seg.custom1);
          ps.advPartProps![i].size = seg.custom1;
        }
        break; // one particle per round
      }
    }
  }

  let frictioncoefficient = 1 + (seg.check1 ? 1 : 0);
  if (seg.speed < 50) frictioncoefficient = 50 - seg.speed;
  if (seg.call % 6 === 0) ps.applyFriction(frictioncoefficient);

  ps.update();
}

// --- PS Waterfall (196) -----------------------------------------------------
function modeParticleWaterfall(seg: Segment2D): void {
  if (!seg.is2D()) return fallbackStatic(seg);
  let ps: ParticleSystem2D | null;
  if (seg.call === 0) {
    ps = initParticleSystem2D(seg, 12);
    if (!ps) return fallbackStatic(seg);
    ps.setGravity();
    ps.setKillOutOfBounds(true);
    ps.setMotionBlur(190);
    ps.setSmearBlur(30);
    for (let i = 0; i < ps.numSources; i++) {
      ps.sources[i].source.hue = (i * 90) & 0xff;
      ps.sources[i].sourceFlags.collide = true;
      ps.sources[i].maxLife = 400;
      ps.sources[i].minLife = 150;
    }
  } else {
    ps = getParticleSystem2D(seg);
  }
  if (!ps) return fallbackStatic(seg);

  ps.updateSystem();
  ps.setWrapX(seg.check1); // cylinder
  ps.setBounceX(seg.check2); // walls
  ps.setBounceY(seg.check3); // ground
  ps.setWallHardness(seg.custom2);
  const numSprays = Math.min(
    ps.numSources,
    Math.max(Math.trunc(ps.maxXpixel / 6), 2),
  );
  if (seg.custom2 > 0) {
    ps.enableParticleCollisions(true, seg.custom2);
  } else {
    ps.enableParticleCollisions(false);
    ps.setWallHardness(120); // fixed ground bounce without collisions
  }

  for (let i = 0; i < numSprays; i++) {
    ps.sources[i].source.hue =
      (ps.sources[i].source.hue + 1 + seg.rng.random16(seg.custom1 >> 1)) &
      0xff;
  }

  if (seg.call % (12 - (seg.intensity >> 5)) === 0 && seg.intensity > 0) {
    for (let i = 0; i < numSprays; i++) {
      const src = ps.sources[i];
      src.vy = s8_2d(-seg.speed >> 3); // emitting speed, down
      src.source.x =
        map(seg.custom3, 0, 31, 0, (ps.maxXpixel - numSprays) * PS_P_RADIUS) +
        i * PS_P_RADIUS * 2;
      src.source.y = ps.maxY + PS_P_RADIUS * ((i << 2) + 4); // above the top
      src.var = seg.custom1 >> 3;
      ps.sprayEmit(src);
    }
  }

  if (seg.call % 20 === 0) ps.applyFriction(1);

  ps.update();
}

// --- PS Box (193) -----------------------------------------------------------
function modeParticleBox(seg: Segment2D): void {
  if (!seg.is2D()) return fallbackStatic(seg);
  let ps: ParticleSystem2D | null;
  if (seg.call === 0) {
    ps = initParticleSystem2D(seg, 1, true);
    if (!ps) return fallbackStatic(seg);
    ps.setBounceX(true);
    ps.setBounceY(true);
    seg.aux0 = seg.rng.random16(); // position in perlin noise
  } else {
    ps = getParticleSystem2D(seg);
  }
  if (!ps) return fallbackStatic(seg);

  ps.updateSystem();
  ps.setWallHardness(Math.min(seg.custom2, 200));
  ps.enableParticleCollisions(true, Math.max(2, seg.custom2));
  const maxParticleSize = Math.min((seg.width * seg.height) >> 2, 255);
  const currentParticleSize = map(seg.custom3, 0, 31, 0, maxParticleSize);
  ps.setUsedParticles(
    Math.trunc(
      map(seg.intensity, 0, 255, 2, 153) / (1 + (currentParticleSize >> 4)),
    ),
  );
  if (seg.custom3 < 31) ps.setParticleSize(currentParticleSize);
  else ps.perParticleSize = true;

  // add in new particles if amount has changed
  for (let i = 0; i < ps.usedParticles; i++) {
    const p = ps.particles[i];
    if (p.ttl < 260) {
      p.ttl = 260;
      p.x = seg.rng.random16(ps.maxX);
      p.y = seg.rng.random16(ps.maxY);
      p.hue = seg.rng.random8();
      ps.particleFlags[i].perpetual = true;
      ps.particleFlags[i].collide = true;
      ps.advPartProps![i].size = seg.rng.random8(maxParticleSize);
      break; // one spawn per frame
    }
  }

  if (seg.call % (((255 - seg.speed) >> 6) + 1) === 0 && seg.speed > 0) {
    let xgravity: number;
    let ygravity: number;
    const increment = (seg.speed >> 6) + 1;

    if (seg.check2) {
      // washing machine
      const speed = Math.trunc(
        tristateSquare8((seg.now >> 7) & 0xff, 90, 15) /
          ((400 - seg.speed) >> 3),
      );
      seg.aux0 = (seg.aux0 + speed) & 0xffff;
      if (speed === 0) seg.aux0 = 190; // down (= 270°)
    } else {
      seg.aux0 = (seg.aux0 - increment) & 0xffff;
    }

    if (seg.check1) {
      // random, from perlin noise
      xgravity = inoise8(seg.aux0) - 127;
      ygravity = inoise8((seg.aux0 + 10000) & 0xffff) - 127;
      xgravity = Math.trunc((xgravity * seg.custom1) / 128);
      ygravity = Math.trunc((ygravity * seg.custom1) / 128);
    } else {
      // go in a circle
      xgravity = Math.trunc(
        (seg.custom1 * cos16((seg.aux0 << 8) & 0xffff)) / 0xffff,
      );
      ygravity = Math.trunc(
        (seg.custom1 * sin16((seg.aux0 << 8) & 0xffff)) / 0xffff,
      );
    }
    if (seg.check3) {
      // sloshing: y force always downwards
      if (ygravity > 0) ygravity = -ygravity;
    }

    ps.applyForce(xgravity, ygravity);
  }

  if ((seg.call & 0x0f) === 0) ps.applyFriction(1);

  ps.update();
}

// --- PS Fuzzy Noise (191) ---------------------------------------------------
function modeParticlePerlin(seg: Segment2D): void {
  if (!seg.is2D()) return fallbackStatic(seg);
  let ps: ParticleSystem2D | null;
  if (seg.call === 0) {
    ps = initParticleSystem2D(seg, 1, true);
    if (!ps) return fallbackStatic(seg);
    ps.setKillOutOfBounds(true);
    ps.setMotionBlur(230);
    ps.setBounceY(true);
    seg.aux0 = seg.rng.random16();
  } else {
    ps = getParticleSystem2D(seg);
  }
  if (!ps) return fallbackStatic(seg);

  ps.updateSystem();
  ps.setWrapX(seg.check1);
  ps.setBounceX(!seg.check1);
  ps.setWallHardness(seg.custom1);
  ps.enableParticleCollisions(seg.check3, seg.custom1);
  ps.setUsedParticles(map(seg.intensity, 0, 255, 25, 128));
  ps.setSmearBlur(seg.check2 ? 15 : 0);

  // 'gravity' from a 2D perlin noise map
  seg.aux0 = (seg.aux0 + 1 + (seg.speed >> 5)) & 0xffff;
  const scale = 16 - ((31 - seg.custom3) >> 1);
  for (let i = 0; i < ps.usedParticles; i++) {
    const p = ps.particles[i];
    if (p.ttl === 0) {
      // reseed dead particles so they don't clump
      p.ttl = seg.rng.random16(500) + 200;
      p.x = seg.rng.random16(ps.maxX);
      p.y = seg.rng.random16(ps.maxY);
      ps.particleFlags[i].collide = true;
    }
    const xnoise = Math.trunc(p.x / scale) & 0xffff;
    const ynoise = Math.trunc(p.y / scale) & 0xffff;
    const baseheight = perlin8(xnoise, ynoise, seg.aux0);
    p.hue = baseheight & 0xff;
    if (seg.call % 8 === 0) {
      // int8 wrap on the summed slopes is firmware behavior
      const xslope = s8_2d(
        baseheight + perlin8((xnoise - 10) & 0xffff, ynoise, seg.aux0),
      );
      const yslope = s8_2d(
        baseheight + perlin8(xnoise, (ynoise - 10) & 0xffff, seg.aux0),
      );
      ps.applyForceIdx(i, xslope, yslope);
    }
  }

  if (seg.call % (16 - (seg.custom2 >> 4)) === 0) ps.applyFriction(2);

  ps.update();
}

// --- PS Impact (195) --------------------------------------------------------
function modeParticleImpact(seg: Segment2D): void {
  if (!seg.is2D()) return fallbackStatic(seg);
  const meteorsettings = newPSsettings2D();
  meteorsettings.bounceY = true;
  meteorsettings.useGravity = true;

  let ps: ParticleSystem2D | null;
  if (seg.call === 0) {
    ps = initParticleSystem2D(seg, 8);
    if (!ps) return fallbackStatic(seg);
    ps.setKillOutOfBounds(true);
    ps.setGravity();
    ps.setBounceY(true);
    ps.setWallRoughness(220);
    const numMeteors = Math.min(ps.numSources, 8);
    for (let i = 0; i < numMeteors; i++) {
      ps.sources[i].source.ttl = seg.rng.random16(10 * i);
      ps.sources[i].source.vy = 10; // positive = standby
    }
  } else {
    ps = getParticleSystem2D(seg);
  }
  if (!ps) return fallbackStatic(seg);

  ps.updateSystem();
  ps.setWrapX(seg.check1);
  ps.setBounceX(seg.check2);
  ps.setMotionBlur(seg.custom3 << 3);
  const hardness = map(seg.custom2, 0, 255, 126, 255); // MINSURFACEHARDNESS-2
  ps.setWallHardness(hardness);
  ps.enableParticleCollisions(seg.check3, hardness);
  const numMeteors = Math.min(ps.numSources, 8);

  for (let i = 0; i < numMeteors; i++) {
    const src = ps.sources[i];
    let emitparticles: number;
    if (src.source.vy < 0)
      emitparticles = 1; // falling: sparks
    else if (src.source.vy > 0)
      emitparticles = 0; // standby
    else {
      // explode!
      src.source.vy = 10; // timeout, then relaunch
      emitparticles = map(
        seg.intensity,
        0,
        255,
        10,
        seg.rng.random16(ps.usedParticles >> 2),
      );
    }
    for (let e = emitparticles; e > 0; e--) ps.sprayEmit(src);
  }

  // update the meteors
  for (let i = 0; i < numMeteors; i++) {
    const src = ps.sources[i];
    if (src.source.ttl) {
      src.source.ttl--;
      if (src.source.vy < 0) {
        ps.applyGravity(src.source);
        ps.particleMoveUpdate(src.source, src.sourceFlags, meteorsettings);
        if (src.source.y < PS_P_RADIUS << 1) {
          // reached the bottom: explode next call
          src.source.vy = 0;
          src.source.vx = 0;
          src.sourceFlags.collide = true;
          src.maxLife = 1250;
          src.minLife = 250;
          src.source.ttl = seg.rng.random16(768 - (seg.speed << 1)) + 40;
          src.vy = seg.custom1 >> 2;
          src.var = seg.custom1 >> 2;
        }
      }
    } else if (src.source.vy > 0) {
      // relaunch meteor
      src.source.y = ps.maxY + (PS_P_RADIUS << 2);
      src.source.x = seg.rng.random16(ps.maxX);
      src.source.vy = s8_2d(-seg.rng.random16(30) - 30);
      src.source.vx = s8_2d(seg.rng.random16(50) - 25);
      src.source.hue = seg.rng.random16() & 0xff;
      src.source.ttl = 500;
      src.sourceFlags.collide = false;
      src.maxLife = 300;
      src.minLife = 100;
      src.vy = -9;
      src.var = 3;
    }
  }

  for (let i = 0; i < ps.usedParticles; i++) {
    if (ps.particles[i].ttl > 5) ps.particles[i].ttl -= 5;
  }

  ps.update();
}

// --- PS Attractor (194) -----------------------------------------------------
// the attractor particle lives past the PS in firmware SEGENV.data; a WeakMap here
const ATTRACTOR_STATE = new WeakMap<
  Segment,
  {
    x: number;
    y: number;
    ttl: number;
    vx: number;
    vy: number;
    hue: number;
    sat: number;
  }
>();

function modeParticleAttractor(seg: Segment2D): void {
  if (!seg.is2D()) return fallbackStatic(seg);
  const sourcesettings = newPSsettings2D();
  sourcesettings.bounceX = true;
  sourcesettings.bounceY = true;
  const attractorFlags = {
    outofbounds: false,
    collide: false,
    perpetual: false,
    custom1: false,
    custom2: false,
    custom3: false,
  };

  let ps: ParticleSystem2D | null;
  if (seg.call === 0) {
    ps = initParticleSystem2D(seg, 1, true);
    if (!ps) return fallbackStatic(seg);
    ps.sources[0].source.hue = seg.rng.random16() & 0xff;
    ps.sources[0].source.vx = -7; // wall collision gives a random direction
    ps.sources[0].sourceFlags.collide = true;
    ps.sources[0].sourceFlags.perpetual = true;
    ps.sources[0].maxLife = 350;
    ps.sources[0].minLife = 50;
    ps.sources[0].var = 4;
    ps.setWallHardness(255);
    ps.setWallRoughness(200);
    ATTRACTOR_STATE.set(seg, {
      x: 0,
      y: 0,
      ttl: 0,
      vx: 0,
      vy: 0,
      hue: 0,
      sat: 255,
    });
  } else {
    ps = getParticleSystem2D(seg);
  }
  const attractor = ATTRACTOR_STATE.get(seg);
  if (!ps || !attractor) return fallbackStatic(seg);

  ps.updateSystem();
  ps.setColorByAge(seg.check1);
  ps.setParticleSize(seg.custom1 >> 1);
  ps.setUsedParticles(map(seg.intensity, 0, 255, 25, 190));

  attractor.ttl = 100; // never dies
  if (seg.check2) {
    if (seg.call % 3 === 0)
      ps.particleMoveUpdate(attractor, attractorFlags, sourcesettings);
  } else {
    attractor.x = ps.maxX >> 1; // center
    attractor.y = ps.maxY >> 1;
  }
  if (seg.call === 0) {
    attractor.vx = ps.sources[0].source.vy; // reversed x/y of the spray speed
    attractor.vy = ps.sources[0].source.vx;
  }

  if (seg.custom2 > 0)
    ps.enableParticleCollisions(true, map(seg.custom2, 1, 255, 120, 255));
  else ps.enableParticleCollisions(false);

  if (seg.call % 5 === 0)
    ps.sources[0].source.hue = (ps.sources[0].source.hue + 1) & 0xff;

  seg.aux0 = (seg.aux0 + 256) & 0xffff; // emitting angle
  if (seg.call % 2 === 0) ps.angleEmit(ps.sources[0], seg.aux0, 12);
  else ps.angleEmit(ps.sources[0], (seg.aux0 + 0x7fff) & 0xffff, 12);

  const strength = seg.speed;
  for (let i = 0; i < ps.usedParticles; i++) {
    ps.pointAttractor(i, attractor, strength, seg.check3);
  }

  if (seg.call % (33 - seg.custom3) === 0) ps.applyFriction(2);
  ps.particleMoveUpdate(
    ps.sources[0].source,
    ps.sources[0].sourceFlags,
    sourcesettings,
  );
  ps.update();
}

// --- PS Ghost Rider (200) ---------------------------------------------------
const MAXANGLESTEP = 2200; // 32767 means 180°

function modeParticleGhostRider(seg: Segment2D): void {
  if (!seg.is2D()) return fallbackStatic(seg);
  const ghostsettings = newPSsettings2D();
  ghostsettings.wrapX = true;
  ghostsettings.wrapY = true;

  let ps: ParticleSystem2D | null;
  if (seg.call === 0) {
    ps = initParticleSystem2D(seg, 1);
    if (!ps) return fallbackStatic(seg);
    ps.setKillOutOfBounds(true);
    ps.sources[0].maxLife = 260;
    ps.sources[0].minLife = 250;
    ps.sources[0].source.x = seg.rng.random16(ps.maxX);
    ps.sources[0].source.y = seg.rng.random16(ps.maxY);
    seg.step = seg.rng.random16(MAXANGLESTEP) - (MAXANGLESTEP >> 1); // angle increment
  } else {
    ps = getParticleSystem2D(seg);
  }
  if (!ps) return fallbackStatic(seg);

  if (seg.intensity > 0) {
    // spiraling
    if (seg.aux1) {
      seg.step += seg.intensity >> 3;
      if (seg.step > MAXANGLESTEP) seg.aux1 = 0;
    } else {
      seg.step -= seg.intensity >> 3;
      if (seg.step < -MAXANGLESTEP) seg.aux1 = 1;
    }
  }
  ps.updateSystem();
  ps.setMotionBlur(seg.custom1);
  ps.sources[0].var = seg.custom3 >> 1;

  // color by age (the PS built-in always starts at hue 255; not wanted here)
  if (seg.check1) {
    for (let i = 0; i < ps.usedParticles; i++) {
      ps.particles[i].hue =
        (ps.sources[0].source.hue + (ps.particles[i].ttl << 2)) & 0xff;
    }
  }

  ghostsettings.bounceX = seg.check2;
  ghostsettings.bounceY = seg.check2;

  seg.aux0 = (seg.aux0 + seg.step) & 0xffff;
  const emitangle = (seg.aux0 + 32767) & 0xffff; // +180°
  const speed = map(seg.speed, 0, 255, 12, 64);
  ps.sources[0].source.vx = s8_2d(
    Math.trunc((cos16(seg.aux0) * speed) / 32767),
  );
  ps.sources[0].source.vy = s8_2d(
    Math.trunc((sin16(seg.aux0) * speed) / 32767),
  );
  ps.sources[0].source.ttl = 500; // replenished each frame: never dies
  ps.particleMoveUpdate(
    ps.sources[0].source,
    ps.sources[0].sourceFlags,
    ghostsettings,
  );
  // set head (steal one of the particles)
  const head = ps.particles[ps.usedParticles - 1];
  head.x = ps.sources[0].source.x;
  head.y = ps.sources[0].source.y;
  head.ttl = 255;
  head.sat = 0; // white
  // emit two particles
  ps.angleEmit(ps.sources[0], emitangle, speed);
  ps.angleEmit(ps.sources[0], emitangle, speed);
  if (seg.call % (11 - Math.trunc(seg.custom2 / 25)) === 0) {
    ps.sources[0].source.hue = (ps.sources[0].source.hue + 1) & 0xff;
  }
  if (seg.custom2 > 190) {
    // fast color change
    ps.sources[0].source.hue =
      (ps.sources[0].source.hue + ((seg.custom2 - 190) >> 2)) & 0xff;
  }

  ps.update();
}

// --- PS Galaxy (217) --------------------------------------------------------
function modeParticleGalaxy(seg: Segment2D): void {
  if (!seg.is2D()) return fallbackStatic(seg);
  const sourcesettings = newPSsettings2D();
  sourcesettings.bounceX = true;
  sourcesettings.bounceY = true;

  let ps: ParticleSystem2D | null;
  if (seg.call === 0) {
    ps = initParticleSystem2D(seg, 1, true);
    if (!ps) return fallbackStatic(seg);
    ps.sources[0].source.vx = -4; // wall collision gives a random direction
    ps.sources[0].source.x = ps.maxX >> 1; // start in the center
    ps.sources[0].source.y = ps.maxY >> 1;
    ps.sources[0].sourceFlags.perpetual = true;
    ps.sources[0].maxLife = 4000;
    ps.sources[0].minLife = 800;
    ps.sources[0].source.hue = seg.rng.random16() & 0xff;
    ps.setWallHardness(255);
    ps.setWallRoughness(200);
  } else {
    ps = getParticleSystem2D(seg);
  }
  if (!ps) return fallbackStatic(seg);

  ps.updateSystem();
  ps.setParticleSize(seg.custom1);
  ps.setMotionBlur(seg.check3 ? 250 : 0);

  if (seg.call % ((33 - seg.custom3) >> 1) === 0)
    ps.sources[0].source.hue = (ps.sources[0].source.hue + 2) & 0xff;

  if (seg.rng.random8() < 10 + (seg.intensity >> 1))
    ps.sprayEmit(ps.sources[0]); // 5%-55% chance per frame

  if ((seg.call & 0x3) === 0)
    ps.particleMoveUpdate(
      ps.sources[0].source,
      ps.sources[0].sourceFlags,
      sourcesettings,
    );

  // spiral motion (or almost straight in starfield mode)
  const centerx = ps.maxX >> 1;
  const centery = ps.maxY >> 1;
  if (seg.check2) {
    // starfield mode
    ps.setKillOutOfBounds(true);
    ps.sources[0].var = 7;
    ps.sources[0].source.x = centerx;
    ps.sources[0].source.y = centery;
  } else {
    ps.setKillOutOfBounds(false);
    ps.sources[0].var = 1;
  }
  for (let i = 0; i < ps.usedParticles; i++) {
    const p = ps.particles[i];
    if (p.ttl === 0) continue;
    const dx = centerx - p.x;
    const dy = centery - p.y;
    let distance = Math.trunc(Math.sqrt(dx * dx + dy * dy));
    if (distance < 20) distance = 20;
    if (seg.check2) {
      // starfield: speed increases towards the edge
      const speedfactor = 1 + (1 + (seg.speed >> 1)) * distance;
      p.x = s16(p.x + Math.trunc((-speedfactor * dx) / 400000) - (dy >> 6));
      p.y = s16(p.y + Math.trunc((-speedfactor * dy) / 400000) + (dx >> 6));
    } else {
      // spiral in: speed increases towards the center
      const speedfactor = 2 + Math.trunc(((50 + seg.speed) << 6) / distance);
      const tempVx = -speedfactor * dy; // orthogonal to the center vector
      const tempVy = speedfactor * dx;
      const vxc = Math.trunc((dx << 9) / (distance - 19));
      const vyc = Math.trunc((dy << 9) / (distance - 19));
      p.x = s16(p.x + Math.trunc((tempVx + vxc) / 1024));
      p.y = s16(p.y + Math.trunc((tempVy + vyc) / 1024));

      if (distance < 128) {
        // close to center: age fast, turn white
        if (p.ttl > 3) p.ttl -= 4;
        p.sat = (distance << 1) & 0xff;
      }
    }
    if (seg.custom3 === 31)
      p.hue = (p.ttl >> 2) & 0xff; // color by (long) age
    else if (seg.custom3 === 0)
      p.hue = map(distance, 20, (ps.maxX + ps.maxY) >> 2, 0, 180) & 0xff;
  }

  ps.update();
}

export const EFFECT_SIMS: Record<number, (seg: Segment) => void> = {
  0: modeStatic,
  1: modeBlink,
  2: modeBreath,
  3: modeColorWipe,
  8: modeRainbow, // "Colorloop"
  9: modeRainbowCycle, // "Rainbow"
  10: modeScan,
  12: modeFade,
  13: modeTheaterChase,
  15: modeRunningLights,
  17: modeTwinkle,
  18: modeDissolve,
  20: modeSparkle,
  23: modeStrobe,
  28: modeChaseColor, // "Chase"
  30: modeChaseRainbow,
  40: modeLarsonScanner, // "Scanner"
  41: modeComet, // "Lighthouse"
  42: modeFireworks,
  66: modeFire2012,
  76: modeMeteor,
  87: modeGlitter,
  25: modeMultiStrobe, // "Strobe Mega"
  38: modeAurora,
  45: modeFireFlicker,
  56: modeTricolorFade, // "Tri Fade"
  67: modeColorwaves,
  74: modeColortwinkle, // "Colortwinkles"
  80: modeTwinklefox,
  88: modeCandle,
  97: modePlasma,
  101: modePacifica,
  104: modeSunrise,
  34: modeColorful,
  35: modeTrafficLight,
  46: modeGradient,
  47: modeLoading,
  57: modeLightning,
  63: modePride2015,
  64: modeJuggle,
  68: modeBpm,
  92: modeSinelon,
  93: modeSinelonDual,
  94: modeSinelonRainbow,
  98: modePercent,
  108: modeSinewave,
  110: modeFlow,
  113: modeWashingMachine,
  115: modeBlends,
  179: modeFlowStripe,
  44: modeTetrix,
  49: modeFairy,
  51: modeFairytwinkle,
  62: modeOscillate,
  91: modeBouncingBalls,
  95: modePopcorn,
  106: modeTwinkleup,
  7: modeDynamic,
  16: modeSaw,
  43: modeRain,
  50: modeTwoDots,
  75: modeLake,
  78: modeRailway,
  79: modeRipple,
  81: modeTwinklecat,
  83: modeStaticPattern,
  84: modeTriStaticPattern,
  85: modeSpots,
  86: modeSpotsFade,
  99: modeRippleRainbow,
  100: modeHeartbeat,
  105: modePhased,
  111: modeChunchun,
  117: modeDynamicSmooth,
  184: modeWavesins,
  218: modeColorClouds,
  24: modeStrobeRainbow,
  26: modeBlinkRainbow,
  65: modePalette,
  82: modeHalloweenEyes,
  112: modeDancingShadows,
  58: modeIcu,
  89: modeStarburst,
  96: modeDrip,
  103: modeSolidGlitter,
  14: modeTheaterChaseRainbow, // "Theater Rainbow"
  27: modeAndroid,
  70: modeNoise16_1, // "Noise 1"
  90: modeExplodingFireworks, // "Fireworks 1D"
  116: modeTvSimulator,
  39: modeRunningRandom, // "Stream"
  59: modeMultiComet,
  60: modeScannerDual,
  107: modeNoisePal,
  151: modePacman,
  48: modeRollingBalls,
  61: modeRandomChase, // "Stream 2"
  69: modeFillNoise8,
  102: modeCandleMulti,
  109: modePhasedNoise,
  161: modeShimmer,
  4: modeColorWipeRandom,
  5: modeRandomColor,
  6: modeColorSweep,
  11: modeDualScan,
  19: modeDissolveRandom,
  21: modeFlashSparkle,
  22: modeHyperSparkle,
  29: modeChaseRandom,
  31: modeChaseFlash,
  32: modeChaseFlashRandom,
  33: modeChaseRainbowWhite,
  36: modeColorSweepRandom,
  37: modeRunningColor,
  52: modeRunningDual,
  54: modeTricolorChase,
  55: modeTricolorWipe,
  71: modeNoise16_2,
  72: modeNoise16_3,
  73: modeNoise16_4,
  147: modePerlinMove,
  202: modeParticleDrip, // "PS DripDrop"
  203: modeParticlePinball, // "PS Pinball"
  204: modeParticleDancingShadows, // "PS Dancing Shadows"
  205: modeParticleFireworks1D, // "PS Fireworks 1D"
  206: modeParticleSparkler, // "PS Sparkler"
  207: modeParticleHourglass, // "PS Hourglass"
  208: modeParticleSpray1D, // "PS Spray 1D"
  209: modeParticleBalance, // "PS 1D Balance"
  210: modeParticleChase, // "PS Chase"
  211: modeParticleStarburst, // "PS Starburst"
  213: modeParticleFire1D, // "PS Fire 1D"
  // Audio-reactive 1D set -- all read the synthetic fixture, never real audio.
  128: modePixels,
  129: modePixelwave,
  130: modeJuggles,
  131: modeMatripix,
  132: modeGravimeter,
  133: modePlasmoid,
  134: modePuddles,
  135: modeMidnoise,
  136: modeNoisemeter,
  137: modeFreqwave,
  138: modeFreqmatrix,
  140: modeWaterfall,
  141: modeFreqpixels,
  143: modeNoisefire,
  144: modePuddlepeak,
  145: modeNoisemove,
  148: modeRipplePeak,
  155: modeFreqmap,
  156: modeGravcenter,
  157: modeGravcentric,
  158: modeGravfreq,
  159: modeDJLight,
  163: modeBlurz,
  185: modeRocktaves,
  212: modeParticleGeq1D, // "PS GEQ 1D"
  214: modeParticleSonicStream, // "PS Sonic Stream"
  215: modeParticleSonicBoom, // "PS Sonic Boom"
  216: modeParticleSpringy, // "PS Springy"
};

// --- Dual 1D/2D effects: matrix branches --------------------------------
// The seven effects below have a single WLED mode_* function whose C++ body
// branches on SEGMENT.is2D()/strip.isMatrix. Their 1D branch was already
// ported above (modeFireworks, modeRain, modePalette, modeRipple,
// modeRippleRainbow, modeHalloweenEyes, modeExplodingFireworks); these are
// the matching 2D branches, ported into their own functions since this
// sim's 1D/2D dispatch happens at the registry level, not inside one body.

// --- Fireworks (42), 2D branch ----------------------------------------------
function mode2DFireworks(seg: Segment2D): void {
  const width = seg.width;
  const height = seg.height;

  if (seg.call === 0) {
    seg.aux0 = 0xffff;
    seg.aux1 = 0xffff;
  }
  seg.fade_out(128);

  const x = seg.aux0 % width;
  const y = Math.trunc(seg.aux0 / width);
  if (!seg.step) {
    const valid1 = seg.aux0 < width * height;
    const valid2 = seg.aux1 < width * height;
    let sv1 = 0;
    let sv2 = 0;
    // Firmware reads both spark colors from the SAME (x,y) -- derived from
    // aux0 only, even for the aux1 spark -- preserved as-is (FX.cpp:1307-8).
    if (valid1) sv1 = seg.getPixelColorXY(x, y);
    if (valid2) sv2 = seg.getPixelColorXY(x, y);
    seg.blur(16);
    if (valid1) seg.setPixelColorXY(x, y, sv1);
    if (valid2) seg.setPixelColorXY(x, y, sv2);
  }

  for (let i = 0; i < Math.max(1, Math.trunc(width / 20)); i++) {
    if (seg.rng.random8(129 - (seg.intensity >> 1)) === 0) {
      const index = seg.rng.random16(width * height);
      const ix = index % width;
      const iy = Math.trunc(index / width);
      const col = seg.color_from_palette(seg.rng.random8(), false, false, 0);
      seg.setPixelColorXY(ix, iy, col);
      seg.aux1 = seg.aux0;
      seg.aux0 = index;
    }
  }
}

// --- Rain (43), 2D branch ----------------------------------------------------
function mode2DRain(seg: Segment2D): void {
  const width = seg.width;
  const height = seg.height;
  seg.step += FRAMETIME;
  const speedFormulaL = 5 + Math.trunc((50 * (255 - seg.speed)) / seg.length);
  if (seg.call && seg.step > speedFormulaL) {
    seg.step = 1;
    seg.move(6, 1, true); // move all pixels down
    seg.aux0 =
      (seg.aux0 % width) + (Math.trunc(seg.aux0 / width) + 1) * width;
    seg.aux1 =
      (seg.aux1 % width) + (Math.trunc(seg.aux1 / width) + 1) * width;
    if (seg.aux0 === 0) seg.aux0 = 0xffff;
    // Firmware sets aux0 (not aux1) on this line too -- the same copy-paste
    // quirk preserved in the 1D port above (modeRain).
    if (seg.aux1 === 0) seg.aux0 = 0xffff;
    if (seg.aux0 >= width * height) seg.aux0 = 0;
    if (seg.aux1 >= width * height) seg.aux1 = 0;
  }
  mode2DFireworks(seg);
}

// --- Palette (65), 2D branch --------------------------------------------------
function mode2DPalette(seg: Segment2D): void {
  const cols = seg.width;
  const rows = seg.height;

  const inputShift = seg.speed;
  const inputSize = seg.intensity;
  const inputRotation = seg.custom1;
  const inputAnimateShift = seg.check1;
  const inputAnimateRotation = seg.check2;
  const inputAssumeSquare = seg.check3;

  const maxAngle = Math.PI / 256;
  const animatedRotationScale = (2 * Math.PI) / 0xffff;

  const theta = !inputAnimateRotation
    ? (inputRotation + 128) * maxAngle
    : ((seg.now * ((inputRotation >> 4) + 1)) & 0xffff) *
      animatedRotationScale;
  const sinTheta = sin_approx(theta);
  const cosTheta = cos_approx(theta);

  const maxX = Math.max(1, cols - 1);
  const maxY = Math.max(1, rows - 1);
  const maxXIn = inputAssumeSquare ? maxX : 1;
  const maxYIn = inputAssumeSquare ? maxY : 1;
  const maxXOut = !inputAssumeSquare ? maxX : 1;
  const maxYOut = !inputAssumeSquare ? maxY : 1;
  const centerX = maxXOut / 2;
  const centerY = maxYOut / 2;
  const scale = Math.abs(sinTheta) + (Math.abs(cosTheta) * maxYOut) / maxXOut;

  for (let y = 0; y < rows; y++) {
    const ytCosTheta = (cosTheta * (y - centerY * maxYIn)) / (maxYIn * scale);
    for (let x = 0; x < cols; x++) {
      const xtSinTheta =
        (sinTheta * (x - centerX * maxXIn)) / (maxXIn * scale);
      const sourceX = xtSinTheta + ytCosTheta + centerX;
      let colorIndex = Math.trunc(
        (Math.min(Math.max(sourceX, 0), maxXOut) * 255) / maxXOut,
      );
      if (inputSize <= 128) {
        colorIndex = Math.trunc((colorIndex * inputSize) / 128);
      } else {
        colorIndex = Math.trunc(((inputSize - 112) * colorIndex) / 16);
      }
      const paletteOffset = !inputAnimateShift
        ? inputShift
        : ((seg.now * ((inputShift >> 3) + 1)) & 0xffff) >> 8;
      colorIndex -= paletteOffset;
      seg.setPixelColorXY(x, y, seg.color_wheel(colorIndex & 0xff));
    }
  }
}

// --- Ripple (79) / Ripple Rainbow (99), 2D branch -----------------------------
// Shared ripple_base 2D path: pos packs (cx<<8)|cy instead of a 1D index, and
// each drop draws a soft expanding ring (drawCircle) instead of two pixels.
interface RippleDrop2D {
  state: number;
  pos: number;
  color: number;
}

const rippleState2D = new WeakMap<Segment2D, RippleDrop2D[]>();

function rippleBase2D(seg: Segment2D, blurAmount = 0): void {
  const maxRipples = Math.min(1 + (seg.length >> 2), MAX_RIPPLES);
  let ripples = rippleState2D.get(seg);
  if (!ripples || ripples.length !== maxRipples) {
    ripples = Array.from({ length: maxRipples }, () => ({
      state: 0,
      pos: 0,
      color: 0,
    }));
    rippleState2D.set(seg, ripples);
  }

  for (const ripple of ripples) {
    if (ripple.state) {
      const rippledecay = (seg.speed >> 4) + 1;
      const rippleorigin = ripple.pos;
      const col = seg.color_from_palette(ripple.color, false, false, 255);
      const propagation =
        (Math.trunc(ripple.state / rippledecay) - 1) * (seg.speed + 1);
      const propI = Math.trunc((propagation >> 8) / 2);
      const propF = propagation & 0xff;
      const amp =
        ripple.state < 17
          ? triwave8(((ripple.state - 1) * 8) & 0xff)
          : map(ripple.state, 17, 255, 255, 2);

      const cx = rippleorigin >> 8;
      const cy = rippleorigin & 0xff;
      const mag = scale8(sin8((propF >> 2) & 0xff), amp);
      if (propI > 0) {
        seg.drawCircle(
          cx,
          cy,
          propI,
          color_blend(seg.getPixelColorXY(cx + propI, cy), col, mag),
          true,
        );
      }

      const next = ripple.state + rippledecay;
      ripple.state = next > 254 ? 0 : next;
    } else if (seg.rng.random16(5100 + 10000) <= seg.intensity >> 3) {
      ripple.state = 1;
      ripple.pos =
        ((seg.rng.random8(seg.width) << 8) | seg.rng.random8(seg.height)) >>>
        0;
      ripple.color = seg.rng.random8();
    }
  }

  seg.blur(blurAmount);
}

function mode2DRipple(seg: Segment2D): void {
  if (seg.custom1 || seg.check2) {
    seg.fade_out(250);
  } else {
    seg.fill(seg.color(1));
  }
  rippleBase2D(seg, seg.custom1 >> 1);
}

function mode2DRippleRainbow(seg: Segment2D): void {
  if (seg.call === 0) {
    seg.aux0 = seg.rng.random8();
    seg.aux1 = seg.rng.random8();
  }
  if (seg.aux0 === seg.aux1) {
    seg.aux1 = seg.rng.random8();
  } else if (seg.aux1 > seg.aux0) {
    seg.aux0 = (seg.aux0 + 1) & 0xff;
  } else {
    seg.aux0 = (seg.aux0 - 1) & 0xff;
  }
  seg.fill(color_blend(seg.color_wheel(seg.aux0), BLACK, 235));
  rippleBase2D(seg);
}

// --- Halloween Eyes (82), 2D branch -------------------------------------------
// Firmware reuses SEGMENT.offset to stash the row (a hack noted in FX.cpp's
// own comment); this sim owns its state struct outright, so the row is just
// a field on it instead.
interface EyeData2D {
  state: number;
  color: number;
  startPos: number;
  row: number;
  duration: number;
  startTime: number;
  blinkEndTime: number;
}

const eyeDataState2D = new WeakMap<Segment2D, EyeData2D>();

function mode2DHalloweenEyes(seg: Segment2D): void {
  const maxWidth = seg.width;
  const eyeSpace = Math.max(2, seg.width >> 4);
  const eyeWidth = eyeSpace >> 1;
  const eyeLength = 2 * eyeWidth + eyeSpace;
  if (eyeLength >= maxWidth) return fallbackStatic(seg);

  let data = eyeDataState2D.get(seg);
  if (seg.call === 0 || !data) {
    data = {
      state: EYE_INIT_ON,
      color: 0,
      startPos: 0,
      row: 0,
      duration: 0,
      startTime: 0,
      blinkEndTime: 0,
    };
    eyeDataState2D.set(seg, data);
  }

  if (!seg.check2) seg.fill(seg.color(1)); // fill background

  data.state = data.state % EYE_STATE_COUNT;
  let duration = Math.max(1, data.duration);
  const elapsedTime = seg.now - data.startTime;

  // Same deliberate fallthrough as the 1D port: a freshly (re)initialized
  // state renders immediately instead of waiting a frame.
  switch (data.state) {
    case EYE_INIT_ON: {
      data.startPos = seg.rng.random16(0, maxWidth - eyeLength - 1);
      data.color = seg.rng.random8();
      data.row = seg.rng.random16(0, seg.height - 1);
      duration = 128 + seg.rng.random16(seg.intensity * 64);
      data.duration = duration;
      data.state = EYE_ON;
    }
    // falls through
    case EYE_ON: {
      const start2ndEye = data.startPos + eyeWidth + eyeSpace;
      duration = Math.min(duration, 128 + seg.intensity * 64);

      const minimumOnTimeBegin = 1024;
      const minimumOnTimeEnd = 1024;
      const fadeInAnimationState = Math.trunc(
        (elapsedTime * (256 * 8)) / duration,
      );
      const backgroundColor = seg.color(1);
      const eyeColor = seg.color_from_palette(data.color, false, false, 0);
      let c = eyeColor;
      if (fadeInAnimationState < 256) {
        c = color_blend(backgroundColor, eyeColor, fadeInAnimationState & 0xff);
      } else if (elapsedTime > minimumOnTimeBegin) {
        const remainingTime =
          elapsedTime >= duration ? 0 : duration - elapsedTime;
        if (remainingTime > minimumOnTimeEnd) {
          if (seg.rng.random8() < 4) {
            c = backgroundColor;
            data.state = EYE_BLINK;
            data.blinkEndTime = seg.now + seg.rng.random8(8, 128);
          }
        }
      }

      if (c !== backgroundColor) {
        for (let i = 0; i < eyeWidth; i++) {
          seg.setPixelColorXY(data.startPos + i, data.row, c);
          seg.setPixelColorXY(start2ndEye + i, data.row, c);
        }
      }
      break;
    }
    case EYE_BLINK: {
      if (seg.now >= data.blinkEndTime) data.state = EYE_ON;
      break;
    }
    case EYE_INIT_OFF: {
      const eyeOffTimeBase = seg.speed * 128;
      duration = eyeOffTimeBase + seg.rng.random16(eyeOffTimeBase);
      data.duration = duration;
      data.state = EYE_OFF;
    }
    // falls through
    case EYE_OFF: {
      const eyeOffTimeBase = seg.speed * 128;
      duration = Math.min(duration, 2 * eyeOffTimeBase);
      break;
    }
    case EYE_STATE_COUNT:
    default: {
      data.state = EYE_INIT_ON;
      break;
    }
  }

  if (elapsedTime > duration) {
    switch (data.state) {
      case EYE_INIT_ON:
      case EYE_ON:
      case EYE_BLINK:
        data.state = EYE_INIT_OFF;
        break;
      case EYE_INIT_OFF:
      case EYE_OFF:
      case EYE_STATE_COUNT:
      default:
        data.state = EYE_INIT_ON;
        break;
    }
    data.startTime = seg.now;
  }
}

// --- Fireworks 1D / "Exploding Fireworks" (90), 2D branch ---------------------
interface FireworkSpark2D {
  pos: number;
  posX: number;
  vel: number;
  velX: number;
  col: number;
  colIndex: number;
}

interface FireworksState2D {
  sparks: FireworkSpark2D[]; // sparks[0] doubles as the flare
  dyingGravity: number;
}

const fireworksState2D = new WeakMap<Segment2D, FireworksState2D>();

function mode2DExplodingFireworks(seg: Segment2D): void {
  const cols = seg.width;
  const rows = seg.height;

  let state = fireworksState2D.get(seg);
  if (!state) {
    // Same simplification as the 1D port: no device-memory spark cap to
    // reconcile against, so this always uses the uncapped formula.
    const numSparks = 5 + ((rows * cols) >> 1);
    state = {
      sparks: Array.from({ length: numSparks }, () => ({
        pos: 0,
        posX: 0,
        vel: 0,
        velX: 0,
        col: 0,
        colIndex: 0,
      })),
      dyingGravity: 0,
    };
    seg.aux0 = 0;
    fireworksState2D.set(seg, state);
  }
  const { sparks } = state;
  const flare = sparks[0];

  seg.fade_out(252);

  const gravity = (-0.0004 - seg.speed / 800000) * rows;

  if (seg.aux0 < 2) {
    // FLARE
    if (seg.aux0 === 0) {
      flare.pos = 0;
      flare.posX = seg.rng.random16(2, cols - 3);
      let peakHeight = 75 + seg.rng.random8(180);
      peakHeight = (peakHeight * (rows - 1)) >> 8;
      flare.vel = Math.sqrt(-2 * gravity * peakHeight);
      flare.velX = (seg.rng.random8(9) - 4) / 64;
      flare.col = 255;
      seg.aux0 = 1;
    }

    if (flare.vel > 12 * gravity) {
      const gray = flare.col & 0xff;
      seg.setPixelColorXY(
        Math.trunc(flare.posX),
        rows - Math.trunc(flare.pos) - 1,
        rgbw32(gray, gray, gray),
      );
      flare.pos += flare.vel;
      flare.pos = Math.min(Math.max(flare.pos, 0), rows - 1);
      flare.posX += flare.velX;
      flare.posX = Math.min(Math.max(flare.posX, 0), cols - 1);
      flare.vel += gravity;
      flare.col -= 2;
    } else {
      seg.aux0 = 2; // ready to explode
    }
  } else if (seg.aux0 < 4) {
    // Explode! Size proportional to the flare's peak height.
    let nSparks = Math.trunc(flare.pos) + seg.rng.random8(4);
    nSparks = Math.max(nSparks, 4);
    nSparks = Math.min(nSparks, sparks.length);

    if (seg.aux0 === 2) {
      for (let i = 1; i < nSparks; i++) {
        sparks[i].pos = flare.pos;
        sparks[i].posX = flare.posX;
        sparks[i].vel = seg.rng.random16(20001) / 10000 - 0.9;
        sparks[i].vel *= rows < 32 ? 0.5 : 1;
        sparks[i].velX = seg.rng.random16(20001) / 10000 - 1.0;
        sparks[i].col = 345;
        sparks[i].colIndex = seg.rng.random8();
        sparks[i].vel *= flare.pos / rows;
        sparks[i].velX *= flare.posX / cols;
        sparks[i].vel *= -gravity * 50;
      }
      state.dyingGravity = gravity / 2;
      seg.aux0 = 3;
    }

    if (sparks[1].col > 4) {
      // as long as our known spark is lit, work with all the sparks
      for (let i = 1; i < nSparks; i++) {
        sparks[i].pos += sparks[i].vel;
        sparks[i].posX += sparks[i].velX;
        sparks[i].vel += state.dyingGravity;
        sparks[i].velX += state.dyingGravity;
        if (sparks[i].col > 3) sparks[i].col -= 4;

        if (sparks[i].pos > 0 && sparks[i].pos < rows) {
          if (!(sparks[i].posX >= 0 && sparks[i].posX < cols)) continue;
          const prog = sparks[i].col;
          const spColor = seg.palette
            ? seg.color_wheel(sparks[i].colIndex)
            : seg.color(0);
          let c = BLACK;
          if (prog > 300) {
            c = color_blend(spColor, WHITE, ((prog - 300) * 5) & 0xff);
          } else if (prog > 45) {
            c = color_blend(BLACK, spColor, (prog - 45) & 0xff);
            const cooling = (300 - prog) >> 5;
            c = rgbw32(R(c), qsub8(G(c), cooling), qsub8(B(c), cooling * 2));
          }
          seg.setPixelColorXY(
            Math.trunc(sparks[i].posX),
            rows - Math.trunc(sparks[i].pos) - 1,
            c,
          );
        }
      }
      if (seg.check3) seg.blur(16);
      state.dyingGravity *= 0.8; // as sparks burn out they fall slower
    } else {
      seg.aux0 = 6 + seg.rng.random8(10); // wait this many frames
    }
  } else {
    seg.aux0--;
    if (seg.aux0 < 4) seg.aux0 = 0; // back to flare
  }
}

// --- Audio-reactive 2D effects -------------------------------------------
// These nine read WLED's audio-reactive globals (volumeSmth / fftResult).
// There is no real audio analysis in this sim (locked constraint), so every
// one of them reads sampleSyntheticAudio() (audio-fixture.ts) instead --
// always the "audio present" branch of the firmware body, since this sim has
// no concept of "usermod absent" to fall back from.

// --- GEQ (139) -----------------------------------------------------------
const geqBarState = new WeakMap<Segment2D, Uint16Array>();

function mode2DGeq(seg: Segment2D): void {
  const cols = seg.width;
  const rows = seg.height;
  const numBands = map(seg.custom1, 0, 255, 1, 16);
  const centerBin = map(seg.custom3, 0, 31, 0, 15);

  let previousBarHeight = geqBarState.get(seg);
  if (!previousBarHeight || previousBarHeight.length !== cols) {
    previousBarHeight = new Uint16Array(cols);
    geqBarState.set(seg, previousBarHeight);
  }
  if (seg.call === 0) previousBarHeight.fill(0);

  const { fftResult } = sampleSyntheticAudio(seg.now);

  let rippleTime = false;
  if (seg.now - seg.step >= 256 - seg.intensity) {
    seg.step = seg.now;
    rippleTime = true;
  }

  const fadeoutDelay = Math.trunc((256 - seg.speed) / 64);
  if (fadeoutDelay <= 1 || seg.call % fadeoutDelay === 0) {
    seg.fadeToBlackBy(seg.speed);
  }

  for (let x = 0; x < cols; x++) {
    let band = map(x, 0, cols, 0, numBands);
    if (numBands < 16) {
      const startBin = Math.min(
        Math.max(centerBin - (numBands >> 1), 0),
        15 - numBands + 1,
      );
      band =
        numBands <= 1
          ? centerBin
          : map(band, 0, numBands - 1, startBin, startBin + numBands - 1);
    }
    band = Math.min(Math.max(band, 0), 15);
    let colorIndex = band * 17;
    const barHeight = map(fftResult[band], 0, 255, 0, rows); // rows, not rows-1
    if (barHeight > previousBarHeight[x]) previousBarHeight[x] = barHeight;

    // PALETTE_SOLID_WRAP is (paletteBlend==1||==3); this sim fixes
    // paletteBlend at 0 (segment.ts), so it's always false here.
    let ledColor = BLACK;
    for (let y = 0; y < barHeight; y++) {
      if (seg.check1) colorIndex = map(y, 0, rows - 1, 0, 255);
      ledColor = seg.color_from_palette(colorIndex, false, false, 0);
      seg.setPixelColorXY(x, rows - 1 - y, ledColor);
    }
    if (previousBarHeight[x] > 0) {
      seg.setPixelColorXY(
        x,
        rows - previousBarHeight[x],
        seg.color(2) !== BLACK ? seg.color(2) : ledColor,
      );
    }
    if (rippleTime && previousBarHeight[x] > 0) previousBarHeight[x]--;
  }
}

// --- Funky Plank (160) -----------------------------------------------------
function mode2DFunkyPlank(seg: Segment2D): void {
  const cols = seg.width;
  const rows = seg.height;

  const numBands = map(seg.custom1, 0, 255, 1, 16);
  let barWidth = Math.trunc(cols / numBands);
  let bandInc = 1;
  if (barWidth === 0) {
    barWidth = 1;
    bandInc = Math.trunc(numBands / cols);
  }

  const { fftResult } = sampleSyntheticAudio(seg.now);

  if (seg.call === 0) seg.fill(BLACK);

  // Firmware reads a hardware microsecond clock (micros()); this sim only
  // has millisecond time, so ms*1000 substitutes for it. The original's
  // `+1 % 64` is a precedence quirk (% binds tighter than the outer +, so it
  // reduces to `+1`) -- preserved as-is rather than "fixed".
  const usNow = seg.now * 1000;
  const secondHand =
    (Math.trunc(Math.trunc(usNow / (256 - seg.speed)) / 500) + 1) & 0xff;
  if (seg.aux0 !== secondHand) {
    seg.aux0 = secondHand;

    let b = 0;
    for (let band = 0; band < numBands; band += bandInc, b++) {
      const hue = fftResult[band % 16];
      const v = map(fftResult[band % 16], 0, 255, 10, 255);
      const color = hsv2rgb_rainbow((hue & 0xff) << 8, 255, v);
      for (let w = 0; w < barWidth; w++) {
        const xpos = barWidth * b + w;
        seg.setPixelColorXY(xpos, 0, color);
      }
    }

    for (let i = rows - 1; i > 0; i--) {
      for (let j = cols - 1; j >= 0; j--) {
        seg.setPixelColorXY(j, i, seg.getPixelColorXY(j, i - 1));
      }
    }
  }
}

// --- Swirl (175) -------------------------------------------------------------
function mode2DSwirl(seg: Segment2D): void {
  const cols = seg.width;
  const rows = seg.height;
  if (seg.call === 0) seg.fill(BLACK);

  const borderWidth = 2;
  seg.blur(seg.custom1);

  const i = beatsin8_t(
    Math.trunc((27 * seg.speed) / 255),
    seg.now,
    borderWidth,
    cols - borderWidth,
  );
  const j = beatsin8_t(
    Math.trunc((41 * seg.speed) / 255),
    seg.now,
    borderWidth,
    rows - borderWidth,
  );
  const ni = cols - 1 - i;
  // Firmware quirk: nj is also derived from `cols`, not `rows`, even though
  // j is a row coordinate -- only symmetric on a square matrix. Preserved.
  const nj = cols - 1 - j;

  const { volumeSmth, volumeRaw } = sampleSyntheticAudio(seg.now);

  const tap = (x: number, y: number, divisor: number): void => {
    const index = (Math.trunc(seg.now / divisor) + volumeSmth * 4) & 0xff;
    const bri = (Math.trunc((volumeRaw * seg.intensity) / 64)) & 0xff;
    const col = colorFromPalette(
      seg.getCurrentPalette(),
      index,
      bri,
      LINEARBLEND,
    );
    seg.addPixelColorXY(x, y, col);
  };
  tap(i, j, 11);
  tap(j, i, 13);
  tap(ni, nj, 17);
  tap(nj, ni, 29);
  tap(i, nj, 37);
  tap(ni, j, 41);
}

// --- Waverly (165) -----------------------------------------------------------
function mode2DWaverly(seg: Segment2D): void {
  const cols = seg.width;
  const rows = seg.height;
  const { volumeSmth } = sampleSyntheticAudio(seg.now);

  seg.fadeToBlackBy(seg.speed);

  const t = Math.trunc(seg.now / 2);
  for (let i = 0; i < cols; i++) {
    let thisVal = Math.trunc(
      ((1 + (seg.intensity >> 6)) * perlin8(i * 45, t, t)) / 2,
    );
    // "use audio if available" -- always true in this sim.
    thisVal = Math.trunc(thisVal / 32);
    thisVal = Math.trunc(thisVal * volumeSmth);
    const thisMax = map(thisVal, 0, 512, 0, rows);

    for (let j = 0; j < thisMax; j++) {
      const idx = map(j, 0, thisMax, 250, 0);
      const col = colorFromPalette(
        seg.getCurrentPalette(),
        idx,
        255,
        LINEARBLEND,
      );
      seg.addPixelColorXY(i, j, col);
      seg.addPixelColorXY(cols - 1 - i, rows - 1 - j, col);
    }
  }
  if (seg.check3) seg.blur(16, cols * rows < 100);
}

// --- Akemi (186) ---------------------------------------------------------
// 32x32 category bitmap (0=bg,1/2/3=arms&legs dark/normal/light,4/5/6=face
// dark/normal/light,7=eyes&mouth,8=sound-reactive accent), transcribed
// verbatim from FX.cpp's `akemi[]` (wled00/FX.cpp).
// prettier-ignore
const AKEMI_BITMAP = new Uint8Array([
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,2,2,2,2,2,2,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,2,2,3,3,3,3,3,3,2,2,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,2,3,3,0,0,0,0,0,0,3,3,2,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,2,3,0,0,0,6,5,5,4,0,0,0,3,2,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,2,3,0,0,6,6,5,5,5,5,4,4,0,0,3,2,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,2,3,0,6,5,5,5,5,5,5,5,5,4,0,3,2,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,2,3,0,6,5,5,5,5,5,5,5,5,5,5,4,0,3,2,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,3,2,0,6,5,5,5,5,5,5,5,5,5,5,4,0,2,3,0,0,0,0,0,0,0,
  0,0,0,0,0,0,3,2,3,6,5,5,7,7,5,5,5,5,7,7,5,5,4,3,2,3,0,0,0,0,0,0,
  0,0,0,0,0,2,3,1,3,6,5,1,7,7,7,5,5,1,7,7,7,5,4,3,1,3,2,0,0,0,0,0,
  0,0,0,0,0,8,3,1,3,6,5,1,7,7,7,5,5,1,7,7,7,5,4,3,1,3,8,0,0,0,0,0,
  0,0,0,0,0,8,3,1,3,6,5,5,1,1,5,5,5,5,1,1,5,5,4,3,1,3,8,0,0,0,0,0,
  0,0,0,0,0,2,3,1,3,6,5,5,5,5,5,5,5,5,5,5,5,5,4,3,1,3,2,0,0,0,0,0,
  0,0,0,0,0,0,3,2,3,6,5,5,5,5,5,5,5,5,5,5,5,5,4,3,2,3,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,6,5,5,5,5,5,7,7,5,5,5,5,5,4,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,6,5,5,5,5,5,5,5,5,5,5,5,5,4,0,0,0,0,0,0,0,0,0,
  1,0,0,0,0,0,0,0,0,6,5,5,5,5,5,5,5,5,5,5,5,5,4,0,0,0,0,0,0,0,0,2,
  0,2,2,2,0,0,0,0,0,6,5,5,5,5,5,5,5,5,5,5,5,5,4,0,0,0,0,0,2,2,2,0,
  0,0,0,3,2,0,0,0,6,5,4,4,4,4,4,4,4,4,4,4,4,4,4,4,0,0,0,2,2,0,0,0,
  0,0,0,3,2,0,0,0,6,5,5,5,5,5,5,5,5,5,5,5,5,5,5,4,0,0,0,2,3,0,0,0,
  0,0,0,0,3,2,0,0,0,0,3,3,0,3,3,0,0,3,3,0,3,3,0,0,0,0,2,2,0,0,0,0,
  0,0,0,0,3,2,0,0,0,0,3,2,0,3,2,0,0,3,2,0,3,2,0,0,0,0,2,3,0,0,0,0,
  0,0,0,0,0,3,2,0,0,3,2,0,0,3,2,0,0,3,2,0,0,3,2,0,0,2,3,0,0,0,0,0,
  0,0,0,0,0,3,2,2,2,2,0,0,0,3,2,0,0,3,2,0,0,0,3,2,2,2,3,0,0,0,0,0,
  0,0,0,0,0,0,3,3,3,0,0,0,0,3,2,0,0,3,2,0,0,0,0,3,3,3,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,3,2,0,0,3,2,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,3,2,0,0,3,2,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,3,2,0,0,3,2,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,3,2,0,0,3,2,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,3,2,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,3,2,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
]);

const AKEMI_ORANGE = rgbw32(255, 165, 0); // CRGB::Orange
const AKEMI_DEFAULT_ARMS = rgbw32(0xff, 0xe0, 0xa0); // warmish white default

function scaleColorFloat(c: number, factor: number): number {
  return rgbw32(
    Math.min(255, Math.round(R(c) * factor)),
    Math.min(255, Math.round(G(c) * factor)),
    Math.min(255, Math.round(B(c) * factor)),
  );
}

function mode2DAkemi(seg: Segment2D): void {
  const cols = seg.width;
  const rows = seg.height;

  const counter = (Math.trunc(seg.now * ((seg.speed >> 2) + 2)) & 0xffff) >> 8;

  const lightFactor = 0.15;
  const normalFactor = 0.4;

  const { fftResult } = sampleSyntheticAudio(seg.now);
  const base = fftResult[0] / 255;

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const faceColor = seg.color_wheel(counter & 0xff);
      const armsAndLegsBase =
        seg.color(1) > 0 ? seg.color(1) : AKEMI_DEFAULT_ARMS;
      let color = BLACK;
      const ak =
        AKEMI_BITMAP[
          Math.trunc((y * 32) / rows) * 32 + Math.trunc((x * 32) / cols)
        ];
      switch (ak) {
        case 3:
          color = scaleColorFloat(armsAndLegsBase, lightFactor);
          break;
        case 2:
          color = scaleColorFloat(armsAndLegsBase, normalFactor);
          break;
        case 1:
          color = armsAndLegsBase;
          break;
        case 6:
          color = scaleColorFloat(faceColor, lightFactor);
          break;
        case 5:
          color = scaleColorFloat(faceColor, normalFactor);
          break;
        case 4:
          color = faceColor;
          break;
        case 7:
          color = seg.color(2) > 0 ? seg.color(2) : WHITE;
          break;
        case 8:
          color =
            base > 0.4
              ? scaleColorFloat(AKEMI_ORANGE, base)
              : armsAndLegsBase;
          break;
        default:
          color = BLACK;
          break;
      }

      if (seg.intensity > 128 && fftResult[0] > 128) {
        seg.setPixelColorXY(x, 0, BLACK);
        seg.setPixelColorXY(x, y + 1, color);
      } else {
        seg.setPixelColorXY(x, y, color);
      }
    }
  }

  const xMax = Math.trunc(cols / 8);
  for (let x = 0; x < xMax; x++) {
    let band = map(x, 0, Math.max(xMax, 4), 0, 15);
    band = Math.min(Math.max(band, 0), 15);
    const barHeight = map(fftResult[band], 0, 255, 0, Math.trunc((17 * rows) / 32));
    const color = seg.color_from_palette(band * 35, false, false, 0);
    for (let y = 0; y < barHeight; y++) {
      seg.setPixelColorXY(x, Math.trunc(rows / 2) - y, color);
      seg.setPixelColorXY(cols - 1 - x, Math.trunc(rows / 2) - y, color);
    }
  }
}

// --- PS Spray (197) --------------------------------------------------------
function modeParticleSpray2D(seg: Segment2D): void {
  if (!seg.is2D()) return fallbackStatic(seg);
  const hardness = 200;
  let ps: ParticleSystem2D | null;
  if (seg.call === 0) {
    ps = initParticleSystem2D(seg, 1);
    if (!ps) return fallbackStatic(seg);
    ps.setKillOutOfBounds(true);
    ps.setBounceY(true);
    ps.setMotionBlur(200);
    ps.setSmearBlur(10);
    ps.sources[0].source.hue = seg.rng.random16();
    ps.sources[0].sourceFlags.collide = true;
    ps.sources[0].var = 3;
  } else {
    ps = getParticleSystem2D(seg);
  }
  if (!ps) return fallbackStatic(seg);

  ps.updateSystem();
  ps.setBounceX(!seg.check2);
  ps.setWrapX(seg.check2);
  ps.setWallHardness(hardness);
  ps.setGravity(seg.check1 ? 8 : 0);
  if (seg.check3) ps.enableParticleCollisions(true, hardness);
  else ps.enableParticleCollisions(false);

  ps.sources[0].source.x = map(seg.custom1, 0, 255, 0, ps.maxX);
  ps.sources[0].source.y = map(seg.custom2, 0, 255, 0, ps.maxY);
  const angle = (256 - ((seg.custom3 + 1) << 3)) << 8;

  // Firmware branches on whether the real AudioReactive usermod is present;
  // this sim has no such usermod, so it always takes the "AR data present"
  // branch, fed by the synthetic fixture instead.
  const { volumeSmth, volumeRaw } = sampleSyntheticAudio(seg.now);
  ps.sources[0].minLife = 30;

  if (
    seg.call % 20 === 0 ||
    seg.call % (11 - Math.trunc(volumeSmth / 25)) === 0
  ) {
    ps.sources[0].maxLife = (volumeSmth >> 1) + (seg.intensity >> 1);
    ps.sources[0].var = 1 + ((volumeRaw * seg.speed) >> 12);
    const emitspeed = (seg.speed >> 2) + (volumeRaw >> 3);
    ps.sources[0].source.hue =
      (ps.sources[0].source.hue + Math.trunc(volumeSmth / 30)) & 0xff;
    ps.angleEmit(ps.sources[0], angle, emitspeed);
  }

  ps.update();
}

// --- PS GEQ 2D (198) -------------------------------------------------------
function modeParticleGeq2D(seg: Segment2D): void {
  if (!seg.is2D()) return fallbackStatic(seg);
  let ps: ParticleSystem2D | null;
  if (seg.call === 0) {
    ps = initParticleSystem2D(seg, 1);
    if (!ps) return fallbackStatic(seg);
    ps.setKillOutOfBounds(true);
    ps.setUsedParticles(170);
  } else {
    ps = getParticleSystem2D(seg);
  }
  if (!ps) return fallbackStatic(seg);

  ps.updateSystem();
  ps.setWrapX(seg.check1);
  ps.setBounceX(seg.check2);
  ps.setBounceY(seg.check3);
  ps.setWallHardness(seg.custom2);
  ps.setGravity(seg.custom3 << 2);

  const { fftResult } = sampleSyntheticAudio(seg.now);

  let i = 0;
  const binwidth = (ps.maxX + 1) >> 4;
  const threshold = 300 - seg.intensity;

  for (let bin = 0; bin < 16; bin++) {
    const xposition = binwidth * bin + (binwidth >> 1);
    const emitspeed = (fftResult[bin] * seg.speed) >> 9;
    let emitparticles = 0;

    if (fftResult[bin] > threshold) {
      emitparticles = 1;
    } else if (fftResult[bin] > 0) {
      const restvolume = ((threshold - fftResult[bin]) >> 2) + 2;
      if (seg.rng.random16() % restvolume === 0) emitparticles = 1;
    }

    while (i < ps.usedParticles && emitparticles > 0) {
      if (ps.particles[i].ttl === 0) {
        ps.particles[i].ttl =
          20 +
          map(
            seg.intensity,
            0,
            255,
            emitspeed >> 1,
            emitspeed + seg.rng.random16(emitspeed),
          );
        ps.particles[i].x =
          xposition + seg.rng.random16(binwidth) - (binwidth >> 1);
        ps.particles[i].y = 0;
        ps.particles[i].vx =
          seg.rng.random16(seg.custom1 >> 1) - (seg.custom1 >> 2);
        ps.particles[i].vy = emitspeed;
        ps.particles[i].hue = (bin << 4) + seg.rng.random16(17) - 8;
        emitparticles--;
      }
      i++;
    }
  }

  ps.update();
}

// --- PS GEQ Nova (199) -----------------------------------------------------
const NOVA_SOURCES = 16;

function modeParticleGeqNova2D(seg: Segment2D): void {
  if (!seg.is2D()) return fallbackStatic(seg);
  let ps: ParticleSystem2D | null;
  let numSprays: number;
  if (seg.call === 0) {
    ps = initParticleSystem2D(seg, NOVA_SOURCES);
    if (!ps) return fallbackStatic(seg);
    numSprays = Math.min(ps.numSources, NOVA_SOURCES);
    for (let i = 0; i < numSprays; i++) {
      ps.sources[i].source.x = (ps.maxX + 1) >> 1;
      ps.sources[i].source.y = (ps.maxY + 1) >> 1;
      ps.sources[i].source.hue = i * 16;
      ps.sources[i].maxLife = 400;
      ps.sources[i].minLife = 200;
    }
    ps.setKillOutOfBounds(true);
  } else {
    ps = getParticleSystem2D(seg);
  }
  if (!ps) return fallbackStatic(seg);

  ps.updateSystem();
  numSprays = Math.min(ps.numSources, NOVA_SOURCES);

  const { fftResult } = sampleSyntheticAudio(seg.now);
  const threshold = 300 - seg.intensity;

  if (seg.check2) seg.aux0 = (seg.aux0 + (seg.custom1 << 2)) & 0xffff;
  else seg.aux0 = (seg.aux0 - (seg.custom1 << 2)) & 0xffff;

  const angleoffset = Math.trunc(0xffff / numSprays);
  let j = seg.rng.random16(numSprays);
  for (let i = 0; i < numSprays; i++) {
    if (seg.custom2 > 0 && seg.call % (32 - (seg.custom2 >> 3)) === 0) {
      ps.sources[j].source.hue =
        (ps.sources[j].source.hue + 1 + (seg.custom2 >> 4)) & 0xff;
    }

    ps.sources[j].var = seg.custom3 >> 2;
    const emitspeed = 5 + ((fftResult[j] * (seg.speed + 20)) >> 10);
    const emitangle = (j * angleoffset + seg.aux0) & 0xffff;

    let emitparticles = 0;
    if (fftResult[j] > threshold) {
      emitparticles = 1;
    } else if (fftResult[j] > 0) {
      const restvolume = ((threshold - fftResult[j]) >> 2) + 2;
      if (seg.rng.random16() % restvolume === 0) emitparticles = 1;
    }
    if (emitparticles) ps.angleEmit(ps.sources[j], emitangle, emitspeed);

    j = (j + 1) % numSprays;
  }

  ps.update();
}

// --- PS Blobs (201) --------------------------------------------------------
function modeParticleBlobs2D(seg: Segment2D): void {
  if (!seg.is2D()) return fallbackStatic(seg);
  let ps: ParticleSystem2D | null;
  if (seg.call === 0) {
    ps = initParticleSystem2D(seg, 0, true, true); // advanced + size control
    if (!ps) return fallbackStatic(seg);
    ps.setBounceX(true);
    ps.setBounceY(true);
    ps.setWallHardness(255);
    ps.setWallRoughness(255);
    ps.setCollisionHardness(255);
    ps.perParticleSize = true;
  } else {
    ps = getParticleSystem2D(seg);
  }
  if (!ps) return fallbackStatic(seg);

  ps.updateSystem();
  ps.setUsedParticles(map(seg.intensity, 0, 255, 25, 128));
  ps.enableParticleCollisions(seg.check2);

  for (let i = 0; i < ps.usedParticles; i++) {
    const p = ps.particles[i];
    if (seg.aux0 !== seg.speed || p.ttl === 0) {
      p.vx = seg.rng.random16(seg.speed >> 1) - (seg.speed >> 2);
      p.vy = seg.rng.random16(seg.speed >> 1) - (seg.speed >> 2);
    }
    if (ps.advPartSize && (seg.aux1 !== seg.custom1 || p.ttl === 0)) {
      ps.advPartSize[i].maxsize =
        60 + (seg.custom1 >> 1) + seg.rng.random16(seg.custom1 >> 2);
    }

    if (p.ttl === 0) {
      p.ttl = 300 + seg.rng.random16((seg.custom2 << 3) + 100);
      // hw_random() has no direct counterpart (32-bit, vs. this PRNG's
      // random16); maxX/maxY comfortably fit 16 bits, so random16 substitutes.
      p.x = seg.rng.random16(ps.maxX);
      p.y = seg.rng.random16(ps.maxY);
      p.hue = seg.rng.random16() & 0xff;
      ps.particleFlags[i].collide = true;
      if (ps.advPartProps) ps.advPartProps[i].size = 0;
      if (ps.advPartSize) {
        ps.advPartSize[i].asymmetry = seg.rng.random16(220);
        ps.advPartSize[i].asymdir = seg.rng.random16(255);
        ps.advPartSize[i].grow = true;
        ps.advPartSize[i].growspeed = 1 + seg.rng.random16(9);
        ps.advPartSize[i].shrinkspeed = 1 + seg.rng.random16(9);
        ps.advPartSize[i].wobblespeed = 1 + seg.rng.random16(3);
      }
    }
    if (ps.advPartSize) {
      ps.advPartSize[i].pulsate = seg.check3;
      ps.advPartSize[i].wobble = seg.check1;
    }
  }
  seg.aux0 = seg.speed;
  seg.aux1 = seg.custom1;

  const { volumeSmth } = sampleSyntheticAudio(seg.now);
  if (seg.check3 && ps.advPartProps) {
    for (let i = 0; i < ps.usedParticles; i++) {
      ps.advPartProps[i].size = volumeSmth;
    }
  }

  ps.setMotionBlur((seg.custom3 << 3) + 7);
  ps.update();
}

// === Audio-reactive 1D effects ===============================================
// Same standing rule as the 2D set above: this sim performs no audio analysis,
// so every body here reads sampleSyntheticAudio() (audio-fixture.ts) in place of
// WLED's um_data and always takes the firmware's "audio present" branch.
//
// Three firmware conventions recur across this block and are explained only here:
//
// * `*binNum = SEGMENT.custom1` / `*maxVol = SEGMENT.custom2 / 2` (FX.cpp:6676,
//   7141, 7511) write back *into the usermod*, and the matching call-0 reads
//   restore the sliders from it. With no usermod there is no other end to that
//   round-trip, so those lines are no-ops and are omitted. Worth noting what
//   that implies: Ripple Peak / Puddlepeak / Waterfall never read custom1 or
//   custom2 anywhere else, so their "Select bin" / "Volume (min)" sliders do
//   nothing to the rendered output in firmware either -- they only talk to the
//   analyser. Nothing is lost by dropping them.
// * `micros()` -> `seg.now * 1000`; this sim has only ms resolution, matching
//   the Funky Plank port above. The uint32 micros() rollover is not emulated.
// * `hw_random*()` -> `seg.rng.*`, as everywhere else in this file.

/** Nyquist limit for WLED's 22kHz sampling, and its log10 -- FX.cpp:78-79. */
const MAX_FREQUENCY = 11025;
const MAX_FREQ_LOG10 = 4.04238;
const GRAY = 0x808080; // CRGB::Gray (fastled_slim.h:453)

/**
 * float -> unsigned the way the ESP32 toolchain does it: negatives saturate to
 * 0 (`__fixunssfsi`) rather than wrapping as an x86 build would. Several of
 * these bodies feed a log10 term that goes negative below ~60 Hz straight into
 * an `unsigned`, so the choice is visible on screen, not academic.
 */
function fToUnsigned(v: number): number {
  return v < 0 ? 0 : Math.trunc(v);
}

/** float -> uint8_t: fToUnsigned plus the narrowing the C++ assignment does. */
function fToU8(v: number): number {
  return fToUnsigned(v) & 0xff;
}

/** Integer square root -- wled_math.cpp sqrt32_bw (exact, so Math.sqrt matches). */
function sqrt32bw(v: number): number {
  return Math.trunc(Math.sqrt(Math.max(0, v)));
}

// --- Pixels (128) ------------------------------------------------------------
// mode_pixels (FX.cpp:7174): a 32-deep ring of volume samples, sprayed onto
// random pixels. Firmware indexes the ring by `strip.now % 32`, which at 42fps
// skips most slots -- its own comment calls this "filling values semi randomly".
function modePixels(seg: Segment): void {
  if (seg.length <= 1) return fallbackStatic(seg);
  const myVals = seg.allocateData(32);
  const { volumeSmth } = sampleSyntheticAudio(seg.now);

  myVals[seg.now % 32] = volumeSmth & 0xff;

  seg.fade_out(64 + (seg.speed >> 1));

  for (let i = 0; i < Math.trunc(seg.intensity / 8); i++) {
    const segLoc = seg.rng.random16(seg.length);
    seg.setPixelColor(
      segLoc,
      color_blend(
        seg.color(1),
        seg.color_from_palette(myVals[i % 32] + i * 4, false, false, 0),
        volumeSmth & 0xff,
      ),
    );
  }
}

// --- Pixelwave (129) ---------------------------------------------------------
// mode_pixelwave (FX.cpp:7062): a volume-lit pixel injected at the centre, with
// both halves shifting outward.
function modePixelwave(seg: Segment): void {
  if (seg.length <= 1) return fallbackStatic(seg);
  if (seg.call === 0) seg.fill(BLACK);

  const { volumeRaw } = sampleSyntheticAudio(seg.now);

  // `micros()/(256-speed)/500+1 % 16`: `%` binds tighter than `+`, so the
  // `% 16` applies to the literal 1 and the whole term reduces to `+1`. Same
  // precedence quirk as Funky Plank; preserved rather than "fixed".
  const usNow = seg.now * 1000;
  const secondHand =
    (Math.trunc(Math.trunc(usNow / (256 - seg.speed)) / 500) + 1) & 0xff;
  if (seg.aux0 !== secondHand) {
    seg.aux0 = secondHand;

    const pixBri = Math.trunc((volumeRaw * seg.intensity) / 64) & 0xff;
    const half = Math.trunc(seg.length / 2);

    seg.setPixelColor(
      half,
      color_blend(
        seg.color(1),
        seg.color_from_palette(seg.now, false, false, 0),
        pixBri,
      ),
    );
    for (let i = seg.length - 1; i > half; i--)
      seg.setPixelColor(i, seg.getPixelColor(i - 1));
    for (let i = 0; i < half; i++)
      seg.setPixelColor(i, seg.getPixelColor(i + 1));
  }
}

// --- Juggles (130) -----------------------------------------------------------
// mode_juggles (FX.cpp:6925): beatsin-driven dots, brightness = volume.
function modeJuggles(seg: Segment): void {
  const { volumeSmth } = sampleSyntheticAudio(seg.now);

  seg.fade_out(224); // 6.25%
  const mySampleAgc = Math.max(0, Math.min(volumeSmth, 255));

  for (let i = 0; i < Math.trunc(seg.intensity / 32) + 1; i++) {
    seg.setPixelColor(
      beatsin16_t(Math.trunc(seg.speed / 4) + i * 2, seg.now, 0, seg.length - 1),
      color_blend(
        seg.color(1),
        seg.color_from_palette(
          Math.trunc(seg.now / 4) + i * 2,
          false,
          false,
          0,
        ),
        mySampleAgc,
      ),
    );
  }
}

// --- Matripix (131) ----------------------------------------------------------
// mode_matripix (FX.cpp:6943): a volume-lit pixel pushed in at the right end,
// the whole strip shifting left. Firmware keeps its own uint32 shadow buffer in
// SEGENV.data; here that is a per-Segment Uint32Array (SEGENV.data is a byte
// array in this sim), same as the 2D GEQ port's peak-height store.
const matripixPixels = new WeakMap<Segment, Uint32Array>();

function modeMatripix(seg: Segment): void {
  let pixels = matripixPixels.get(seg);
  if (!pixels || pixels.length !== seg.length) {
    pixels = new Uint32Array(seg.length);
    matripixPixels.set(seg, pixels);
  }

  const { volumeRaw } = sampleSyntheticAudio(seg.now);

  if (seg.call === 0) pixels.fill(BLACK);

  const usNow = seg.now * 1000;
  const secondHand =
    Math.trunc(Math.trunc(usNow / (256 - seg.speed)) / 500) % 16;
  if (seg.aux0 !== secondHand) {
    seg.aux0 = secondHand;

    // firmware keeps pixBri in an `int` and lets color_blend's uint8_t
    // parameter narrow it, so a loud sample at high Brightness wraps.
    const pixBri = Math.trunc((volumeRaw * seg.intensity) / 64) & 0xff;
    const k = seg.length - 1;
    for (let i = 0; i < k; i++) {
      pixels[i] = pixels[i + 1];
      seg.setPixelColor(i, pixels[i]);
    }
    pixels[k] = color_blend(
      seg.color(1),
      seg.color_from_palette(seg.now, false, false, 0),
      pixBri,
    );
    seg.setPixelColor(k, pixels[k]);
  }
}

// --- Gravcenter family (132 / 156 / 157 / 158) -------------------------------
// mode_gravcenter_base (FX.cpp:6807): one body behind four effects, merged
// upstream by @dedehai. mode 0 Gravcenter, 1 Gravcentric, 2 Gravimeter,
// 3 Gravfreq -- registered as four wrappers below, exactly as firmware does.
interface GravityState {
  topLED: number;
  gravityCounter: number;
}
const gravcenterState = new WeakMap<Segment, GravityState>();

function modeGravcenterBase(seg: Segment, mode: number): void {
  if (seg.length === 1) return fallbackStatic(seg);

  let grav = gravcenterState.get(seg);
  if (!grav) {
    grav = { topLED: 0, gravityCounter: 0 };
    gravcenterState.set(seg, grav);
  }

  const { volumeSmth, fftMajorPeak } = sampleSyntheticAudio(seg.now);

  if (mode === 1) seg.fade_out(253);
  else if (mode === 2) seg.fade_out(249);
  else if (mode === 3) seg.fade_out(250);
  else seg.fade_out(251);

  const half = Math.trunc(seg.length / 2);
  let mySampleAvg: number;
  let tempsamp: number;
  let segmentSampleAvg = (volumeSmth * seg.intensity) / 255;

  if (mode === 2) {
    // Gravimeter
    segmentSampleAvg *= 0.25;
    mySampleAvg = mapf(segmentSampleAvg * 2, 0, 64, 0, seg.length - 1);
    tempsamp = Math.trunc(
      Math.min(Math.max(mySampleAvg, 0), seg.length - 1),
    );
  } else {
    segmentSampleAvg *= 0.125;
    // note the float halving here vs the integer `SEGLEN/2` in the constrain
    mySampleAvg = mapf(segmentSampleAvg * 2, 0, 32, 0, seg.length / 2);
    tempsamp = Math.trunc(Math.min(Math.max(mySampleAvg, 0), half));
  }

  const gravity = 8 - Math.trunc(seg.speed / 32); // 1..8, never 0
  const offset = mode === 2 ? 0 : 1;
  if (tempsamp >= grav.topLED) grav.topLED = tempsamp - offset;
  else if (grav.gravityCounter % gravity === 0) grav.topLED--;

  if (mode === 1) {
    // Gravcentric
    for (let i = 0; i < tempsamp; i++) {
      const index = fToU8(segmentSampleAvg * 24 + Math.trunc(seg.now / 200));
      seg.setPixelColor(
        i + half,
        seg.color_from_palette(index, false, false, 0),
      );
      seg.setPixelColor(
        half - 1 - i,
        seg.color_from_palette(index, false, false, 0),
      );
    }
    if (grav.topLED >= 0) {
      seg.setPixelColor(grav.topLED + half, GRAY);
      seg.setPixelColor(half - 1 - grav.topLED, GRAY);
    }
  } else if (mode === 2) {
    // Gravimeter
    for (let i = 0; i < tempsamp; i++) {
      const index = perlin8(
        Math.trunc(i * segmentSampleAvg + seg.now) & 0xffff,
        Math.trunc(5000 + i * segmentSampleAvg) & 0xffff,
      );
      seg.setPixelColor(
        i,
        color_blend(
          seg.color(1),
          seg.color_from_palette(index, false, false, 0),
          fToU8(segmentSampleAvg * 8),
        ),
      );
    }
    if (grav.topLED > 0) {
      seg.setPixelColor(
        grav.topLED,
        seg.color_from_palette(seg.now, false, false, 0),
      );
    }
  } else if (mode === 3) {
    // Gravfreq
    for (let i = 0; i < tempsamp; i++) {
      const peak = fftMajorPeak < 1 ? 1 : fftMajorPeak;
      const index = fToU8(
        (Math.log10(peak) - (MAX_FREQ_LOG10 - 1.78)) * 255,
      );
      seg.setPixelColor(
        i + half,
        seg.color_from_palette(index, false, false, 0),
      );
      seg.setPixelColor(
        half - i - 1,
        seg.color_from_palette(index, false, false, 0),
      );
    }
    if (grav.topLED >= 0) {
      seg.setPixelColor(grav.topLED + half, GRAY);
      seg.setPixelColor(half - 1 - grav.topLED, GRAY);
    }
  } else {
    // Gravcenter
    for (let i = 0; i < tempsamp; i++) {
      const index = perlin8(
        Math.trunc(i * segmentSampleAvg + seg.now) & 0xffff,
        Math.trunc(5000 + i * segmentSampleAvg) & 0xffff,
      );
      const col = color_blend(
        seg.color(1),
        seg.color_from_palette(index, false, false, 0),
        fToU8(segmentSampleAvg * 8),
      );
      seg.setPixelColor(i + half, col);
      seg.setPixelColor(half - i - 1, col);
    }
    if (grav.topLED >= 0) {
      const col = seg.color_from_palette(seg.now, false, false, 0);
      seg.setPixelColor(grav.topLED + half, col);
      seg.setPixelColor(half - 1 - grav.topLED, col);
    }
  }

  grav.gravityCounter = (grav.gravityCounter + 1) % gravity;
}

function modeGravcenter(seg: Segment): void {
  modeGravcenterBase(seg, 0);
}
function modeGravcentric(seg: Segment): void {
  modeGravcenterBase(seg, 1);
}
function modeGravimeter(seg: Segment): void {
  modeGravcenterBase(seg, 2);
}
function modeGravfreq(seg: Segment): void {
  modeGravcenterBase(seg, 3);
}

// --- Plasmoid (133) ----------------------------------------------------------
// mode_plasmoid (FX.cpp:7095): two drifting phases make a plasma; volume gates
// which pixels survive.
interface PlasPhase {
  thisphase: number;
  thatphase: number;
}
const plasmoidState = new WeakMap<Segment, PlasPhase>();

function modePlasmoid(seg: Segment): void {
  let plas = plasmoidState.get(seg);
  if (!plas) {
    plas = { thisphase: 0, thatphase: 0 };
    plasmoidState.set(seg, plas);
  }

  const { volumeSmth } = sampleSyntheticAudio(seg.now);

  seg.fadeToBlackBy(32);

  // Firmware calls beatsin8_t(6,-4,4): `lowest` is a uint8_t parameter, so -4
  // arrives as 252 and the uint8 result lands in {252..255, 0..4} -- added to
  // an int16 phase that is only ever used mod 256, where 252 == -4. This sim's
  // beatsin8_t returns the signed -4..4 directly, which is the same value mod
  // 256, so the animation matches; the int16 accumulator is kept wrapping.
  plas.thisphase =
    ((plas.thisphase + beatsin8_t(6, seg.now, -4, 4)) << 16) >> 16;
  plas.thatphase =
    ((plas.thatphase + beatsin8_t(7, seg.now, -4, 4)) << 16) >> 16;

  for (let i = 0; i < seg.length; i++) {
    let thisbright =
      cubicwave8(
        (i * (1 + Math.trunc((3 * seg.speed) / 32)) + plas.thisphase) & 0xff,
      ) >> 1;
    thisbright =
      (thisbright +
        (cos8(
          (i * (97 + Math.trunc((5 * seg.speed) / 32)) + plas.thatphase) & 0xff,
        ) >>
          1)) &
      0xff;

    const colorIndex = thisbright;
    if ((volumeSmth * seg.intensity) / 64 < thisbright) thisbright = 0;

    seg.addPixelColor(
      i,
      color_blend(
        seg.color(1),
        seg.color_from_palette(colorIndex, false, false, 0),
        thisbright,
      ),
    );
  }
}

// --- Puddles (134) / Puddlepeak (144) ----------------------------------------
// mode_puddles_base (FX.cpp:7126): one body, two effects (merged by @dedehai).
// Puddles sizes its flash from raw volume every frame; Puddlepeak only flashes
// on a detected beat and sizes it from smoothed volume.
function modePuddlesBase(seg: Segment, peakdetect: boolean): void {
  if (seg.length <= 1) return fallbackStatic(seg);

  let size = 0;
  const fadeVal = map(seg.speed, 0, 255, 224, 254);
  const pos = seg.rng.random16(seg.length);
  seg.fade_out(fadeVal);

  const { volumeRaw, volumeSmth, samplePeak } = sampleSyntheticAudio(seg.now);

  if (peakdetect) {
    // volumeSmth is a float upstream, so this whole expression is float and
    // only truncates on assignment to `unsigned size`...
    if (samplePeak) {
      size = Math.trunc((volumeSmth * seg.intensity) / 256 / 4 + 1);
      if (pos + size >= seg.length) size = seg.length - pos;
    }
  } else {
    // ...whereas volumeRaw is an `int`, so this one truncates at every step.
    if (volumeRaw > 1) {
      size = Math.trunc(Math.trunc((volumeRaw * seg.intensity) / 256) / 8) + 1;
      if (pos + size >= seg.length) size = seg.length - pos;
    }
  }

  for (let i = 0; i < size; i++) {
    seg.setPixelColor(
      pos + i,
      seg.color_from_palette(seg.now, false, false, 0),
    );
  }
}

function modePuddles(seg: Segment): void {
  modePuddlesBase(seg, false);
}
function modePuddlepeak(seg: Segment): void {
  modePuddlesBase(seg, true);
}

// --- Midnoise (135) ----------------------------------------------------------
// mode_midnoise (FX.cpp:6977): a noise bar growing outward from the centre.
function modeMidnoise(seg: Segment): void {
  if (seg.length <= 1) return fallbackStatic(seg);

  const { volumeSmth } = sampleSyntheticAudio(seg.now);

  seg.fade_out(seg.speed);
  seg.fade_out(seg.speed);

  let tmpSound2 = (volumeSmth * seg.intensity) / 256; // "Too sensitive."
  tmpSound2 *= seg.intensity / 128; // "Reduce sensitivity/length."

  const half = Math.trunc(seg.length / 2);
  // `SEGLEN/2` is unsigned integer division here, unlike Gravcenter's `(float)`
  let maxLen = fToUnsigned(mapf(tmpSound2, 0, 127, 0, half));
  if (maxLen > half) maxLen = half;

  for (let i = half - maxLen; i < half + maxLen; i++) {
    const index = perlin8(
      Math.trunc(i * volumeSmth + seg.aux0) & 0xffff,
      Math.trunc(seg.aux1 + i * volumeSmth) & 0xffff,
    );
    seg.setPixelColor(i, seg.color_from_palette(index, false, false, 0));
  }

  seg.aux0 = (seg.aux0 + beatsin8_t(5, seg.now, 0, 10)) & 0xffff;
  seg.aux1 = (seg.aux1 + beatsin8_t(4, seg.now, 0, 10)) & 0xffff;
}

// --- Noisemeter (136) --------------------------------------------------------
// mode_noisemeter (FX.cpp:7033): the same noise bar, but anchored at pixel 0
// and driven by raw volume.
function modeNoisemeter(seg: Segment): void {
  const { volumeSmth, volumeRaw } = sampleSyntheticAudio(seg.now);

  const fadeRate = map(seg.speed, 0, 255, 200, 254);
  seg.fade_out(fadeRate);

  const tmpSound2 = (volumeRaw * 2 * seg.intensity) / 255;
  let maxLen = fToUnsigned(mapf(tmpSound2, 0, 255, 0, seg.length));
  // firmware's `if (maxLen < 0)` is dead code -- maxLen is unsigned (FX.cpp:7045)
  if (maxLen > seg.length) maxLen = seg.length;

  for (let i = 0; i < maxLen; i++) {
    const index = perlin8(
      Math.trunc(i * volumeSmth + seg.aux0) & 0xffff,
      Math.trunc(seg.aux1 + i * volumeSmth) & 0xffff,
    );
    seg.setPixelColor(i, seg.color_from_palette(index, false, false, 0));
  }

  seg.aux0 = (seg.aux0 + beatsin8_t(5, seg.now, 0, 10)) & 0xffff;
  seg.aux1 = (seg.aux1 + beatsin8_t(4, seg.now, 0, 10)) & 0xffff;
}

// --- Freqwave (137) ----------------------------------------------------------
// mode_freqwave (FX.cpp:7385): major peak -> hue, volume -> value, injected at
// the centre and shifted outward. Deliberately bypasses the palette (HSV wheel).
function modeFreqwave(seg: Segment): void {
  const { fftMajorPeak, volumeSmth } = sampleSyntheticAudio(seg.now);

  if (seg.call === 0) seg.fill(BLACK);

  const usNow = seg.now * 1000;
  const secondHand =
    Math.trunc(Math.trunc(usNow / (256 - seg.speed)) / 500) % 16;
  if (seg.aux0 !== secondHand) {
    seg.aux0 = secondHand;

    const sensitivity = mapf(seg.custom3, 1, 31, 1, 10);
    const pixVal = Math.min(
      255,
      ((volumeSmth * seg.intensity) / 256) * sensitivity,
    );
    const intensity = mapf(pixVal, 0, 255, 0, 100) / 100;

    let color = BLACK;
    let peak = fftMajorPeak;
    if (peak > MAX_FREQUENCY) peak = 1;

    if (peak < 80) {
      color = BLACK;
    } else {
      const upperLimit = 80 + 42 * seg.custom2;
      const lowerLimit = 80 + 3 * seg.custom1;
      // at the defaults (custom1 == custom2 == 0) the limits are equal, so the
      // firmware falls through to using the raw frequency as the hue byte
      const i =
        lowerLimit !== upperLimit
          ? map(Math.trunc(peak), lowerLimit, upperLimit, 0, 255) & 0xff
          : fToU8(peak);
      const b = Math.min(255, fToUnsigned(255 * intensity));
      color = hsv2rgb_rainbow(i << 8, 240, b);
    }

    const half = Math.trunc(seg.length / 2);
    seg.setPixelColor(half, color);
    for (let i = seg.length - 1; i > half; i--)
      seg.setPixelColor(i, seg.getPixelColor(i - 1));
    for (let i = 0; i < half; i++)
      seg.setPixelColor(i, seg.getPixelColor(i + 1));
  }
}

// --- Freqmatrix (138) --------------------------------------------------------
// mode_freqmatrix (FX.cpp:7291): Freqwave's sibling -- same colouring, but the
// pixel is injected at index 0 and the strip shifts one way only.
function modeFreqmatrix(seg: Segment): void {
  const { fftMajorPeak, volumeSmth } = sampleSyntheticAudio(seg.now);

  if (seg.call === 0) seg.fill(BLACK);

  const usNow = seg.now * 1000;
  const secondHand =
    Math.trunc(Math.trunc(usNow / (256 - seg.speed)) / 500) % 16;
  if (seg.aux0 !== secondHand) {
    seg.aux0 = secondHand;

    const sensitivity = map(seg.custom3, 0, 31, 1, 10);
    let pixVal = Math.trunc(
      (volumeSmth * seg.intensity * sensitivity) / 256,
    );
    if (pixVal > 255) pixVal = 255;

    // integer map() first, then the float division -- not mapf
    const intensity = map(pixVal, 0, 255, 0, 100) / 100;

    let color = BLACK;
    let peak = fftMajorPeak;
    if (peak > MAX_FREQUENCY) peak = 1;

    if (peak < 80) {
      color = BLACK;
    } else {
      const upperLimit = 80 + 42 * seg.custom2;
      const lowerLimit = 80 + 3 * seg.custom1;
      const i =
        lowerLimit !== upperLimit
          ? map(Math.trunc(peak), lowerLimit, upperLimit, 0, 255) & 0xff
          : fToU8(peak);
      let b = fToUnsigned(255 * intensity);
      if (b > 255) b = 255;
      color = hsv2rgb_rainbow(i << 8, 240, b);
    }

    seg.setPixelColor(0, color);
    for (let i = seg.length - 1; i > 0; i--)
      seg.setPixelColor(i, seg.getPixelColor(i - 1));
  }
}

// --- Waterfall (140) ---------------------------------------------------------
// mode_waterfall (FX.cpp:7489): peak detection combined with major peak and
// magnitude, scrolling left. Same uint32 shadow buffer as Matripix.
const waterfallPixels = new WeakMap<Segment, Uint32Array>();

function modeWaterfall(seg: Segment): void {
  let pixels = waterfallPixels.get(seg);
  if (!pixels || pixels.length !== seg.length) {
    pixels = new Uint32Array(seg.length);
    waterfallPixels.set(seg, pixels);
  }

  const { samplePeak, fftMajorPeak, myMagnitude } = sampleSyntheticAudio(
    seg.now,
  );
  const magnitude = myMagnitude / 8;
  const peak = fftMajorPeak < 1 ? 1 : fftMajorPeak;

  if (seg.call === 0) {
    pixels.fill(BLACK);
    seg.aux0 = 255;
  }

  const usNow = seg.now * 1000;
  const secondHand =
    (Math.trunc(Math.trunc(usNow / (256 - seg.speed)) / 500) + 1) & 0xff;
  if (seg.aux0 !== secondHand) {
    seg.aux0 = secondHand;

    let pixCol = fToU8((Math.log10(peak) - 2.26) * 150);
    if (peak < 182) pixCol = 0; // handle underflow

    const k = seg.length - 1;
    if (samplePeak) {
      pixels[k] = hsv2rgb_rainbow(92 << 8, 92, 92);
    } else {
      pixels[k] = color_blend(
        seg.color(1),
        seg.color_from_palette(pixCol + seg.intensity, false, false, 0),
        fToU8(magnitude),
      );
    }
    seg.setPixelColor(k, pixels[k]);
    for (let i = 0; i < k; i++) {
      pixels[i] = pixels[i + 1];
      seg.setPixelColor(i, pixels[i]);
    }
  }
}

// --- Freqpixels (141) --------------------------------------------------------
// mode_freqpixels (FX.cpp:7345): random pixels coloured by the major peak,
// brightness from its magnitude.
function modeFreqpixels(seg: Segment): void {
  const { fftMajorPeak, myMagnitude } = sampleSyntheticAudio(seg.now);
  const magnitude = myMagnitude / 16;
  const peak = fftMajorPeak < 1 ? 1 : fftMajorPeak;

  let fadeRate = seg.speed * seg.speed;
  fadeRate = map(fadeRate, 0, 65535, 1, 255);

  const fadeoutDelay = Math.trunc((256 - seg.speed) / 64);
  if (fadeoutDelay <= 1 || seg.call % fadeoutDelay === 0) seg.fade_out(fadeRate);

  let pixCol = fToU8(((Math.log10(peak) - 1.78) * 255) / (MAX_FREQ_LOG10 - 1.78));
  if (peak < 61) pixCol = 0; // handle underflow

  for (let i = 0; i < Math.trunc(seg.intensity / 32) + 1; i++) {
    const locn = seg.rng.random16(0, seg.length);
    seg.setPixelColor(
      locn,
      color_blend(
        seg.color(1),
        seg.color_from_palette(seg.intensity + pixCol, false, false, 0),
        fToU8(magnitude),
      ),
    );
  }
}

// --- Noisefire (143) ---------------------------------------------------------
// mode_noisefire (FX.cpp:7008): volume-reactive fire on its own hard-coded fire
// palette, ignoring the segment palette entirely.
// prettier-ignore
const NOISEFIRE_PALETTE: RGB[] = [
  unpack(hsv2rgb_rainbow(0, 255, 2)),  unpack(hsv2rgb_rainbow(0, 255, 4)),
  unpack(hsv2rgb_rainbow(0, 255, 8)),  unpack(hsv2rgb_rainbow(0, 255, 8)),
  unpack(hsv2rgb_rainbow(0, 255, 16)), unpack(0xff0000), // CRGB::Red
  unpack(0xff0000),                    unpack(0xff0000),
  unpack(0xff8c00),                    unpack(0xff8c00), // CRGB::DarkOrange
  unpack(0xffa500),                    unpack(0xffa500), // CRGB::Orange
  unpack(0xffff00),                    unpack(0xffa500), // CRGB::Yellow
  unpack(0xffff00),                    unpack(0xffff00),
];

function modeNoisefire(seg: Segment): void {
  const { volumeSmth } = sampleSyntheticAudio(seg.now);

  if (seg.call === 0) seg.fill(BLACK);

  for (let i = 0; i < seg.length; i++) {
    let index = perlin8(
      Math.trunc((i * seg.speed) / 64) & 0xffff,
      // uint32 on device, so fold at each multiply -- masking only at the end
      // can't recover bits that were never wrapped (cf. modeNoisemove)
      Math.trunc(
        ((Math.trunc(((seg.now * seg.speed) >>> 0) / 64) * seg.length) >>> 0) /
          255,
      ) & 0xffff,
    );
    // scale so it darkens toward both ends; `256 - intensity` is never 0
    index = Math.trunc(
      ((255 - Math.trunc((i * 256) / seg.length)) * index) /
        (256 - seg.intensity),
    );

    seg.setPixelColor(
      i,
      colorFromPalette(
        NOISEFIRE_PALETTE,
        index & 0xff,
        // volumeSmth*2 overflows the uint8_t brightness parameter above 127
        fToU8(volumeSmth * 2),
        LINEARBLEND,
      ),
    );
  }
}

// --- Noisemove (145) ---------------------------------------------------------
// mode_noisemove (FX.cpp:7434): one pixel per FFT bin, positioned by 16-bit
// Perlin noise. `perlin16(x, y)` is this sim's inoise16xy.
function modeNoisemove(seg: Segment): void {
  const { fftResult } = sampleSyntheticAudio(seg.now);

  const fadeoutDelay = Math.trunc((256 - seg.speed) / 96);
  if (fadeoutDelay <= 1 || seg.call % fadeoutDelay === 0)
    seg.fadeToBlackBy(4 + Math.trunc(seg.speed / 4));

  const numBins = map(seg.intensity, 0, 255, 0, 16);
  for (let i = 0; i < numBins; i++) {
    const t = (seg.now * seg.speed) >>> 0; // uint32, as on device
    let locn = inoise16xy((t + i * 50000) >>> 0, t);
    // may land outside the strip; setPixelColor drops it, as firmware's
    // unsigned wrap does
    locn = map(locn, 7500, 58000, 0, seg.length - 1);
    seg.setPixelColor(
      locn,
      color_blend(
        seg.color(1),
        seg.color_from_palette(i * 64, false, false, 0),
        (fftResult[i % 16] * 4) & 0xff,
      ),
    );
  }
}

// --- Ripple Peak (148) -------------------------------------------------------
// mode_ripplepeak (FX.cpp:6652): each detected beat launches a ripple that
// spreads outward over 16 steps. Colour comes from log10 of the major peak.
interface Ripple1D {
  state: number;
  color: number;
  pos: number;
}
const ripplePeakState = new WeakMap<Segment, Ripple1D[]>();

function modeRipplePeak(seg: Segment): void {
  const MAXSTEPS = 16;
  const maxRipples = 16;

  let ripples = ripplePeakState.get(seg);
  if (!ripples) {
    ripples = Array.from({ length: maxRipples }, () => ({
      state: 0,
      color: 0,
      pos: 0,
    }));
    ripplePeakState.set(seg, ripples);
  }

  const { samplePeak, fftMajorPeak } = sampleSyntheticAudio(seg.now);

  seg.fade_out(240); // twice: "lower frame rate means less effective fading"
  seg.fade_out(240);

  for (let i = 0; i < Math.trunc(seg.intensity / 16); i++) {
    const r = ripples[i];
    if (samplePeak) r.state = 255;

    switch (r.state) {
      case 254: // inactive
        break;
      case 255: // initialize
        r.pos = seg.rng.random16(seg.length);
        r.color = fftMajorPeak > 1 ? Math.trunc(Math.log10(fftMajorPeak) * 128) & 0xff : 0;
        r.state = 0;
        break;
      case 0:
        seg.setPixelColor(
          r.pos,
          seg.color_from_palette(r.color, false, false, 0),
        );
        r.state++;
        break;
      case MAXSTEPS:
        r.state = 254;
        break;
      default: {
        // state is 1..15 here, so 2*255/state overflows the uint8_t blend
        // amount at state 1 (510 -> 254) -- firmware behaviour, preserved
        const blend = Math.trunc((2 * 255) / r.state) & 0xff;
        const col = seg.color_from_palette(r.color, false, false, 0);
        seg.setPixelColor(
          (r.pos + r.state + seg.length) % seg.length,
          color_blend(seg.color(1), col, blend),
        );
        seg.setPixelColor(
          (r.pos - r.state + seg.length) % seg.length,
          color_blend(seg.color(1), col, blend),
        );
        r.state++;
        break;
      }
    }
  }
}

// --- Freqmap (155) -----------------------------------------------------------
// mode_freqmap (FX.cpp:7260): lights the single pixel whose position is the
// log10 of the major peak; brightness is its magnitude.
function modeFreqmap(seg: Segment): void {
  if (seg.length <= 1) return fallbackStatic(seg);

  const { fftMajorPeak, myMagnitude } = sampleSyntheticAudio(seg.now);
  const magnitude = myMagnitude / 4;
  const peak = fftMajorPeak < 1 ? 1 : fftMajorPeak;

  if (seg.call === 0) seg.fill(BLACK);
  const fadeoutDelay = Math.trunc((256 - seg.speed) / 32);
  if (fadeoutDelay <= 1 || seg.call % fadeoutDelay === 0)
    seg.fade_out(seg.speed);

  let locn = Math.trunc(
    ((Math.log10(peak) - 1.78) * seg.length) / (MAX_FREQ_LOG10 - 1.78),
  );
  if (locn < 1) locn = 0; // avoid underflow
  if (locn >= seg.length) locn = seg.length - 1;

  let pixCol = fToUnsigned(
    ((Math.log10(peak) - 1.78) * 255) / (MAX_FREQ_LOG10 - 1.78),
  );
  if (peak < 61) pixCol = 0; // handle underflow

  seg.setPixelColor(
    locn,
    color_blend(
      seg.color(1),
      seg.color_from_palette(seg.intensity + pixCol, false, false, 0),
      fToU8(magnitude),
    ),
  );
}

// --- DJ Light (159) ----------------------------------------------------------
// mode_DJLight (FX.cpp:7231): an RGB triple taken straight from three FFT bins,
// injected at the centre and shifted outward. Bypasses the palette.
function modeDJLight(seg: Segment): void {
  const mid = Math.trunc(seg.length / 2);

  const { fftResult } = sampleSyntheticAudio(seg.now);

  if (seg.call === 0) seg.fill(BLACK);

  const usNow = seg.now * 1000;
  const secondHand =
    (Math.trunc(Math.trunc(usNow / (256 - seg.speed)) / 500) + 1) & 0xff;
  if (seg.aux0 !== secondHand) {
    seg.aux0 = secondHand;

    // firmware's comment: bin 16 would be out of bounds, so it uses 15
    const r = fftResult[15] >> 1;
    const g = fftResult[5] >> 1;
    const b = fftResult[0] >> 1;
    // CRGB::fadeToBlackBy(f) == nscale8(256-f) per channel (fastled_slim.h:334)
    const scaleFixed = 256 - (map(fftResult[4], 0, 255, 255, 4) & 0xff);
    const color = rgbw32(
      (r * scaleFixed) >> 8,
      (g * scaleFixed) >> 8,
      (b * scaleFixed) >> 8,
      0,
    );
    seg.setPixelColor(mid, color);

    for (let i = seg.length - 1; i > mid; i--)
      seg.setPixelColor(i, seg.getPixelColor(i - 1));
    for (let i = 0; i < mid; i++)
      seg.setPixelColor(i, seg.getPixelColor(i + 1));
  }
}

// --- Blurz (163) -------------------------------------------------------------
// mode_blurz (FX.cpp:7200): one FFT bin per tick painted at a random pixel,
// then blurred.
function modeBlurz(seg: Segment): void {
  if (seg.length <= 1) return fallbackStatic(seg);

  const { fftResult } = sampleSyntheticAudio(seg.now);

  if (seg.call === 0) {
    seg.fill(BLACK);
    seg.aux0 = 0;
  }

  const fadeoutDelay = Math.trunc((256 - seg.speed) / 32);
  if (fadeoutDelay <= 1 || seg.call % fadeoutDelay === 0)
    seg.fade_out(seg.speed);

  seg.step += FRAMETIME;
  const speedFormulaL = 5 + Math.trunc((50 * (255 - seg.speed)) / seg.length);
  if (seg.step > speedFormulaL) {
    const segLoc = seg.rng.random16(seg.length);
    const band = fftResult[seg.aux0 % 16];
    seg.setPixelColor(
      segLoc,
      color_blend(
        seg.color(1),
        seg.color_from_palette(
          Math.trunc((2 * band * 240) / Math.max(1, seg.length - 1)),
          false,
          false,
          0,
        ),
        (2 * band) & 0xff,
      ),
    );
    seg.aux0 = (seg.aux0 + 1) % 16;

    seg.step = 1;
    // firmware note: blur > 210 gives an alternating pattern -- "very old bug",
    // deliberately left in upstream, so left in here
    seg.blur(seg.intensity);
  }
}

// --- Rocktaves (185) ---------------------------------------------------------
// mode_rocktaves (FX.cpp:7455): folds the major peak down to a single octave so
// the same note always gets the same colour.
function modeRocktaves(seg: Segment): void {
  const { fftMajorPeak, myMagnitude } = sampleSyntheticAudio(seg.now);
  const magnitude = myMagnitude / 16;

  seg.fadeToBlackBy(16);

  let frTemp = fftMajorPeak;
  let octCount = 0;
  let volTemp = fToU8(32 + magnitude * 1.5);
  if (magnitude < 48) volTemp = 0; // squelch the background noise
  if (magnitude > 144) volTemp = 255;

  while (frTemp > 249) {
    octCount++; // "should go up to 5"
    frTemp = frTemp / 2;
  }

  frTemp -= 132; // base musical note of C3
  frTemp = Math.abs(frTemp * 2.1); // compress the octave range into 0..255

  let i = map(
    beatsin8_t(8 + octCount * 4, seg.now, 0, 255, 0, octCount * 8),
    0,
    255,
    0,
    seg.length - 1,
  );
  i = Math.min(Math.max(i, 0), seg.length - 1);

  seg.addPixelColor(
    i,
    color_blend(
      seg.color(1),
      seg.color_from_palette(fToU8(frTemp), false, false, 0),
      volTemp,
    ),
  );
}

// --- PS GEQ 1D (212) ---------------------------------------------------------
// mode_particle1DGEQ (FX.cpp:10356): one emitter per FFT bin, spread along the
// strip. `hw_random()` -> seg.rng.random16().
function modeParticleGeq1D(seg: Segment): void {
  let ps: ParticleSystem1D | null;
  if (seg.call === 0) {
    ps = initParticleSystem1D(seg, 16, 255, true);
    if (!ps) return fallbackStatic(seg);
  } else {
    ps = getParticleSystem1D(seg);
    if (!ps) return fallbackStatic(seg);
  }

  ps.updateSystem();
  const numSources = ps.numSources;
  ps.setMotionBlur(seg.custom2);

  const spacing = Math.trunc(ps.maxX / numSources);
  for (let i = 0; i < numSources; i++) {
    const src = ps.sources[i];
    src.source.hue = (i * 16) & 0xff;
    src.var = seg.speed >> 2;
    src.minLife = 180 + (seg.intensity >> 1);
    src.maxLife = 240 + seg.intensity;
    src.sat = 255;
    src.size = seg.custom1;
    src.source.x = (spacing >> 1) + spacing * i;
  }

  for (let i = 0; i < ps.usedParticles; i++) {
    if (ps.particles[i].ttl > 20) ps.particles[i].ttl -= 20;
    else ps.particles[i].ttl = 0;
  }

  const { fftResult } = sampleSyntheticAudio(seg.now);

  // start on a random bin so the available particles are shared out fairly
  let bin = seg.rng.random16(numSources);
  const threshold = 300 - seg.intensity;

  for (let i = 0; i < numSources; i++) {
    bin++;
    bin = bin % numSources;
    let emitparticle = false;
    if (fftResult[bin] > threshold) {
      emitparticle = true;
    } else if (fftResult[bin] > 0) {
      const restvolume = ((threshold - fftResult[bin]) >> 2) + 2;
      if (seg.rng.random16() % restvolume === 0) emitparticle = true;
    }
    if (emitparticle) ps.sprayEmit(ps.sources[bin]);
  }

  ps.update();
}

// --- PS Sonic Stream (214) ---------------------------------------------------
// mode_particle1DsonicStream (FX.cpp:10491): one emitter fires a particle down
// the strip whenever the selected bin crosses a (optionally adaptive) threshold.
function modeParticleSonicStream(seg: Segment): void {
  let ps: ParticleSystem1D | null;
  if (seg.call === 0) {
    ps = initParticleSystem1D(seg, 1, 255, true);
    if (!ps) return fallbackStatic(seg);
    ps.setKillOutOfBounds(true);
    ps.sources[0].source.x = 0;
    ps.sources[0].var = 0;
  } else {
    ps = getParticleSystem1D(seg);
    if (!ps) return fallbackStatic(seg);
  }

  ps.updateSystem();
  ps.setMotionBlur(20 + (seg.custom2 >> 1));
  ps.setSmearBlur(200);
  ps.sources[0].v = 5 + (seg.speed >> 2);

  const { fftResult } = sampleSyntheticAudio(seg.now);
  const baseBin = seg.custom3 >> 1;
  let loudness = fftResult[baseBin];
  let mids = 0;
  if (seg.check1)
    mids = sqrt32bw(
      fftResult[5] +
        fftResult[6] +
        fftResult[7] +
        fftResult[8] +
        fftResult[9] +
        fftResult[10],
    );
  if (baseBin > 12) loudness = loudness << 2; // better detection up high

  let threshold = 140 - (seg.intensity >> 1);
  if (seg.check2) {
    // low-pass filter over the bin, used as an adaptive threshold
    seg.step = (seg.step * 31500 + loudness * (32768 - 31500)) >> 15;
    threshold = 20 + (threshold >> 1) + seg.step;
  }

  const hueincrement = seg.custom1 >> 3;
  ps.sources[0].sat = seg.custom1 > 0 ? 255 : 0;
  ps.setColorByPosition(seg.custom1 === 255);

  for (let i = 0; i < ps.usedParticles; i++) {
    if (!ps.sources[0].sourceFlags.perpetual) {
      if (ps.particles[i].ttl > 2) ps.particles[i].ttl -= 2;
      else ps.particles[i].ttl = 0;
    }
    if (seg.check1) {
      const shift =
        (mids *
          perlin8(
            (ps.particles[i].x << 2) & 0xffff,
            (seg.step << 2) & 0xffff,
          )) >>
        9;
      ps.particles[i].hue = (ps.particles[i].hue + shift) & 0xff;
    }
  }

  if (loudness > threshold) {
    seg.aux0 = (seg.aux0 + hueincrement) & 0xffff;
    ps.sources[0].minLife = 100 + ((seg.intensity * loudness * loudness) >> 13);
    ps.sources[0].maxLife = ps.sources[0].minLife;
    ps.sources[0].source.hue = seg.aux0 & 0xff;
    ps.sources[0].size = seg.speed;
    // only emit once the last-emitted particle has moved clear (or died).
    // aux1 is only ever written from sprayEmit, so the undefined branch is a
    // TS-side guard, not a firmware path.
    const last = ps.particles[seg.aux1];
    if (
      last === undefined ||
      last.x > 3 * PS_P_RADIUS_1D ||
      last.ttl === 0
    ) {
      const partindex = ps.sprayEmit(ps.sources[0]);
      if (partindex >= 0) seg.aux1 = partindex;
    }
  } else {
    loudness = 0; // required for push mode
  }

  ps.update();

  if (seg.check3) {
    // push mode
    ps.sources[0].sourceFlags.perpetual = true;
    ps.applyFriction(1);
    const movestep = ((seg.speed + 2) * loudness) >> 10;
    if (movestep) {
      for (let i = 0; i < ps.usedParticles; i++) {
        if (ps.particles[i].ttl) {
          ps.particles[i].x += movestep;
          ps.particles[i].vx = 10 + (seg.speed >> 4);
        }
      }
    }
  } else {
    ps.sources[0].sourceFlags.perpetual = false;
    // move all particles again, to allow faster speeds
    for (let i = 0; i < ps.usedParticles; i++) {
      if (ps.particles[i].vx === 0) ps.particles[i].vx = ps.sources[0].v;
      ps.particleMoveUpdate(
        ps.particles[i],
        ps.particleFlags[i],
        null,
        ps.advPartProps ? ps.advPartProps[i] : null,
      );
    }
  }
}

// --- PS Sonic Boom (215) -----------------------------------------------------
// mode_particle1DsonicBoom (FX.cpp:10594): each detected beat explodes a burst
// of particles at a position chosen by the Position slider.
function modeParticleSonicBoom(seg: Segment): void {
  let ps: ParticleSystem1D | null;
  if (seg.call === 0) {
    ps = initParticleSystem1D(seg, 1, 255, true);
    if (!ps) return fallbackStatic(seg);
    ps.setKillOutOfBounds(true);
  } else {
    ps = getParticleSystem1D(seg);
    if (!ps) return fallbackStatic(seg);
  }

  ps.updateSystem();
  ps.setMotionBlur(seg.check3 ? 180 : 0);
  ps.setSmearBlur(seg.check3 ? 64 : 0);
  ps.sources[0].var = map(seg.speed, 0, 255, 10, 127);

  const { fftResult } = sampleSyntheticAudio(seg.now);
  const baseBin = seg.custom3 >> 1;
  let loudness = fftResult[baseBin];
  let mids = 0;
  if (seg.check1)
    mids = sqrt32bw(
      fftResult[5] +
        fftResult[6] +
        fftResult[7] +
        fftResult[8] +
        fftResult[9] +
        fftResult[10],
    );

  if (baseBin > 12) loudness = loudness << 2;
  let threshold = 150 - (seg.intensity >> 1);
  if (seg.check2) {
    seg.step = (seg.step * 31500 + loudness * (32768 - 31500)) >> 15;
    threshold = 20 + (threshold >> 1) + seg.step;
  }

  for (let i = 0; i < ps.usedParticles; i++) {
    if (seg.check1) {
      const shift =
        (mids *
          perlin8(
            (ps.particles[i].x << 2) & 0xffff,
            (seg.step << 2) & 0xffff,
          )) >>
        9;
      ps.particles[i].hue = (ps.particles[i].hue + shift) & 0xff;
    }
    if (ps.particles[i].ttl > 16) ps.particles[i].ttl -= 16;
  }

  if (loudness > threshold) {
    if (seg.aux1 === 0) {
      // edge: runs once per "beat"
      if (seg.custom2 < 128) {
        ps.sources[0].source.x = map(seg.custom2, 0, 127, 0, ps.maxX);
      } else if (seg.custom2 < 255) {
        const step = Math.trunc(ps.maxX / ((270 - seg.custom2) >> 3));
        ps.sources[0].source.x = (ps.sources[0].source.x + step) % ps.maxX;
        // align so the first position is half a step in
        if (ps.sources[0].source.x < step)
          ps.sources[0].source.x = step >> 1;
      } else {
        // hw_random(maxX) is 32-bit upstream; random16 covers maxX for any
        // strip this sim renders (maxX = length*32-1)
        ps.sources[0].source.x = seg.rng.random16(ps.maxX);
      }

      ps.sources[0].sat = seg.custom1 > 0 ? 255 : 0;
      if (seg.custom1 === 255)
        seg.aux0 = map(ps.sources[0].source.x, 0, ps.maxX, 0, 255);
      else if (seg.custom1 > 0)
        seg.aux0 = (seg.aux0 + (seg.custom1 >> 1)) & 0xffff;
    }
    seg.aux1 = 1;

    ps.sources[0].minLife = 200;
    ps.sources[0].maxLife =
      ps.sources[0].minLife + ((seg.intensity * loudness * loudness) >> 13);
    ps.sources[0].source.hue = seg.aux0 & 0xff;
    let explosionsize = 4 + (ps.maxXpixel >> 2);
    explosionsize = seg.rng.random16((explosionsize * loudness) >> 10);
    for (let e = 0; e < explosionsize; e++) ps.sprayEmit(ps.sources[0]);
  } else {
    seg.aux1 = 0; // reset edge detection
  }

  ps.update();
}

// --- PS Springy (216) --------------------------------------------------------
// mode_particleSpringy (FX.cpp:10683): a chain of particles joined by springs,
// anchored at both ends. Excited by a periodic pulse, a sine, random kicks, or
// (check3) an FFT bin.
function modeParticleSpringy(seg: Segment): void {
  let ps: ParticleSystem1D | null;
  if (seg.call === 0) {
    ps = initParticleSystem1D(seg, 1, 128, true);
    if (!ps) return fallbackStatic(seg);
    seg.aux0 = 0xffff; // invalidate settings
    seg.aux1 = 0xffff;
  } else {
    ps = getParticleSystem1D(seg);
    if (!ps) return fallbackStatic(seg);
  }

  ps.updateSystem();
  ps.setMotionBlur(seg.check1 ? 220 : 0);
  ps.setSmearBlur(50);
  ps.setUsedParticles(
    map(seg.custom1, 0, 255, 30 >> (seg.check2 ? 1 : 0), 255 >> (seg.check2 ? 2 : 0)),
  );
  const adv = ps.advPartProps;
  if (!adv) return fallbackStatic(seg);

  const springlength = Math.trunc(ps.maxX / ps.usedParticles);
  const springK = map(seg.speed, 0, 255, 5, 35);

  const settingssum = seg.custom1 + (seg.check2 ? 1 : 0);
  ps.setParticleSize(seg.check2 ? 120 : 1);

  if (seg.aux0 !== settingssum) {
    for (let i = 0; i < ps.usedParticles; i++) {
      adv[i].sat = 255;
      ps.particles[i].x = (i + 1) * Math.trunc(ps.maxX / ps.usedParticles);
    }
    seg.aux0 = settingssum;
  }
  const dxlimit = (2 + ((255 - seg.speed) >> 5)) * springlength;

  const springforce = new Array<number>(ps.usedParticles).fill(0);

  // spring forces, plus position limiting so the chain cannot overstretch
  if (ps.particles[0].x < -springlength) ps.particles[0].x = -springlength;
  else if (ps.particles[0].x > dxlimit) ps.particles[0].x = dxlimit;
  springforce[0] += ((springlength >> 1) - ps.particles[0].x) * springK;

  for (let i = 1; i < ps.usedParticles; i++) {
    // reorder out-of-order particles, or the chain descends into chaos
    if (ps.particles[i].x < ps.particles[i - 1].x) {
      const tmp = ps.particles[i].x;
      ps.particles[i].x = ps.particles[i - 1].x;
      ps.particles[i - 1].x = tmp;
    }
    let dx = ps.particles[i].x - ps.particles[i - 1].x;
    if (dx > dxlimit) {
      ps.particles[i].x = ps.particles[i - 1].x + dxlimit;
      dx = dxlimit;
    }
    const dxleft = springlength - dx;
    springforce[i] += dxleft * springK;
    springforce[i - 1] -= dxleft * springK;
    if (i === ps.usedParticles - 1) {
      if (ps.particles[i].x >= ps.maxX + springlength)
        ps.particles[i].x = ps.maxX + springlength;
      const dxright = (springlength >> 1) - (ps.maxX - ps.particles[i].x);
      springforce[i] -= dxright * springK;
    }
  }

  // firmware passes each particle's own forcecounter by reference; the engine
  // here takes a {v} box, so it is loaded and stored around each call
  const fc = { v: 0 };
  const dampenoscillations = seg.call % (9 - (seg.speed >> 5)) === 0;
  for (let i = 0; i < ps.usedParticles; i++) {
    // integer divide, not a shift: springforce can be negative
    springforce[i] = Math.trunc(springforce[i] / 64);
    const maxforce = 120;
    springforce[i] =
      springforce[i] > maxforce
        ? maxforce
        : springforce[i] < -maxforce
          ? -maxforce
          : springforce[i];
    fc.v = adv[i].forcecounter;
    ps.applyForceOne(ps.particles[i], springforce[i], fc);
    adv[i].forcecounter = fc.v;
    if (dampenoscillations) {
      if (
        Math.abs(ps.particles[i].vx) < 3 &&
        Math.abs(springforce[i]) < springK >> 2
      )
        ps.particles[i].vx = Math.trunc((ps.particles[i].vx * 254) / 256);
    }
    ps.particles[i].ttl = 300; // reset ttl, cannot use perpetual
  }

  if (seg.call % (65 - ((seg.intensity * (1 + (seg.speed >> 3))) >> 7)) === 0)
    ps.applyFriction(seg.intensity >> 2);

  // small restoring force, so particles return to rest even under heavy damping
  for (let i = 1; i < ps.usedParticles - 1; i++) {
    const restposition = (springlength >> 1) + i * springlength;
    const dx = restposition - ps.particles[i].x;
    fc.v = adv[i].forcecounter;
    ps.applyForceOne(ps.particles[i], dx > 0 ? 1 : dx < 0 ? -1 : 0, fc);
    adv[i].forcecounter = fc.v;
  }

  if (seg.check3) {
    // AR mode: custom3 selects the band that kicks the centre particle
    const { fftResult } = sampleSyntheticAudio(seg.now);
    const baseBin = map(seg.custom3, 0, 31, 0, 14);
    const loudness = fftResult[baseBin] + fftResult[baseBin + 1];
    const threshold = 80;
    if (loudness > threshold) {
      const mid = ps.usedParticles >> 1;
      const offset = (ps.maxX >> 1) - ps.particles[mid].x;
      if (Math.abs(offset) < ps.maxX >> 5)
        ps.particles[mid].vx =
          (ps.particles[mid].vx > 0 ? 1 : -1) * (loudness >> 3);
    }
  } else if (seg.custom3 <= 10) {
    // periodic pulse: 0-5 at the start, 6-10 at the centre
    if (seg.now > seg.step) {
      const speed = seg.custom3 > 5 ? seg.custom3 - 6 : seg.custom3;
      seg.step = seg.now + 7500 - ((seg.speed << 3) + (speed << 10));
      const amplitude = 40 + (seg.custom1 >> 2);
      const index = seg.custom3 > 5 ? Math.trunc(ps.usedParticles / 2) : 0;
      ps.particles[index].vx += amplitude;
    }
  } else if (seg.custom3 <= 30) {
    // sinusoidal drive: 11-20 at the start, 21-30 at the centre
    const index = seg.custom3 > 20 ? Math.trunc(ps.usedParticles / 2) : 0;
    const restposition = index > 0 ? ps.maxX >> 1 : 0;
    let amplitude = 5 + (seg.custom1 >> 2);
    const speed = seg.custom3 - 10 - (index ? 10 : 0);
    const phase = (seg.now * ((1 + (seg.speed >> 4)) * speed)) | 0; // int32
    if (seg.check2) amplitude <<= 1;
    ps.particles[index].x = restposition + ((sin16(phase & 0xffff) * amplitude) >> 12);
  } else if (seg.rng.random16() < 656) {
    // ~1% chance of a random kick
    let amplitude = 60;
    if (seg.check2) amplitude <<= 1;
    ps.particles[ps.usedParticles >> 1].vx +=
      seg.rng.random16(amplitude << 1) - amplitude;
  }

  for (let i = 0; i < ps.usedParticles; i++) {
    if (seg.custom2 === 255) {
      // hue from speed; the int8 round-trip is firmware's, and dumps small
      // values so slow particles don't flicker
      let speedclr = (s8i(Math.abs(ps.particles[i].vx)) >> 2) << 4;
      if (speedclr > 240) speedclr = 240;
      ps.particles[i].hue = speedclr & 0xff;
    } else if (seg.custom2 > 0) {
      ps.particles[i].hue = (i * (seg.custom2 >> 2)) & 0xff;
    } else {
      // hue from local density
      let deviation: number;
      if (i === 0) {
        deviation = Math.trunc(springlength / 2) - ps.particles[i].x;
      } else if (i === ps.usedParticles - 1) {
        deviation =
          Math.trunc(springlength / 2) - (ps.maxX - ps.particles[i].x);
      } else {
        const leftDx = ps.particles[i].x - ps.particles[i - 1].x;
        const rightDx = ps.particles[i + 1].x - ps.particles[i].x;
        let avgDistance = (leftDx + rightDx) >> 1;
        if (avgDistance < 0) avgDistance = 0;
        deviation = springlength - avgDistance;
      }
      deviation = Math.min(Math.max(deviation, -127), 112);
      ps.particles[i].hue = (127 + deviation) & 0xff;
    }
  }

  ps.update();
}

/**
 * The 2D effect bodies, keyed by real fx id. Same contract as EFFECT_SIMS but
 * over a Segment2D matrix; the sim wrapper picks the registry by id.
 */
export const EFFECT_SIMS_2D: Record<number, (seg: Segment2D) => void> = {
  42: mode2DFireworks,
  43: mode2DRain,
  65: mode2DPalette,
  79: mode2DRipple,
  82: mode2DHalloweenEyes,
  90: mode2DExplodingFireworks, // "Fireworks 1D"
  99: mode2DRippleRainbow,
  139: mode2DGeq, // "GEQ"
  160: mode2DFunkyPlank, // "Funky Plank"
  165: mode2DWaverly, // "Waverly"
  175: mode2DSwirl, // "Swirl"
  186: mode2DAkemi, // "Akemi"
  197: modeParticleSpray2D, // "PS Spray"
  198: modeParticleGeq2D, // "PS GEQ 2D"
  199: modeParticleGeqNova2D, // "PS GEQ Nova"
  201: modeParticleBlobs2D, // "PS Blobs"
  114: mode2DPlasmaRotozoom, // "Rotozoomer"
  118: mode2DSpaceships,
  119: mode2DCrazyBees,
  120: mode2DGhostRider,
  121: mode2DFloatingBlobs,
  123: mode2DDriftRose,
  124: mode2DDistortionWaves,
  125: mode2DSoap,
  126: mode2DOctopus,
  127: mode2DWavingCell,
  146: mode2DNoise,
  150: mode2DSquaredSwirl,
  166: mode2DSunRadiation,
  173: mode2DTartan,
  181: mode2DSindots,
  149: mode2DFirenoise,
  153: mode2DMatrix,
  154: mode2DMetaballs,
  162: mode2DPulser,
  168: mode2DJulia,
  174: mode2DPolarLights,
  176: mode2DLissajous,
  178: mode2DPlasmaball,
  152: mode2DDna,
  164: mode2DDrift,
  167: mode2DColoredBursts,
  172: mode2DGameOfLife,
  177: mode2DFrizzles,
  180: mode2DHiphotic,
  182: mode2DDnaSpiral,
  183: mode2DBlackHole,
  187: modeParticleVolcano, // "PS Volcano"
  188: modeParticleFire2D, // "PS Fire"
  189: modeParticleFireworks2D, // "PS Fireworks"
  190: modeParticleVortex, // "PS Vortex"
  191: modeParticlePerlin, // "PS Fuzzy Noise"
  192: modeParticlePit, // "PS Ballpit"
  193: modeParticleBox, // "PS Box"
  194: modeParticleAttractor, // "PS Attractor"
  195: modeParticleImpact, // "PS Impact"
  196: modeParticleWaterfall, // "PS Waterfall"
  200: modeParticleGhostRider, // "PS Ghost Rider"
  217: modeParticleGalaxy, // "PS Galaxy"
};
