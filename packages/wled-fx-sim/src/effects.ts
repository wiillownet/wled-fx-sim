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
  cos_approx,
  cubicwave8,
  gamma32inv,
  gamma8,
  gamma8inv,
  hsv2rgb_rainbow,
  qadd8,
  qsub8,
  quadwave8,
  rgbw32,
  scale16,
  scale8,
  sin_approx,
  cos8_t as cos8,
  sin16_t as sin16,
  sin8_t as sin8,
  triwave16,
  triwave8,
  R,
  G,
  B,
  type RGB,
} from './lib8.js';

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

// --- Candle (88) --------------------------------------------------------------
// The shared firmware `candle(bool multi)` helper also backs "Candle Multi"
// (fx 102, not ported); id 88 always calls candle(false), so only its
// single-candle branch (whole-strip flicker, no per-LED data) is reachable.
function modeCandle(seg: Segment): void {
  // Firmware rate-limits to one update per FRAMETIME via a stored last-call
  // timestamp; this sim's frame loop already steps in fixed FRAMETIME
  // increments (index.ts), so that guard is a no-op here -- and skipping it
  // avoids a spurious all-black frame 0 (now=0, stored lastcall=0 -> firmware's
  // literal guard would trip on the very first call too).
  const valrange = seg.intensity;
  const rndval = valrange >> 1;
  let speedFactor = 4;
  if (seg.speed > 252) speedFactor = 1;
  else if (seg.speed > 99) speedFactor = 2;
  else if (seg.speed > 49) speedFactor = 3;

  let s = seg.aux0;
  let sTarget = seg.aux1;
  let fadeStep = seg.step;
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

// --- Phased (105) ----------------------------------------------------------
function modePhased(seg: Segment): void {
  const allfreq = 16;
  // Firmware bit-reinterprets SEGENV.step as a float to smuggle a float
  // through a uint32 field; seg.step is already a plain number, so it holds
  // the float phase directly -- no reinterpretation needed.
  let phase = seg.step;
  const cutOff = 255 - seg.intensity;
  const modValDefault = 5; // moder=1 (Phased Noise, fx 109) needs perlin8; not ported

  let index = Math.trunc(seg.now / 64);
  phase += seg.speed / 32;

  for (let i = 0; i < seg.length; i++) {
    const modVal = modValDefault;
    let val = (i + 1) * allfreq;
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

/**
 * Registry of ported effect bodies, keyed by real WLED fx id (v16.0.0). The
 * value is a per-frame function; an id absent here has no simulation yet and
 * the UI falls back to the CSS preview family (see index.ts isPorted).
 */

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
  24: modeStrobeRainbow,
  26: modeBlinkRainbow,
  65: modePalette,
  82: modeHalloweenEyes,
  112: modeDancingShadows,
  58: modeIcu,
  89: modeStarburst,
  96: modeDrip,
  103: modeSolidGlitter,
};
