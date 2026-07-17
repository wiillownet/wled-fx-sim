import { describe, expect, it } from 'vitest';
import { Segment } from './segment.js';
import {
  initParticleSystem1D,
  getParticleSystem1D,
  PS_P_RADIUS_1D,
  type ParticleSystem1D,
} from './particles-1d.js';
import { createEffectSim } from './index.js';
import { R, G, B } from './lib8.js';

// Build a ready-to-render Segment (palette resolved, as index.ts does per frame).
function makeSeg(length = 40, pal = 6): Segment {
  const seg = new Segment(length, 0x1234);
  seg.palette = pal;
  seg.refreshPalette();
  return seg;
}

describe('ParticleSystem1D init', () => {
  it('returns null for a single-pixel strip (unsupported)', () => {
    expect(initParticleSystem1D(makeSeg(1), 1)).toBeNull();
  });

  it('allocates particles + sources and exposes strip bounds', () => {
    const seg = makeSeg(40);
    const ps = initParticleSystem1D(seg, 1) as ParticleSystem1D;
    expect(ps).not.toBeNull();
    expect(ps.usedParticles).toBeGreaterThanOrEqual(10);
    expect(ps.numSources).toBeGreaterThanOrEqual(1);
    expect(ps.maxXpixel).toBe(39);
    expect(ps.maxX).toBe(40 * PS_P_RADIUS_1D - 1);
    // stashed per-Segment for later frames
    expect(getParticleSystem1D(seg)).toBe(ps);
  });
});

describe('ParticleSystem1D emit', () => {
  it('revives a dead particle at the source with speed/ttl in range', () => {
    const seg = makeSeg(40);
    const ps = initParticleSystem1D(seg, 1) as ParticleSystem1D;
    const src = ps.sources[0];
    src.v = 50;
    src.var = 10;
    src.minLife = 200;
    src.maxLife = 400;
    src.source.x = 12 * PS_P_RADIUS_1D;
    src.source.hue = 77;

    const idx = ps.sprayEmit(src);
    expect(idx).toBeGreaterThanOrEqual(0);
    const p = ps.particles[idx];
    expect(p.ttl).toBeGreaterThanOrEqual(200);
    expect(p.ttl).toBeLessThanOrEqual(400);
    expect(p.x).toBe(12 * PS_P_RADIUS_1D);
    expect(p.hue).toBe(77);
    expect(p.vx).toBeGreaterThanOrEqual(50 - 10);
    expect(p.vx).toBeLessThanOrEqual(50 + 10);
  });
});

describe('ParticleSystem1D physics', () => {
  it('gravity accelerates a resting particle', () => {
    const seg = makeSeg(60);
    const ps = initParticleSystem1D(seg, 1) as ParticleSystem1D;
    ps.setGravity(16); // strong, applies every frame
    // one live, resting particle mid-strip
    for (let i = 0; i < ps.usedParticles; i++) ps.particles[i].ttl = 0;
    const p = ps.particles[0];
    p.ttl = 5000;
    p.x = 30 * PS_P_RADIUS_1D;
    p.vx = 0;
    const startX = p.x;
    for (let f = 0; f < 8; f++) {
      seg.call = f;
      ps.update();
    }
    expect(Math.abs(p.vx)).toBeGreaterThan(0); // gained speed
    expect(p.x).not.toBe(startX); // and moved
  });

  it('caps particle speed at the engine max (limitSpeed)', () => {
    const seg = makeSeg(60);
    const ps = initParticleSystem1D(seg, 1) as ParticleSystem1D;
    for (let i = 0; i < ps.usedParticles; i++) ps.particles[i].ttl = 0;
    const p = ps.particles[0];
    p.ttl = 5000;
    p.vx = 100;
    ps.applyForce(127); // huge push
    expect(p.vx).toBeLessThanOrEqual(120);
    expect(p.vx).toBeGreaterThanOrEqual(-120);
  });

  it('bounces a particle off a wall when bounce is enabled', () => {
    const seg = makeSeg(20);
    const ps = initParticleSystem1D(seg, 1) as ParticleSystem1D;
    ps.setBounce(true);
    ps.setWallHardness(255);
    for (let i = 0; i < ps.usedParticles; i++) ps.particles[i].ttl = 0;
    const p = ps.particles[0];
    p.ttl = 5000;
    p.x = ps.maxX - 4; // right at the wall
    p.vx = 40; // moving into it
    ps.update();
    expect(p.vx).toBeLessThan(0); // velocity inverted
  });
});

