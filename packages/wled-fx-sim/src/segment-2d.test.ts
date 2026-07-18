// SPDX-License-Identifier: EUPL-1.2
// Test anchors derived from WLED v16.0.0 behavior; test code original to this package.
import { describe, expect, it } from 'vitest';
import { Segment2D } from './segment-2d.js';

const RED = 0xff0000;
const WHITE = 0xffffff;

function litCount(seg: Segment2D): number {
  let n = 0;
  for (let i = 0; i < seg.length; i++) if (seg.pixels[i] !== 0) n++;
  return n;
}

describe('Segment2D addressing', () => {
  it('is a Segment of length width*height with row-major XY', () => {
    const seg = new Segment2D(8, 4);
    expect(seg.length).toBe(32);
    expect(seg.width).toBe(8);
    expect(seg.height).toBe(4);
    seg.setPixelColorXY(3, 2, RED);
    expect(seg.pixels[3 + 2 * 8]).toBe(RED);
    expect(seg.getPixelColorXY(3, 2)).toBe(RED);
    expect(seg.XY(3, 2)).toBe(19);
  });

  it('ignores out-of-bounds writes and reads them as 0', () => {
    const seg = new Segment2D(4, 4);
    seg.setPixelColorXY(-1, 0, RED);
    seg.setPixelColorXY(0, -1, RED);
    seg.setPixelColorXY(4, 0, RED);
    seg.setPixelColorXY(0, 4, RED);
    expect(litCount(seg)).toBe(0);
    expect(seg.getPixelColorXY(-1, 0)).toBe(0);
    expect(seg.getPixelColorXY(4, 4)).toBe(0);
  });

  it('is2D() requires both dimensions above 1', () => {
    expect(new Segment2D(16, 16).is2D()).toBe(true);
    expect(new Segment2D(16, 1).is2D()).toBe(false);
    expect(new Segment2D(1, 16).is2D()).toBe(false);
  });

  it('addPixelColorXY saturates; blendPixelColorXY mixes', () => {
    const seg = new Segment2D(4, 4);
    seg.setPixelColorXY(1, 1, 0x800000);
    seg.addPixelColorXY(1, 1, 0x800000, false);
    expect(seg.getPixelColorXY(1, 1) & 0xffffff).toBe(0xff0000);
    seg.setPixelColorXY(2, 2, 0);
    seg.blendPixelColorXY(2, 2, 0xff0000, 128);
    const r = (seg.getPixelColorXY(2, 2) >>> 16) & 0xff;
    expect(r).toBeGreaterThan(100);
    expect(r).toBeLessThan(160);
  });
});

describe('Segment2D blur', () => {
  it('blur2D seeps light onto 4-neighbors of a lit pixel', () => {
    const seg = new Segment2D(8, 8);
    seg.setPixelColorXY(4, 4, WHITE);
    seg.blur2D(128, 128);
    expect(seg.getPixelColorXY(3, 4)).toBeGreaterThan(0);
    expect(seg.getPixelColorXY(5, 4)).toBeGreaterThan(0);
    expect(seg.getPixelColorXY(4, 3)).toBeGreaterThan(0);
    expect(seg.getPixelColorXY(4, 5)).toBeGreaterThan(0);
    expect(seg.getPixelColorXY(4, 4)).toBeLessThan(WHITE);
  });

  it('blurRows spreads only horizontally, blurCols only vertically', () => {
    const rowSeg = new Segment2D(8, 8);
    rowSeg.setPixelColorXY(4, 4, WHITE);
    rowSeg.blurRows(128);
    expect(rowSeg.getPixelColorXY(3, 4)).toBeGreaterThan(0);
    expect(rowSeg.getPixelColorXY(4, 3)).toBe(0);

    const colSeg = new Segment2D(8, 8);
    colSeg.setPixelColorXY(4, 4, WHITE);
    colSeg.blurCols(128);
    expect(colSeg.getPixelColorXY(4, 3)).toBeGreaterThan(0);
    expect(colSeg.getPixelColorXY(3, 4)).toBe(0);
  });

  it('blur() delegates to a symmetric blur2D (2D firmware behavior)', () => {
    const a = new Segment2D(8, 8);
    const b = new Segment2D(8, 8);
    a.setPixelColorXY(4, 4, WHITE);
    b.setPixelColorXY(4, 4, WHITE);
    a.blur(100);
    b.blur2D(100, 100);
    expect(Array.from(a.pixels)).toEqual(Array.from(b.pixels));
  });

  it('smear blur keeps total light from fading the source away', () => {
    const seg = new Segment2D(8, 8);
    seg.setPixelColorXY(4, 4, 0x404040);
    seg.blur2D(64, 64, true);
    expect(seg.getPixelColorXY(4, 4)).toBeGreaterThan(0x202020);
  });
});

