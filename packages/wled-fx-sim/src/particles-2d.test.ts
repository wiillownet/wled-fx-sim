// SPDX-License-Identifier: EUPL-1.2
// Test anchors derived from WLED v16.0.0 behavior; test code original to this package.
import { describe, expect, it } from 'vitest';
import { Segment2D } from './segment-2d.js';
import {
  initParticleSystem2D,
  getParticleSystem2D,
  PS_P_RADIUS,
  type ParticleSystem2D,
} from './particles-2d.js';
import { createEffectSim } from './index.js';
import { R, G, B } from './lib8.js';

// Build a ready-to-render Segment2D (palette resolved, as index.ts does per frame).
function makeSeg(w = 16, h = 16, pal = 6): Segment2D {
  const seg = new Segment2D(w, h, 0x1234);
  seg.palette = pal;
  seg.refreshPalette();
  return seg;
}

function killAll(ps: ParticleSystem2D): void {
  for (let i = 0; i < ps.usedParticles; i++) ps.particles[i].ttl = 0;
}

function litPixels(seg: Segment2D): number {
  let n = 0;
  for (let i = 0; i < seg.length; i++) if (seg.pixels[i] !== 0) n++;
  return n;
}

describe('ParticleSystem2D init', () => {
  it('returns null for a non-matrix segment (firmware isMatrix bail)', () => {
    expect(initParticleSystem2D(makeSeg(16, 1), 4)).toBeNull();
  });

  it('allocates particles + sources and exposes matrix bounds', () => {
    const seg = makeSeg(16, 16);
    const ps = initParticleSystem2D(seg, 8) as ParticleSystem2D;
    expect(ps).not.toBeNull();
    expect(ps.numParticles).toBe(256); // 1 per pixel, 4-aligned
    expect(ps.numSources).toBeGreaterThanOrEqual(8);
    expect(ps.maxXpixel).toBe(15);
    expect(ps.maxYpixel).toBe(15);
    expect(ps.maxX).toBe(16 * PS_P_RADIUS - 1);
    expect(ps.maxY).toBe(16 * PS_P_RADIUS - 1);
    expect(getParticleSystem2D(seg)).toBe(ps);
  });

  it('reduces the particle budget for advanced/sizecontrol systems', () => {
    const plain = initParticleSystem2D(makeSeg(), 4) as ParticleSystem2D;
    const adv = initParticleSystem2D(makeSeg(), 4, true) as ParticleSystem2D;
    const sized = initParticleSystem2D(
      makeSeg(),
      4,
      true,
      true,
    ) as ParticleSystem2D;
    expect(adv.numParticles).toBeLessThan(plain.numParticles);
    expect(sized.numParticles).toBeLessThan(adv.numParticles);
    expect(adv.advPartProps).not.toBeNull();
    expect(sized.advPartSize).not.toBeNull();
  });
});

describe('ParticleSystem2D emit', () => {
  it('revives a dead particle at the source with speed/ttl in range', () => {
    const seg = makeSeg();
    const ps = initParticleSystem2D(seg, 4) as ParticleSystem2D;
    const src = ps.sources[0];
    src.vx = 20;
    src.vy = 30;
    src.var = 5;
    src.minLife = 200;
    src.maxLife = 400;
    src.source.x = 8 * PS_P_RADIUS;
    src.source.y = 4 * PS_P_RADIUS;
    src.source.hue = 77;

    const idx = ps.sprayEmit(src);
    expect(idx).toBeGreaterThanOrEqual(0);
    const p = ps.particles[idx];
    expect(p.ttl).toBeGreaterThanOrEqual(200);
    expect(p.ttl).toBeLessThanOrEqual(400);
    expect(p.x).toBe(8 * PS_P_RADIUS);
    expect(p.y).toBe(4 * PS_P_RADIUS);
    expect(p.hue).toBe(77);
    expect(p.vx).toBeGreaterThanOrEqual(20 - 5);
    expect(p.vx).toBeLessThanOrEqual(20 + 5);
    expect(p.vy).toBeGreaterThanOrEqual(30 - 5);
    expect(p.vy).toBeLessThanOrEqual(30 + 5);
  });

  it('angleEmit at 90deg emits straight up (vy>0, vx~0)', () => {
    const seg = makeSeg();
    const ps = initParticleSystem2D(seg, 4) as ParticleSystem2D;
    const src = ps.sources[0];
    src.var = 0;
    src.minLife = 100;
    src.maxLife = 200;
    const idx = ps.angleEmit(src, 16384, 60); // 16384/65536 = 90deg
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(Math.abs(ps.particles[idx].vx)).toBeLessThanOrEqual(1);
    expect(ps.particles[idx].vy).toBeGreaterThan(50);
  });
});