describe('ParticleSystem1D render', () => {
  it('lights the pixel a particle sits on', () => {
    const seg = makeSeg(20);
    const ps = initParticleSystem1D(seg, 1) as ParticleSystem1D;
    ps.setParticleSize(0); // single-pixel
    for (let i = 0; i < ps.usedParticles; i++) ps.particles[i].ttl = 0;
    const p = ps.particles[0];
    p.ttl = 200;
    p.hue = 40;
    p.x = 10 * PS_P_RADIUS_1D; // exactly pixel 10
    ps.update();
    const c = seg.pixels[10];
    expect(R(c) + G(c) + B(c)).toBeGreaterThan(0);
  });

  it('motion blur retains a decaying trail from the previous frame', () => {
    const seg = makeSeg(20);
    const ps = initParticleSystem1D(seg, 1) as ParticleSystem1D;
    ps.setParticleSize(0);
    ps.setMotionBlur(200); // strong persistence
    for (let i = 0; i < ps.usedParticles; i++) ps.particles[i].ttl = 0;
    const p = ps.particles[0];
    p.ttl = 200;
    p.hue = 40;
    p.x = 5 * PS_P_RADIUS_1D;
    p.vx = 0;
    ps.update();
    const lit = seg.pixels[5];
    // kill the particle, next frame should keep a (dimmer) blurred remnant
    p.ttl = 0;
    ps.update();
    const trail = seg.pixels[5];
    expect(trail).not.toBe(0);
    expect(R(trail) + G(trail) + B(trail)).toBeLessThan(
      R(lit) + G(lit) + B(lit),
    );
  });
});

describe('PS Spray 1D (208)', () => {
  it('animates a valid, deterministic buffer', () => {
    const params = {
      length: 60,
      sx: 200,
      ix: 220,
      custom1: 128,
      custom2: 40,
      custom3: 8,
      pal: 6,
    };
    const a = createEffectSim(208, params);
    const b = createEffectSim(208, params);
    let lit = false;
    for (let t = 0; t <= 3000; t += 50) {
      const fa = a.frame(t);
      const fb = b.frame(t);
      expect(fa).toEqual(fb); // deterministic
      expect(fa).toHaveLength(60);
      for (const [r, g, bl] of fa)
        for (const ch of [r, g, bl])
          expect(Number.isInteger(ch) && ch >= 0 && ch <= 255).toBe(true);
      if (t > 500 && fa.some(([r, g, bl]) => r + g + bl > 0)) lit = true;
    }
    expect(lit).toBe(true);
  });
});

describe('PS Hourglass (207)', () => {
  // The generic "animated" contract excludes 207 (static under its default
  // params); this proves it does drop + animate once auto-start (check2) is on.
  it('animates when auto-start is enabled', () => {
    const sim = createEffectSim(207, {
      length: 40,
      sx: 5,
      ix: 200,
      custom1: 140,
      custom2: 80,
      custom3: 4,
      check1: true,
      check2: true,
      check3: true,
      pal: 34,
    });
    const snaps = new Set<string>();
    let lit = false;
    for (let t = 0; t <= 8000; t += 100) {
      const f = sim.frame(t);
      snaps.add(JSON.stringify(f));
      if (f.some(([r, g, b]) => r + g + b > 0)) lit = true;
    }
    expect(lit).toBe(true);
    expect(snaps.size).toBeGreaterThan(1);
  });
});
