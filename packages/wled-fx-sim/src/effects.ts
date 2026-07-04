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
import {
  NOBLEND,
  colorFromPalette,
  color_blend,
  qadd8,
  qsub8,
  scale8,
  sin16_t as sin16,
  sin8_t as sin8,
  triwave16,
} from './lib8.js';

/** WLED's default frame interval (FRAMETIME_FIXED = 1000/42). */
export const FRAMETIME = Math.trunc(1000 / 42); // 23

const WHITE = 0xffffff;

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

/** SEGLEN<=1 fallback -- FX_FALLBACK_STATIC. */
function fallbackStatic(seg: Segment): void {
  seg.fill(seg.color(0));
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

// --- Wipe (3) ---------------------------------------------------------------
function colorWipe(seg: Segment, rev: boolean): void {
  if (seg.length <= 1) return fallbackStatic(seg);
  const cycleTime = 750 + (255 - seg.speed) * 150;
  const perc = seg.now % cycleTime;
  let prog = Math.trunc((perc * 65535) / cycleTime);
  const back = prog > 32767;
  if (back) prog -= 32767;

  const ledIndex = (prog * seg.length) >> 15;
  let rem = (prog * seg.length * 2) & 0xffff;
  rem = Math.trunc(rem / (seg.intensity + 1));
  if (rem > 255) rem = 255;

  const col1 = seg.color(1);
  for (let i = 0; i < seg.length; i++) {
    const index = rev && back ? seg.length - 1 - i : i;
    const col0 = seg.color_from_palette(index, true, false, 0);
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

// --- Scan (10) --------------------------------------------------------------
function modeScan(seg: Segment): void {
  if (seg.length <= 1) return fallbackStatic(seg);
  const cycleTime = 750 + (255 - seg.speed) * 150;
  const perc = seg.now % cycleTime;
  const prog = Math.trunc((perc * 65535) / cycleTime);
  const size = 1 + ((seg.intensity * seg.length) >> 9);
  const ledIndex = (prog * (seg.length * 2 - size * 2)) >> 16;

  if (!seg.check2) seg.fill(seg.color(1));

  let ledOffset = ledIndex - (seg.length - size);
  ledOffset = Math.abs(ledOffset);
  for (let j = ledOffset; j < ledOffset + size; j++) {
    seg.setPixelColor(j, seg.color_from_palette(j, true, false, 0));
  }
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

// --- Dissolve (18) ----------------------------------------------------------
function modeDissolve(seg: Segment): void {
  const color = seg.color(0);
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

  for (let i = 0; i < seg.length; i++) seg.setPixelColor(i, px[i]);

  if (seg.step > 255 - seg.speed + 15) {
    seg.aux0 = seg.aux0 ? 0 : 1;
    seg.step = 0;
  } else {
    seg.step++;
  }
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

// --- Chase (28) / Chase Rainbow (30) shared "chase" helper ------------------
function chase(
  seg: Segment,
  color1: number,
  color2: number,
  color3: number,
  doPalette: boolean,
): void {
  const counter = (seg.now * ((seg.speed >> 2) + 1)) & 0xffff;
  const a = (counter * seg.length) >> 16;
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

function modeChaseRainbow(seg: Segment): void {
  let colorSep = Math.trunc(256 / seg.length);
  if (colorSep === 0) colorSep = 1;
  const colorIndex = seg.call & 0xff;
  const color = seg.color_wheel((seg.step * colorSep + colorIndex) & 0xff);
  chase(seg, color, seg.color(0), seg.color(1), false);
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
  const meteorSize = 1 + Math.trunc(seg.length / 20);

  const counter = seg.now * ((seg.speed >> 2) + 8);
  const meteorstart = ((counter * seg.length) >>> 0) >>> 16;

  const maxv = seg.palette === 5 || !seg.check1 ? 240 : 255;

  for (let i = 0; i < seg.length; i++) {
    if (seg.rng.random8() <= 255 - seg.intensity) {
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
      seg.setPixelColor(
        i,
        seg.color_from_palette(index, false, false, idx, bri),
      );
    }
  }

  for (let j = 0; j < meteorSize; j++) {
    const index = (meteorstart + j) % seg.length;
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

  seg.step += seg.speed + 1;
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

/**
 * Registry of ported effect bodies, keyed by real WLED fx id (v16.0.0). The
 * value is a per-frame function; an id absent here has no simulation yet and
 * the UI falls back to the CSS preview family (see index.ts isPorted).
 */
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
};
