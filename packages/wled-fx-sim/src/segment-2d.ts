/**
 * 2D sibling of Segment: a W×H matrix over the same packed-uint32 pixel buffer
 * (row-major, index = x + y*width), with the XY pixel access + 2D drawing
 * helpers the firmware's 2D effect bodies call (wled00/FX_2Dfcn.cpp + the FX.h
 * inline wrappers, tag v16.0.0): setPixelColorXY, blur2D/blurRows/blurCols,
 * moveX/moveY/move, drawLine, drawCircle, fillCircle, wu_pixel.
 *
 * Extends Segment with length = width*height, so everything 1D carries over
 * unchanged: SEGENV scratch, seeded PRNG, palette resolution, fill /
 * fadeToBlackBy / fade_out, and the linear setPixelColor(i) addressing several
 * 2D effects (e.g. Game Of Life) use over the whole matrix. `blur()` is
 * overridden to the firmware's 2D delegation (blur2D on both axes).
 */
import { Segment } from './segment.js';
import {
  color_add,
  color_blend,
  color_fade,
  fast_color_scale,
  qadd8,
  B,
  G,
  R,
} from './lib8.js';

export class Segment2D extends Segment {
  readonly width: number;
  readonly height: number;

  constructor(width: number, height: number, seed = 0x1234) {
    const w = Math.max(1, width | 0);
    const h = Math.max(1, height | 0);
    super(w * h, seed);
    this.width = w;
    this.height = h;
  }

  /** SEGMENT.is2D() -- a real matrix needs both dimensions > 1. */
  is2D(): boolean {
    return this.width > 1 && this.height > 1;
  }

  /** Row-major index for (x, y); callers must bounds-check. */
  XY(x: number, y: number): number {
    return x + y * this.width;
  }

  // --- XY pixel access (FX_2Dfcn.cpp + FX.h inlines) ------------------------

  setPixelColorXY(x: number, y: number, c: number): void {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return;
    this.pixels[x + y * this.width] = c >>> 0;
  }

  getPixelColorXY(x: number, y: number): number {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return 0;
    return this.pixels[x + y * this.width];
  }

  addPixelColorXY(x: number, y: number, c: number, preserveCR = true): void {
    this.setPixelColorXY(
      x,
      y,
      color_add(this.getPixelColorXY(x, y), c, preserveCR),
    );
  }

  blendPixelColorXY(x: number, y: number, c: number, blend: number): void {
    this.setPixelColorXY(
      x,
      y,
      color_blend(this.getPixelColorXY(x, y), c, blend),
    );
  }

  fadePixelColorXY(x: number, y: number, fade: number): void {
    this.setPixelColorXY(
      x,
      y,
      color_fade(this.getPixelColorXY(x, y), fade, true),
    );
  }

  // --- blur (FX_2Dfcn.cpp Segment::blur2D) ----------------------------------

  /** 2D segment blur() delegates to a symmetric blur2D (FX_fcn.cpp). */
  override blur(amount: number, smear = false): void {
    this.blur2D(amount, amount, smear);
  }

  blur2D(blurX: number, blurY: number, smear = false): void {
    const cols = this.width;
    const rows = this.height;
    const buf = this.pixels;
    const bx = blurX & 0xff;
    const by = blurY & 0xff;
    if (bx) {
      const keepx = smear ? 255 : 255 - bx;
      const seepx = bx >> 1;
      for (let row = 0; row < rows; row++) {
        const base = row * cols;
        let cur = buf[base];
        let carryover = fast_color_scale(cur, seepx);
        buf[base] = fast_color_scale(cur, keepx);
        for (let x = 1; x < cols; x++) {
          cur = buf[base + x];
          const part = fast_color_scale(cur, seepx);
          cur = fast_color_scale(cur, keepx);
          cur = color_add(cur, carryover);
          buf[base + x - 1] = color_add(buf[base + x - 1], part);
          buf[base + x] = cur;
          carryover = part;
        }
      }
    }
    if (by) {
      const keepy = smear ? 255 : 255 - by;
      const seepy = by >> 1;
      for (let col = 0; col < cols; col++) {
        let cur = buf[col];
        let carryover = fast_color_scale(cur, seepy);
        buf[col] = fast_color_scale(cur, keepy);
        for (let y = 1; y < rows; y++) {
          const i = col + y * cols;
          cur = buf[i];
          const part = fast_color_scale(cur, seepy);
          cur = fast_color_scale(cur, keepy);
          cur = color_add(cur, carryover);
          buf[i - cols] = color_add(buf[i - cols], part);
          buf[i] = cur;
          carryover = part;
        }
      }
    }
  }