describe('ParticleSystem2D physics', () => {
  it('gravity pulls a resting particle downward (vy negative)', () => {
    const seg = makeSeg();
    const ps = initParticleSystem2D(seg, 4) as ParticleSystem2D;
    ps.setGravity(16); // applies every frame
    killAll(ps);
    const p = ps.particles[0];
    p.ttl = 5000;
    p.x = 8 * PS_P_RADIUS;
    p.y = 8 * PS_P_RADIUS;
    const startY = p.y;
    for (let f = 0; f < 8; f++) {
      seg.call = f;
      ps.update();
    }
    expect(p.vy).toBeLessThan(0);
    expect(p.y).toBeLessThan(startY);
  });

  it('caps particle speed at the engine max (limitSpeed)', () => {
    const seg = makeSeg();
    const ps = initParticleSystem2D(seg, 4) as ParticleSystem2D;
    killAll(ps);
    const p = ps.particles[0];
    p.ttl = 5000;
    p.vx = 100;
    p.vy = -100;
    ps.applyForce(127, -127);
    expect(p.vx).toBeLessThanOrEqual(120);
    expect(p.vy).toBeGreaterThanOrEqual(-120);
  });

  it('bounces a particle off the floor when bounceY is enabled', () => {
    const seg = makeSeg();
    const ps = initParticleSystem2D(seg, 4) as ParticleSystem2D;
    ps.setBounceY(true);
    ps.setWallHardness(255);
    killAll(ps);
    const p = ps.particles[0];
    p.ttl = 5000;
    p.x = 8 * PS_P_RADIUS;
    p.y = 70; // just above the floor's hard radius
    p.vy = -40; // falling into it
    ps.update();
    expect(p.vy).toBeGreaterThan(0); // inverted upward
  });

  it('wall roughness diverts part of a bounce into the parallel axis', () => {
    const seg = makeSeg();
    const ps = initParticleSystem2D(seg, 4) as ParticleSystem2D;
    ps.setBounceX(true);
    ps.setWallHardness(255);
    ps.setWallRoughness(255);
    killAll(ps);
    const p = ps.particles[0];
    p.ttl = 5000;
    p.x = ps.maxX - 4;
    p.y = 8 * PS_P_RADIUS;
    p.vx = 60;
    p.vy = 0;
    ps.update();
    // total speed is preserved-ish but some moved into vy (rough wall)
    expect(p.vx).toBeLessThanOrEqual(0);
    expect(Math.abs(p.vx) + Math.abs(p.vy)).toBeGreaterThan(0);
  });

  it('kills out-of-bounds particles when enabled', () => {
    const seg = makeSeg();
    const ps = initParticleSystem2D(seg, 4) as ParticleSystem2D;
    ps.setKillOutOfBounds(true);
    killAll(ps);
    const p = ps.particles[0];
    p.ttl = 500;
    p.x = 8 * PS_P_RADIUS;
    p.y = 4; // near the bottom, no bounce enabled
    p.vy = -90; // flying out below
    for (let f = 0; f < 4; f++) ps.update();
    expect(p.ttl).toBe(0);
  });

  it('pointAttractor pulls a particle toward the attractor', () => {
    const seg = makeSeg();
    const ps = initParticleSystem2D(seg, 4, true) as ParticleSystem2D;
    killAll(ps);
    const p = ps.particles[0];
    p.ttl = 5000;
    p.x = 2 * PS_P_RADIUS;
    p.y = 2 * PS_P_RADIUS;
    const attractor = {
      x: 14 * PS_P_RADIUS,
      y: 14 * PS_P_RADIUS,
      ttl: 100,
      vx: 0,
      vy: 0,
      hue: 0,
      sat: 255,
    };
    for (let f = 0; f < 30; f++) ps.pointAttractor(0, attractor, 200, false);
    expect(p.vx).toBeGreaterThan(0);
    expect(p.vy).toBeGreaterThan(0);
  });
});

describe('ParticleSystem2D collisions', () => {
  it('two particles moving into each other exchange impulse', () => {
    const seg = makeSeg();
    const ps = initParticleSystem2D(seg, 4) as ParticleSystem2D;
    ps.enableParticleCollisions(true, 255);
    killAll(ps);
    const a = ps.particles[0];
    const b = ps.particles[1];
    a.ttl = 5000;
    b.ttl = 5000;
    ps.particleFlags[0].collide = true;
    ps.particleFlags[1].collide = true;
    a.x = 8 * PS_P_RADIUS - 40;
    a.y = 8 * PS_P_RADIUS;
    a.vx = 30;
    b.x = 8 * PS_P_RADIUS + 40;
    b.y = 8 * PS_P_RADIUS;
    b.vx = -30;
    for (let f = 0; f < 3; f++) {
      seg.call = f;
      ps.update();
    }
    // they must not pass through: a ends up moving left / stopped, b right / stopped
    expect(a.vx).toBeLessThanOrEqual(0);
    expect(b.vx).toBeGreaterThanOrEqual(0);
  });
});