describe('Segment2D move', () => {
  it('moveX shifts pixels left without wrap (vacated edge keeps old value)', () => {
    const seg = new Segment2D(4, 2);
    seg.setPixelColorXY(2, 0, RED);
    seg.moveX(1, false);
    expect(seg.getPixelColorXY(1, 0)).toBe(RED);
  });

  it('moveX wraps pixels around the row', () => {
    const seg = new Segment2D(4, 1);
    // firmware treats height-1 as still movable; use 4x2 to stay a real matrix
    const seg2 = new Segment2D(4, 2);
    seg2.setPixelColorXY(0, 0, RED);
    seg2.moveX(1, true);
    expect(seg2.getPixelColorXY(3, 0)).toBe(RED);
    expect(seg.width).toBe(4);
  });

  it('moveY shifts pixels up and wraps when asked', () => {
    const seg = new Segment2D(2, 4);
    seg.setPixelColorXY(0, 0, RED);
    seg.moveY(1, true);
    expect(seg.getPixelColorXY(0, 3)).toBe(RED);
  });

  it('move(4) shifts right, move(6) shifts down', () => {
    const seg = new Segment2D(4, 4);
    seg.setPixelColorXY(1, 1, RED);
    seg.move(4, 1, true);
    expect(seg.getPixelColorXY(2, 1)).toBe(RED);
    seg.move(6, 1, true);
    expect(seg.getPixelColorXY(2, 2)).toBe(RED);
  });

  it('ignores a delta as large as the axis', () => {
    const seg = new Segment2D(4, 4);
    seg.setPixelColorXY(1, 1, RED);
    seg.moveX(4, true);
    seg.moveY(7, false);
    expect(seg.getPixelColorXY(1, 1)).toBe(RED);
  });
});

describe('Segment2D drawing', () => {
  it('drawLine (hard) draws a full diagonal', () => {
    const seg = new Segment2D(6, 6);
    seg.drawLine(0, 0, 5, 5, RED);
    for (let i = 0; i < 6; i++) expect(seg.getPixelColorXY(i, i)).toBe(RED);
  });

  it('drawLine rejects out-of-range endpoints without touching the buffer', () => {
    const seg = new Segment2D(6, 6);
    seg.drawLine(0, 0, 6, 3, RED);
    expect(litCount(seg)).toBe(0);
  });

  it('drawCircle traces a ring, fillCircle fills its interior', () => {
    const ring = new Segment2D(9, 9);
    ring.drawCircle(4, 4, 3, RED);
    expect(ring.getPixelColorXY(4, 4)).toBe(0); // center untouched
    expect(ring.getPixelColorXY(4, 1)).toBe(RED); // top of ring
    expect(ring.getPixelColorXY(4, 7)).toBe(RED); // bottom

    const disc = new Segment2D(9, 9);
    disc.fillCircle(4, 4, 3, RED);
    expect(disc.getPixelColorXY(4, 4)).toBe(RED);
    expect(disc.getPixelColorXY(4, 1)).toBe(RED);
    expect(disc.getPixelColorXY(0, 0)).toBe(0);
  });

  it('wu_pixel splits brightness across the 2x2 neighborhood', () => {
    const seg = new Segment2D(8, 8);
    // (3.5, 3.5) in 24.8 fixed point -> equal spread over 4 pixels
    seg.wu_pixel((3 << 8) | 128, (3 << 8) | 128, 0xfcfcfc);
    const quads = [
      seg.getPixelColorXY(3, 3),
      seg.getPixelColorXY(4, 3),
      seg.getPixelColorXY(3, 4),
      seg.getPixelColorXY(4, 4),
    ];
    for (const q of quads) expect(q).toBeGreaterThan(0);
    expect(litCount(seg)).toBe(4);
  });

  it('inherited 1D helpers operate over the whole matrix', () => {
    const seg = new Segment2D(4, 4);
    seg.fill(0x808080);
    seg.fadeToBlackBy(128);
    // fast_color_scale(0x80, 255-128) = 0x80*127/256 = 0x3f
    for (let i = 0; i < seg.length; i++) {
      expect(seg.pixels[i]).toBe(0x3f3f3f);
    }
  });
});