  blurRows(amount: number, smear = false): void {
    this.blur2D(amount, 0, smear);
  }

  blurCols(amount: number, smear = false): void {
    this.blur2D(0, amount, smear);
  }

  // --- move (FX_2Dfcn.cpp) --------------------------------------------------

  moveX(delta: number, wrap = false): void {
    const vW = this.width;
    const vH = this.height;
    if (!delta) return;
    const absDelta = Math.abs(delta);
    if (absDelta >= vW) return;
    const buf = this.pixels;
    const newPxCol = new Uint32Array(vW);
    let stop = vW;
    let start = 0;
    let newDelta: number;
    if (wrap) newDelta = (((delta + vW) % vW) + vW) % vW;
    else {
      if (delta < 0) start = absDelta;
      stop = vW - absDelta;
      newDelta = delta > 0 ? delta : 0;
    }
    for (let y = 0; y < vH; y++) {
      const base = y * vW;
      for (let x = 0; x < stop; x++) {
        let srcX = x + newDelta;
        if (wrap) srcX %= vW;
        newPxCol[x] = buf[base + srcX];
      }
      for (let x = 0; x < stop; x++) buf[base + x + start] = newPxCol[x];
    }
  }

  moveY(delta: number, wrap = false): void {
    const vW = this.width;
    const vH = this.height;
    if (!delta) return;
    const absDelta = Math.abs(delta);
    if (absDelta >= vH) return;
    const buf = this.pixels;
    const newPxCol = new Uint32Array(vH);
    let stop = vH;
    let start = 0;
    let newDelta: number;
    if (wrap) newDelta = (((delta + vH) % vH) + vH) % vH;
    else {
      if (delta < 0) start = absDelta;
      stop = vH - absDelta;
      newDelta = delta > 0 ? delta : 0;
    }
    for (let x = 0; x < vW; x++) {
      for (let y = 0; y < stop; y++) {
        let srcY = y + newDelta;
        if (wrap) srcY %= vH;
        newPxCol[y] = buf[x + srcY * vW];
      }
      for (let y = 0; y < stop; y++) buf[x + (y + start) * vW] = newPxCol[y];
    }
  }

  /** dir: 0=left, 1=left-up, 2=up, 3=right-up, 4=right, 5=right-down, 6=down, 7=left-down. */
  move(dir: number, delta: number, wrap = false): void {
    if (delta === 0) return;
    switch (dir & 0x07) {
      case 0:
        this.moveX(delta, wrap);
        break;
      case 1:
        this.moveX(delta, wrap);
        this.moveY(delta, wrap);
        break;
      case 2:
        this.moveY(delta, wrap);
        break;
      case 3:
        this.moveX(-delta, wrap);
        this.moveY(delta, wrap);
        break;
      case 4:
        this.moveX(-delta, wrap);
        break;
      case 5:
        this.moveX(-delta, wrap);
        this.moveY(-delta, wrap);
        break;
      case 6:
        this.moveY(-delta, wrap);
        break;
      case 7:
        this.moveX(delta, wrap);
        this.moveY(-delta, wrap);
        break;
    }
  }

  // --- drawing (FX_2Dfcn.cpp) -----------------------------------------------

  drawLine(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    c: number,
    soft = false,
  ): void {
    const vW = this.width;
    const vH = this.height;
    if (x0 >= vW || x1 >= vW || y0 >= vH || y1 >= vH) return;
    if (x0 < 0 || x1 < 0 || y0 < 0 || y1 < 0) return;

    const dx = Math.abs(x1 - x0);
    const sx = x0 < x1 ? 1 : -1;
    const dy = Math.abs(y1 - y0);
    const sy = y0 < y1 ? 1 : -1;

    if (dx + dy === 0) {
      this.setPixelColorXY(x0, y0, c);
      return;
    }

    if (soft) {
      // Xiaolin Wu's algorithm
      const steep = dy > dx;
      if (steep) {
        [x0, y0] = [y0, x0];
        [x1, y1] = [y1, x1];
      }
      if (x0 > x1) {
        [x0, x1] = [x1, x0];
        [y0, y1] = [y1, y0];
      }
      const gradient = x1 - x0 === 0 ? 1 : (y1 - y0) / (x1 - x0);
      let intersectY = y0;
      for (let x = x0; x <= x1; x++) {
        const keep = Math.trunc(255 * (intersectY - Math.trunc(intersectY)));
        const seep = 0xff - keep;
        const y = Math.trunc(intersectY);
        const px = steep ? y : x;
        const py = steep ? x : y;
        this.blendPixelColorXY(px, py, c, seep);
        this.blendPixelColorXY(
          px + (steep ? 1 : 0),
          py + (steep ? 0 : 1),
          c,
          keep,
        );
        intersectY += gradient;
      }
    } else {
      // Bresenham's algorithm
      let err = Math.trunc((dx > dy ? dx : -dy) / 2);
      for (;;) {
        this.setPixelColorXY(x0, y0, c);
        if (x0 === x1 && y0 === y1) break;
        const e2 = err;
        if (e2 > -dx) {
          err -= dy;
          x0 += sx;
        }
        if (e2 < dy) {
          err += dx;
          y0 += sy;
        }
      }
    }
  }