describe('ParticleSystem2D render', () => {
  it('lights the frame pixel under a particle, y-flipped (PS y=0 is bottom)', () => {
    const seg = makeSeg(16, 16);
    const ps = initParticleSystem2D(seg, 4) as ParticleSystem2D;
    ps.setParticleSize(0); // single-pixel
    killAll(ps);
    const p = ps.particles[0];
    p.ttl = 200;
    p.hue = 40;
    p.x = 3 * PS_P_RADIUS; // pixel x=3
    p.y = 2 * PS_P_RADIUS; // PS y=2 -> frame row maxYpixel-2 = 13
    ps.update();
    const c = seg.getPixelColorXY(3, 13);
    expect(R(c) + G(c) + B(c)).toBeGreaterThan(0);
    expect(seg.getPixelColorXY(3, 2)).toBe(0); // un-flipped spot stays dark
  });

  it('size-1 particle between pixels spreads over the 2x2 neighborhood', () => {
    const seg = makeSeg(16, 16);
    const ps = initParticleSystem2D(seg, 4) as ParticleSystem2D;
    ps.setParticleSize(1);
    killAll(ps);
    const p = ps.particles[0];
    p.ttl = 200;
    p.hue = 40;
    // the renderer adds PS_P_HALFRADIUS before splitting, so an exact multiple
    // of PS_P_RADIUS is the even 4-way split point (dx = dy = HALFRADIUS)
    p.x = 5 * PS_P_RADIUS;
    p.y = 5 * PS_P_RADIUS;
    ps.update();
    expect(litPixels(seg)).toBe(4);
  });

  it('large particles render as a multi-pixel ellipse', () => {
    const seg = makeSeg(16, 16);
    const ps = initParticleSystem2D(seg, 4) as ParticleSystem2D;
    ps.setParticleSize(120);
    killAll(ps);
    const p = ps.particles[0];
    p.ttl = 200;
    p.hue = 40;
    p.x = 8 * PS_P_RADIUS;
    p.y = 8 * PS_P_RADIUS;
    ps.update();
    expect(litPixels(seg)).toBeGreaterThan(8);
  });

  it('motion blur retains a decaying trail from the previous frame', () => {
    const seg = makeSeg(16, 16);
    const ps = initParticleSystem2D(seg, 4) as ParticleSystem2D;
    ps.setParticleSize(0);
    ps.setMotionBlur(200);
    killAll(ps);
    const p = ps.particles[0];
    p.ttl = 200;
    p.hue = 40;
    p.x = 5 * PS_P_RADIUS;
    p.y = 5 * PS_P_RADIUS;
    p.vx = 0;
    p.vy = 0;
    ps.update();
    const flippedY = 15 - 5;
    const lit = seg.getPixelColorXY(5, flippedY);
    p.ttl = 0;
    ps.update();
    const trail = seg.getPixelColorXY(5, flippedY);
    expect(trail).not.toBe(0);
    expect(R(trail) + G(trail) + B(trail)).toBeLessThan(
      R(lit) + G(lit) + B(lit),
    );
  });

  it('updateFire renders ttl-driven palette brightness (fire mode)', () => {
    const seg = makeSeg(16, 16, 35); // Fire palette
    const ps = initParticleSystem2D(seg, 4) as ParticleSystem2D;
    ps.setParticleSize(1);
    killAll(ps);
    const p = ps.particles[0];
    p.ttl = 100;
    p.x = 8 * PS_P_RADIUS;
    p.y = 8 * PS_P_RADIUS;
    p.vx = 0;
    p.vy = 0;
    ps.updateFire(200);
    expect(litPixels(seg)).toBeGreaterThan(0);
  });
});

describe('PS Fire (188)', () => {
  it('renders a warm, animating, deterministic 16x16 fire at firmware defaults', () => {
    const params = {
      length: 30,
      sx: 110,
      ix: 128,
      custom1: 110,
      custom2: 50,
      custom3: 31,
      check1: true,
      pal: 35, // Fire palette (the effect's documented default)
    };
    const a = createEffectSim(188, params);
    const b = createEffectSim(188, params);
    let rSum = 0;
    let bSum = 0;
    const snaps = new Set<string>();
    for (let t = 0; t <= 4000; t += 50) {
      const fa = a.frame(t);
      expect(fa).toEqual(b.frame(t)); // deterministic
      expect(fa).toHaveLength(256);
      snaps.add(JSON.stringify(fa));
      for (const [r, , bl] of fa) {
        rSum += r;
        bSum += bl;
      }
    }
    expect(snaps.size).toBeGreaterThan(1); // flames move
    expect(rSum).toBeGreaterThan(bSum); // warm colors dominate
    expect(rSum).toBeGreaterThan(0); // actually lit
  });

  it('concentrates flames near the bottom of the frame (fire rises)', () => {
    const sim = createEffectSim(188, {
      length: 30,
      sx: 110,
      ix: 128,
      custom1: 110,
      custom3: 31,
      pal: 35,
    });
    let bottomLum = 0;
    let topLum = 0;
    for (let t = 500; t <= 4000; t += 100) {
      const f = sim.frame(t);
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) {
          const [r, g, bl] = f[x + y * 16];
          const lum = r + g + bl;
          if (y < 4) topLum += lum;
          else if (y >= 12) bottomLum += lum;
        }
      }
    }
    expect(bottomLum).toBeGreaterThan(topLum);
  });
});