  drawCircle(
    cx: number,
    cy: number,
    radius: number,
    col: number,
    soft = false,
  ): void {
    if (radius === 0) return;
    if (soft) {
      // Xiaolin Wu's algorithm
      const rsq = radius * radius;
      let x = 0;
      let y = radius;
      let oldFade = 0;
      while (x < y) {
        const yf = Math.sqrt(rsq - x * x);
        const fade = Math.trunc(255 * (Math.ceil(yf) - yf)) & 0xff;
        if (oldFade > fade) y--;
        oldFade = fade;
        for (let i = 0; i < 16; i++) {
          const swaps = i & 0x4 ? 1 : 0;
          const adj = i < 8 ? 0 : 1;
          const dx = i & 1 ? -1 : 1;
          const dy = i & 2 ? -1 : 1;
          let px: number;
          let py: number;
          if (swaps) {
            px = cx + (y - adj) * dx;
            py = cy + x * dy;
          } else {
            px = cx + x * dx;
            py = cy + (y - adj) * dy;
          }
          const pixCol = this.getPixelColorXY(px, py);
          this.setPixelColorXY(
            px,
            py,
            adj
              ? color_blend(pixCol, col, fade)
              : color_blend(col, pixCol, fade),
          );
        }
        x++;
      }
    } else {
      // Bresenham's algorithm
      let d = 3 - 2 * radius;
      let y = radius;
      let x = 0;
      while (y >= x) {
        for (let i = 0; i < 4; i++) {
          const dx = i & 1 ? -x : x;
          const dy = i & 2 ? -y : y;
          this.setPixelColorXY(cx + dx, cy + dy, col);
          this.setPixelColorXY(cx + dy, cy + dx, col);
        }
        x++;
        if (d > 0) {
          y--;
          d += 4 * (x - y) + 10;
        } else {
          d += 4 * x + 6;
        }
      }
    }
  }

  fillCircle(
    cx: number,
    cy: number,
    radius: number,
    col: number,
    soft = false,
  ): void {
    if (radius === 0) return;
    if (soft) this.drawCircle(cx, cy, radius, col, soft);
    for (let y = -radius; y <= radius; y++) {
      for (let x = -radius; x <= radius; x++) {
        if (
          x * x + y * y <= radius * radius &&
          cx + x >= 0 &&
          cy + y >= 0 &&
          cx + x < this.width &&
          cy + y < this.height
        ) {
          this.setPixelColorXY(cx + x, cy + y, col);
        }
      }
    }
  }

  /**
   * wu_pixel: anti-aliased sub-pixel plot; x/y are 24.8 fixed point. Saturating
   * per-channel add (qadd8), matching the firmware's CRGB math.
   */
  wu_pixel(x: number, y: number, c: number): void {
    const xx = x & 0xff;
    const yy = y & 0xff;
    const ix = 255 - xx;
    const iy = 255 - yy;
    const wuWeight = (a: number, b: number): number => (a * b + a + b) >> 8;
    const wu = [
      wuWeight(ix, iy),
      wuWeight(xx, iy),
      wuWeight(ix, yy),
      wuWeight(xx, yy),
    ];
    const cr = R(c);
    const cg = G(c);
    const cb = B(c);
    for (let i = 0; i < 4; i++) {
      const wuX = (x >> 8) + (i & 1);
      const wuY = (y >> 8) + ((i >> 1) & 1);
      const led = this.getPixelColorXY(wuX, wuY);
      const r = qadd8(R(led), (cr * wu[i]) >> 8);
      const g = qadd8(G(led), (cg * wu[i]) >> 8);
      const b = qadd8(B(led), (cb * wu[i]) >> 8);
      this.setPixelColorXY(wuX, wuY, ((r << 16) | (g << 8) | b) >>> 0);
    }
  }
}
