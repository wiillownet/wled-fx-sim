// SPDX-License-Identifier: EUPL-1.2
// Ported from WLED v16.0.0 (commit 4374f01) wled00/FXparticleSystem.cpp/.h (2D engine
// + PS-2D effects).
// Copyright (c) 2016-present Christian Schwinne and individual WLED contributors
/**
 * Port of WLED's 2D particle-system engine (wled00/FXparticleSystem.h/.cpp, tag
 * v16.0.0) -- the shared physics/rendering framework the "PS" 2D matrix effects
 * build on. Firmware logic matched line-for-line (emit incl. circular spray
 * rejection, flame/angle emit, gravity, wall bounce with roughness, binned
 * collisions with impulse + push-apart, fire update mode, advanced size control
 * with wobble/asymmetry, 2×2 bilinear + ellipse rendering with the PS→frame
 * y-flip) at perceptual accuracy, not frame-parity (decisions.md, 2026-07-17).
 *
 * Same adaptations as the 1D port (particles-1d.ts): plain arrays stashed
 * per-Segment2D in a WeakMap (auto-cleared on sim reset), `SEGMENT.*` routed
 * through the held Segment2D, `hw_random*` through seg.rng, gammaCorrectCol
 * false (canvas owns display gamma), particle saturation approximated by
 * desaturating toward luma instead of the CHSV32 roundtrip. int8 velocities and
 * int16 positions are width-emulated (s8/s16) so overflow-dependent motion
 * matches. Coordinate system: PS (0,0) is bottom-left; the frame buffer is
 * top-left row-major, so rendering flips y (as the firmware does).
 */
import type { Segment2D } from './segment-2d.js';
import {
  B,
  G,
  LINEARBLEND,
  LINEARBLEND_NOWRAP,
  R,
  colorFromPalette,
  cos16_t,
  fast_color_scale,
  fast_color_scaleAdd,
  sin16_t,
} from './lib8.js';

// --- constants (FXparticleSystem.h, ESP32 defaults) --------------------------
export const PS_P_RADIUS = 64; // subpixel resolution per pixel
export const PS_P_HALFRADIUS = PS_P_RADIUS >> 1;
const PS_P_RADIUS_SHIFT = 6;
const PS_P_SURFACE = 12; // 2^12 = 64^2
export const PS_P_MINHARDRADIUS = 64;
const PS_P_MINSURFACEHARDNESS = 128;
const PS_P_MAXSPEED = 120;
const MAXPARTICLES_2D = 2048;
const MAXSOURCES_2D = 128;
const SOURCEREDUCTIONFACTOR = 4;

// --- structs (as mutable records) -------------------------------------------
export interface PSparticle2D {
  x: number; // int16 sub-pixel position
  y: number; // int16 sub-pixel position
  ttl: number; // uint16 frames to live
  vx: number; // int8 velocity
  vy: number; // int8 velocity
  hue: number; // uint8 palette index
  sat: number; // uint8 saturation
}

export interface PSparticleFlags2D {
  outofbounds: boolean;
  collide: boolean;
  perpetual: boolean;
  custom1: boolean;
  custom2: boolean;
  custom3: boolean;
}

export interface PSadvancedParticle2D {
  size: number; // uint8
  forcecounter: number; // uint8, packed x/y nibbles
}

export interface PSsizeControl2D {
  asymmetry: number; // uint8
  asymdir: number; // uint8
  maxsize: number;
  minsize: number;
  sizecounter: number; // 4-bit
  wobblecounter: number; // 4-bit
  growspeed: number; // 4-bit
  shrinkspeed: number; // 4-bit
  wobblespeed: number; // 4-bit
  grow: boolean;
  shrink: boolean;
  pulsate: boolean;
  wobble: boolean;
}

export interface PSsource2D {
  minLife: number;
  maxLife: number;
  source: PSparticle2D; // emitter (position/color; its vx/vy unused by emit)
  sourceFlags: PSparticleFlags2D;
  var: number; // int8 speed variation (+/-)
  vx: number; // int8 emit speed
  vy: number; // int8 emit speed
  size: number; // uint8 (advanced)
}

export interface PSsettings2Dt {
  wrapX: boolean;
  wrapY: boolean;
  bounceX: boolean;
  bounceY: boolean;
  killoutofbounds: boolean;
  useGravity: boolean;
  useCollisions: boolean;
  colorByAge: boolean;
}

/** All-false PSsettings2D -- for effects that pass custom move options. */
export function newPSsettings2D(): PSsettings2Dt {
  return {
    wrapX: false,
    wrapY: false,
    bounceX: false,
    bounceY: false,
    killoutofbounds: false,
    useGravity: false,
    useCollisions: false,
    colorByAge: false,
  };
}

function newParticle2D(): PSparticle2D {
  return { x: 0, y: 0, ttl: 0, vx: 0, vy: 0, hue: 0, sat: 255 };
}
function newFlags2D(): PSparticleFlags2D {
  return {
    outofbounds: false,
    collide: false,
    perpetual: false,
    custom1: false,
    custom2: false,
    custom3: false,
  };
}
function newSizeControl2D(): PSsizeControl2D {
  return {
    asymmetry: 0,
    asymdir: 0,
    maxsize: 0,
    minsize: 0,
    sizecounter: 0,
    wobblecounter: 0,
    growspeed: 0,
    shrinkspeed: 0,
    wobblespeed: 0,
    grow: false,
    shrink: false,
    pulsate: false,
    wobble: false,
  };
}

// C++ storage-width emulation (matters for overflow-dependent motion)
const s8 = (v: number): number => (v << 24) >> 24;
const s16 = (v: number): number => (v << 16) >> 16;
const u16 = (v: number): number => v & 0xffff;

function limitSpeed(speed: number): number {
  return speed > PS_P_MAXSPEED
    ? PS_P_MAXSPEED
    : speed < -PS_P_MAXSPEED
      ? -PS_P_MAXSPEED
      : speed;
}

// force is 3.4 fixed point; small forces accumulate via the counter
function calcForce_dv(force: number, counter: { v: number }): number {
  if (force === 0) return 0;
  const forceAbs = Math.abs(force);
  let dv = 0;
  if (forceAbs < 16) {
    counter.v = (counter.v + forceAbs) & 0xff;
    if (counter.v > 15) {
      counter.v -= 16;
      dv = force < 0 ? -1 : 1;
    }
  } else {
    dv = Math.trunc(force / 16);
  }
  return dv;
}

// returns false if the particle has fully left the axis (wraps in place if set)
function checkBoundsAndWrap(
  pos: { v: number },
  max: number,
  particleradius: number,
  wrap: boolean,
): boolean {
  if (pos.v >>> 0 > max >>> 0) {
    if (wrap) {
      pos.v = pos.v % (max + 1);
      if (pos.v < 0) pos.v += max + 1;
    } else if (pos.v < -particleradius || pos.v > max + particleradius) {
      return false;
    }
  }
  return true;
}

// desaturate a packed color toward its luma (stand-in for the CHSV32 roundtrip)
function applySaturation(color: number, sat: number): number {
  if (sat >= 255) return color;
  const r = R(color);
  const g = G(color);
  const b = B(color);
  const luma = (r * 77 + g * 150 + b * 29) >> 8;
  const mix = (c: number): number => (c * sat + luma * (255 - sat)) >> 8;
  return ((mix(r) << 16) | (mix(g) << 8) | mix(b)) >>> 0;
}

// linear-falloff ellipse brightness (FXparticleSystem.h calculateEllipseBrightness)
function calculateEllipseBrightness(
  dx: number,
  dy: number,
  rxsq: number,
  rysq: number,
  maxBrightness: number,
): number {
  const distSq =
    Math.trunc((dx * dx * 256) / rxsq) + Math.trunc((dy * dy * 256) / rysq);
  if (distSq >= 256) return 0;
  return (maxBrightness * (256 - distSq)) >> 8;
}

export class ParticleSystem2D {
  particles: PSparticle2D[];
  particleFlags: PSparticleFlags2D[];
  sources: PSsource2D[];
  advPartProps: PSadvancedParticle2D[] | null;
  advPartSize: PSsizeControl2D[] | null;

  maxX = 0;
  maxY = 0;
  maxXpixel = 0;
  maxYpixel = 0;
  numSources: number;
  numParticles: number;
  usedParticles: number;
  perParticleSize: boolean;

  private seg: Segment2D;
  private settings: PSsettings2Dt = newPSsettings2D();
  private emitIndex = 0;
  private collisionStartIdx = 0;
  private collisionHardness = 256; // hardness + 1 (setCollisionHardness)
  private particleHardRadius = PS_P_MINHARDRADIUS;
  private wallHardness = 255;
  private wallRoughness = 0;
  private gforce = 0;
  private gforcecounter = { v: 0 };
  private forcecounter = { v: 0 };
  private particlesize = 1;
  private motionBlur = 0;
  private smearBlur = 0;
  private fireIntensity = 0; // nonzero only in updateFire (fire render mode)

  constructor(
    seg: Segment2D,
    width: number,
    height: number,
    numberofparticles: number,
    numberofsources: number,
    isadvanced: boolean,
    sizecontrol: boolean,
  ) {
    this.seg = seg;
    this.numSources = numberofsources;
    this.numParticles = numberofparticles;
    this.usedParticles = numberofparticles;
    this.particles = Array.from({ length: numberofparticles }, newParticle2D);
    this.particleFlags = Array.from({ length: numberofparticles }, newFlags2D);
    this.advPartProps = isadvanced
      ? Array.from({ length: numberofparticles }, () => ({
          size: 0,
          forcecounter: 0,
        }))
      : null;
    this.advPartSize = sizecontrol
      ? Array.from({ length: numberofparticles }, newSizeControl2D)
      : null;
    this.sources = Array.from({ length: numberofsources }, () => ({
      minLife: 0,
      maxLife: 0,
      source: { ...newParticle2D(), ttl: 1 },
      sourceFlags: newFlags2D(),
      var: 0,
      vx: 0,
      vy: 0,
      size: 0,
    }));
    this.setMatrixSize(width, height);
    this.setWallHardness(255);
    this.setWallRoughness(0);
    this.setGravity(0);
    this.setParticleSize(1); // 2x2 rendering by default (2D differs from 1D here)
    this.perParticleSize = isadvanced;
  }

  // --- setters -------------------------------------------------------------
  setUsedParticles(percentage: number): void {
    this.usedParticles = Math.max(
      1,
      (this.numParticles * ((percentage & 0xff) + 1)) >> 8,
    );
  }
  setWallHardness(hardness: number): void {
    this.wallHardness = hardness & 0xff;
  }
  setWallRoughness(roughness: number): void {
    this.wallRoughness = roughness & 0xff;
  }
  setCollisionHardness(hardness: number): void {
    this.collisionHardness = (hardness & 0xff) + 1;
  }
  setMatrixSize(x: number, y: number): void {
    this.maxXpixel = x - 1;
    this.maxYpixel = y - 1;
    this.maxX = x * PS_P_RADIUS - 1;
    this.maxY = y * PS_P_RADIUS - 1;
  }
  setWrapX(enable: boolean): void {
    this.settings.wrapX = enable;
  }
  setWrapY(enable: boolean): void {
    this.settings.wrapY = enable;
  }
  setBounceX(enable: boolean): void {
    this.settings.bounceX = enable;
  }
  setBounceY(enable: boolean): void {
    this.settings.bounceY = enable;
  }
  setKillOutOfBounds(enable: boolean): void {
    this.settings.killoutofbounds = enable;
  }
  setColorByAge(enable: boolean): void {
    this.settings.colorByAge = enable;
  }
  setMotionBlur(amount: number): void {
    this.motionBlur = amount & 0xff;
  }
  setSmearBlur(amount: number): void {
    this.smearBlur = amount & 0xff;
  }
  setParticleSize(size: number): void {
    this.particlesize = size & 0xff;
    this.particleHardRadius = PS_P_MINHARDRADIUS;
    this.perParticleSize = false;
    if (this.particlesize > 1)
      this.particleHardRadius =
        PS_P_MINHARDRADIUS + ((this.particlesize * 52) >> 6);
    else if (this.particlesize === 0)
      this.particleHardRadius = PS_P_MINHARDRADIUS >> 1;
  }
  setGravity(force = 8): void {
    if (force) {
      this.gforce = s8(force);
      this.settings.useGravity = true;
    } else this.settings.useGravity = false;
  }
  enableParticleCollisions(enable: boolean, hardness = 255): void {
    this.settings.useCollisions = enable;
    this.collisionHardness = (hardness & 0xff) + 1;
  }

  // --- system update -------------------------------------------------------
  updateSystem(): void {
    this.setMatrixSize(this.seg.width, this.seg.height);
  }

  update(): void {
    if (this.settings.useGravity) this.applyGravityAll();

    if (this.advPartSize !== null && this.advPartProps !== null) {
      for (let i = 0; i < this.usedParticles; i++) {
        if (!this.updateSize(this.advPartProps[i], this.advPartSize[i])) {
          this.particles[i].ttl = 0; // shrunk to zero
        }
      }
    }

    if (this.settings.useCollisions) this.handleCollisions();

    for (let i = 0; i < this.usedParticles; i++) {
      this.particleMoveUpdate(
        this.particles[i],
        this.particleFlags[i],
        null,
        this.advPartProps ? this.advPartProps[i] : null,
      );
    }

    this.fireIntensity = 0;
    this.render();
  }

  /** Fire update: dedicated move rules + ttl-driven palette brightness. */
  updateFire(intensity: number): void {
    this.fireParticleupdate();
    this.fireIntensity = intensity > 0 ? intensity : 1;
    this.render();
  }

  // --- emit ----------------------------------------------------------------
  sprayEmit(emitter: PSsource2D): number {
    const rng = this.seg.rng;
    for (let i = 0; i < this.usedParticles; i++) {
      this.emitIndex++;
      if (this.emitIndex >= this.usedParticles) this.emitIndex = 0;
      const p = this.particles[this.emitIndex];
      if (p.ttl === 0) {
        let dx = rng.random16(emitter.var << 1) - emitter.var;
        let dy = rng.random16(emitter.var << 1) - emitter.var;
        if (emitter.var > 5) {
          // circular random distribution for nicer "explosions"
          while (dx * dx + dy * dy > emitter.var * emitter.var) {
            dx = rng.random16(emitter.var << 1) - emitter.var;
            dy = rng.random16(emitter.var << 1) - emitter.var;
          }
        }
        p.vx = s8(emitter.vx + dx);
        p.vy = s8(emitter.vy + dy);
        p.x = s16(emitter.source.x);
        p.y = s16(emitter.source.y);
        p.hue = emitter.source.hue & 0xff;
        p.sat = emitter.source.sat & 0xff;
        this.particleFlags[this.emitIndex].collide =
          emitter.sourceFlags.collide;
        p.ttl = u16(rng.random16(emitter.minLife, emitter.maxLife));
        if (this.advPartProps !== null)
          this.advPartProps[this.emitIndex].size = emitter.size;
        return this.emitIndex;
      }
    }
    return -1;
  }

  /** Flame spray: emitted particle's ttl is extended by the source's ttl. */
  flameEmit(emitter: PSsource2D): void {
    const idx = this.sprayEmit(emitter);
    // firmware quirk kept: index 0 gets no ttl bonus (`if (emitIndex > 0)`)
    if (idx > 0)
      this.particles[idx].ttl = u16(
        this.particles[idx].ttl + emitter.source.ttl,
      );
  }

  /** Emit at angle (0-65535 = 0-360deg, 0 = +x) and speed. */
  angleEmit(emitter: PSsource2D, angle: number, speed: number): number {
    emitter.vx = s8(Math.trunc((cos16_t(angle) * speed) / 32600));
    emitter.vy = s8(Math.trunc((sin16_t(angle) * speed) / 32600));
    return this.sprayEmit(emitter);
  }

  // --- movement ------------------------------------------------------------
  particleMoveUpdate(
    part: PSparticle2D,
    partFlags: PSparticleFlags2D,
    options: PSsettings2Dt | null = null,
    advancedproperties: PSadvancedParticle2D | null = null,
  ): void {
    const opt = options ?? this.settings;
    if (part.ttl <= 0) return;

    if (!partFlags.perpetual) part.ttl--;
    if (opt.colorByAge) part.hue = Math.min(part.ttl, 255);

    let renderradius = PS_P_HALFRADIUS - 1 + this.particlesize;
    const newX = { v: part.x + part.vx };
    const newY = { v: part.y + part.vy };
    partFlags.outofbounds = false;

    if (this.perParticleSize && advancedproperties !== null) {
      renderradius = PS_P_HALFRADIUS - 1 + advancedproperties.size;
      if (advancedproperties.size > 0)
        this.particleHardRadius =
          PS_P_MINHARDRADIUS + ((advancedproperties.size * 52) >> 6);
      else this.particleHardRadius = PS_P_MINHARDRADIUS >> 1;
    }

    if (opt.bounceY) {
      if (
        newY.v < this.particleHardRadius ||
        (newY.v > this.maxY - this.particleHardRadius && !opt.useGravity)
      ) {
        this.bounce(part, 'vy', newY, this.maxY);
      }
    }

    if (!checkBoundsAndWrap(newY, this.maxY, renderradius, opt.wrapY)) {
      partFlags.outofbounds = true;
      if (opt.killoutofbounds) {
        if (newY.v < 0)
          part.ttl = 0; // with gravity, only kill below ground
        else if (!opt.useGravity) part.ttl = 0;
      }
    }

    if (part.ttl) {
      if (opt.bounceX) {
        if (
          newX.v < this.particleHardRadius ||
          newX.v > this.maxX - this.particleHardRadius
        ) {
          this.bounce(part, 'vx', newX, this.maxX);
        }
      } else if (
        !checkBoundsAndWrap(newX, this.maxX, renderradius, opt.wrapX)
      ) {
        partFlags.outofbounds = true;
        if (opt.killoutofbounds) part.ttl = 0;
      }
    }

    part.x = s16(newX.v);
    part.y = s16(newY.v);
  }

  /** Dedicated fire-particle movement (hotter = faster upward, wrapX aware). */
  fireParticleupdate(): void {
    for (let i = 0; i < this.usedParticles; i++) {
      const p = this.particles[i];
      if (p.ttl <= 0) continue;
      p.ttl--;
      const newY = p.y + p.vy + (p.ttl >> 2);
      let newX = p.x + p.vx;
      this.particleFlags[i].outofbounds = false;
      if (newY < -PS_P_HALFRADIUS) {
        this.particleFlags[i].outofbounds = true;
      } else if (newY > this.maxY + PS_P_HALFRADIUS) {
        p.ttl = 0; // moved out at the top
      } else {
        if (newX < 0 || newX > this.maxX) {
          if (this.settings.wrapX) {
            newX = newX % (this.maxX + 1);
            if (newX < 0) newX += this.maxX + 1;
          } else if (
            newX < -PS_P_HALFRADIUS ||
            newX > this.maxX + PS_P_HALFRADIUS
          ) {
            p.ttl = 0; // fully out of view
          }
        }
        p.x = s16(newX);
      }
      p.y = s16(newY);
    }
  }

  // --- advanced size control -----------------------------------------------
  /** Grow/shrink/pulsate/wobble one particle; false when shrunk to zero. */
  updateSize(
    advprops: PSadvancedParticle2D,
    advsize: PSsizeControl2D,
  ): boolean {
    let newsize = advprops.size;
    let counter = advsize.sizecounter;
    let increment = 0;
    if (advsize.grow) increment = advsize.growspeed;
    else if (advsize.shrink) increment = advsize.shrinkspeed;
    if (increment < 9) {
      counter += increment;
      if (counter > 7) {
        counter -= 8;
        increment = 1;
      } else increment = 0;
      advsize.sizecounter = counter & 0x0f;
    } else {
      increment = (increment - 8) << 1;
    }

    if (advsize.grow) {
      if (newsize < advsize.maxsize) {
        newsize += increment;
        if (newsize >= advsize.maxsize) {
          advsize.grow = false;
          newsize = advsize.maxsize;
          if (advsize.pulsate) advsize.shrink = true;
        }
      }
    } else if (advsize.shrink) {
      if (newsize > advsize.minsize) {
        newsize -= increment;
        if (newsize <= advsize.minsize) {
          if (advsize.minsize === 0) return false;
          advsize.shrink = false;
          newsize = advsize.minsize;
          if (advsize.pulsate) advsize.grow = true;
        }
      }
    }
    advprops.size = newsize & 0xff;
    if (advsize.wobble) {
      advsize.asymdir = (advsize.asymdir + advsize.wobblespeed) & 0xff;
    }
    return true;
  }

  /** Asymmetric x/y radii for a wobbling particle. */
  getParticleXYsize(
    advprops: PSadvancedParticle2D,
    advsize: PSsizeControl2D,
  ): { xsize: number; ysize: number } {
    const size = advprops.size;
    const asymdir = advsize.asymdir;
    let deviation = (size * advsize.asymmetry + 255) >> 8;
    // 0 symmetrical, 64 is x, 128 symmetrical, 192 is y
    if (asymdir < 64) {
      deviation = (asymdir * deviation) >> 6;
    } else if (asymdir < 192) {
      deviation = ((128 - asymdir) * deviation) >> 6;
    } else {
      deviation = ((asymdir - 255) * deviation) >> 6;
    }
    return {
      xsize: Math.min(size - deviation, 255),
      ysize: Math.min(size + deviation, 255),
    };
  }

  // --- wall bounce ----------------------------------------------------------
  private bounce(
    part: PSparticle2D,
    incoming: 'vx' | 'vy',
    pos: { v: number },
    maxposition: number,
  ): void {
    const parallel = incoming === 'vx' ? 'vy' : 'vx';
    let inc = s8(-part[incoming]);
    inc = s8((inc * this.wallHardness + 128) >> 8); // energy lost on soft walls
    if (pos.v < this.particleHardRadius) pos.v = this.particleHardRadius;
    else pos.v = maxposition - this.particleHardRadius;
    if (this.wallRoughness) {
      const incAbs = Math.abs(inc);
      const totalspeed = incAbs + Math.abs(part[parallel]);
      // transfer a random portion of incoming speed to parallel speed
      let donatespeed = Math.trunc(
        ((this.seg.rng.random16(incAbs << 1) - incAbs) * this.wallRoughness) /
          255,
      );
      part[parallel] = s8(limitSpeed(part[parallel] + donatespeed));
      donatespeed = s8(totalspeed - Math.abs(part[parallel]));
      inc = inc > 0 ? donatespeed : -donatespeed;
    }
    part[incoming] = s8(inc);
  }

  // --- forces --------------------------------------------------------------
  /** Force on one particle; counterObj holds the packed x/y nibble counter. */
  applyForceCounter(
    part: PSparticle2D,
    xforce: number,
    yforce: number,
    counterObj: { v: number },
  ): void {
    const xcounter = { v: counterObj.v & 0x0f };
    const ycounter = { v: counterObj.v >> 4 };
    const dvx = calcForce_dv(s8(xforce), xcounter);
    const dvy = calcForce_dv(s8(yforce), ycounter);
    counterObj.v = (xcounter.v & 0x0f) | ((ycounter.v << 4) & 0xf0);
    part.vx = s8(limitSpeed(part.vx + dvx));
    part.vy = s8(limitSpeed(part.vy + dvy));
  }

  /** Force on one particle by index (needs advanced props for the counter). */
  applyForceIdx(particleindex: number, xforce: number, yforce: number): void {
    if (this.advPartProps === null) return;
    const adv = this.advPartProps[particleindex];
    const counter = { v: adv.forcecounter };
    this.applyForceCounter(
      this.particles[particleindex],
      xforce,
      yforce,
      counter,
    );
    adv.forcecounter = counter.v;
  }

  /** Force on all particles (shared system counter). */
  applyForce(xforce: number, yforce: number): void {
    let temp = { v: this.forcecounter.v };
    for (let i = 0; i < this.usedParticles; i++) {
      temp = { v: this.forcecounter.v };
      this.applyForceCounter(this.particles[i], xforce, yforce, temp);
    }
    this.forcecounter.v = temp.v;
  }

  applyAngleForceCounter(
    part: PSparticle2D,
    force: number,
    angle: number,
    counterObj: { v: number },
  ): void {
    const xforce = s8(Math.trunc((force * cos16_t(angle)) / 32767));
    const yforce = s8(Math.trunc((force * sin16_t(angle)) / 32767));
    this.applyForceCounter(part, xforce, yforce, counterObj);
  }

  applyAngleForceIdx(
    particleindex: number,
    force: number,
    angle: number,
  ): void {
    if (this.advPartProps === null) return;
    const adv = this.advPartProps[particleindex];
    const counter = { v: adv.forcecounter };
    this.applyAngleForceCounter(
      this.particles[particleindex],
      force,
      angle,
      counter,
    );
    adv.forcecounter = counter.v;
  }

  applyAngleForce(force: number, angle: number): void {
    const xforce = s8(Math.trunc((force * cos16_t(angle)) / 32767));
    const yforce = s8(Math.trunc((force * sin16_t(angle)) / 32767));
    this.applyForce(xforce, yforce);
  }

  private applyGravityAll(): void {
    const dv = calcForce_dv(this.gforce, this.gforcecounter);
    if (dv === 0) return;
    for (let i = 0; i < this.usedParticles; i++) {
      this.particles[i].vy = s8(limitSpeed(this.particles[i].vy - dv));
    }
  }

  /** Gravity on a single particle/source without advancing the counter. */
  applyGravity(part: PSparticle2D): void {
    const bkp = this.gforcecounter.v;
    const dv = calcForce_dv(this.gforce, this.gforcecounter);
    this.gforcecounter.v = bkp;
    part.vy = s8(limitSpeed(part.vy - dv));
  }

  applyFrictionPart(part: PSparticle2D, coefficient: number): void {
    const friction = 255 - coefficient;
    part.vx = s8(Math.trunc((part.vx * friction) / 255));
    part.vy = s8(Math.trunc((part.vy * friction) / 255));
  }

  applyFriction(coefficient: number): void {
    const friction = 255 - coefficient;
    for (let i = 0; i < this.usedParticles; i++) {
      const p = this.particles[i];
      p.vx = s8(Math.trunc((p.vx * friction) / 255));
      p.vy = s8(Math.trunc((p.vy * friction) / 255));
    }
  }

  /** Inverse-square attraction toward an attractor particle. */
  pointAttractor(
    particleindex: number,
    attractor: PSparticle2D,
    strength: number,
    swallow: boolean,
  ): void {
    if (this.advPartProps === null) return;
    const p = this.particles[particleindex];
    const dx = attractor.x - p.x;
    const dy = attractor.y - p.y;
    let distanceSquared = dx * dx + dy * dy;
    if (distanceSquared < 8192) {
      if (swallow) {
        if (p.ttl > 7) p.ttl -= 8;
        else {
          p.ttl = 0;
          return;
        }
      }
      distanceSquared = 2 * PS_P_RADIUS * PS_P_RADIUS;
    }
    const force = Math.trunc((strength << 16) / distanceSquared);
    const xforce = s8(Math.trunc((force * dx) / 1024));
    const yforce = s8(Math.trunc((force * dy) / 1024));
    this.applyForceIdx(particleindex, xforce, yforce);
  }

  // --- rendering -----------------------------------------------------------
  private render(): void {
    const buf = this.seg.pixels;
    const palette = this.seg.getCurrentPalette();
    const blend = this.settings.colorByAge ? LINEARBLEND_NOWRAP : LINEARBLEND;
    const pixelCount = (this.maxXpixel + 1) * (this.maxYpixel + 1);

    if (this.motionBlur) {
      for (let i = 0; i < pixelCount; i++)
        buf[i] = fast_color_scale(buf[i], this.motionBlur);
    } else {
      for (let i = 0; i < pixelCount; i++) buf[i] = 0;
    }

    for (let i = 0; i < this.usedParticles; i++) {
      const p = this.particles[i];
      if (p.ttl === 0 || this.particleFlags[i].outofbounds) continue;
      let brightness: number;
      let baseRGB: number;
      if (this.fireIntensity) {
        brightness = Math.min(p.ttl * (3 + (this.fireIntensity >> 5)) + 5, 255);
        baseRGB = colorFromPalette(
          palette,
          brightness,
          255,
          LINEARBLEND_NOWRAP,
        );
      } else {
        brightness = Math.min(p.ttl << 1, 255);
        baseRGB = colorFromPalette(palette, p.hue, 255, blend);
        if (p.sat < 255) baseRGB = applySaturation(baseRGB, p.sat);
      }
      this.renderParticle(
        i,
        brightness,
        baseRGB,
        this.settings.wrapX,
        this.settings.wrapY,
      );
    }

    if (this.smearBlur) this.seg.blur2D(this.smearBlur, this.smearBlur, true);
  }

  private renderParticle(
    particleindex: number,
    brightness: number,
    color: number,
    wrapX: boolean,
    wrapY: boolean,
  ): void {
    const buf = this.seg.pixels;
    const p = this.particles[particleindex];
    let size = this.particlesize;
    if (this.perParticleSize && this.advPartProps !== null)
      size = 1 + this.advPartProps[particleindex].size;

    if (size === 0) {
      // single-pixel rendering
      const x = p.x >> PS_P_RADIUS_SHIFT;
      const y = p.y >> PS_P_RADIUS_SHIFT;
      if (x >= 0 && x <= this.maxXpixel && y >= 0 && y <= this.maxYpixel) {
        const idx = x + (this.maxYpixel - y) * (this.maxXpixel + 1); // y-flip
        buf[idx] = fast_color_scaleAdd(buf[idx], color, brightness);
      }
      return;
    }
    if (size > 1) {
      this.renderLargeParticle(
        size,
        particleindex,
        brightness,
        color,
        wrapX,
        wrapY,
      );
      return;
    }

    // size 1: standard 2x2 bilinear rendering
    // pixel order: bottom left [0], bottom right [1], top right [2], top left [3]
    const pxlbrightness = [0, 0, 0, 0];
    const pixX = [0, 0, 0, 0];
    const pixY = [0, 0, 0, 0];
    const pixelvalid = [true, true, true, true];

    const xoffset = p.x + PS_P_HALFRADIUS;
    const yoffset = p.y + PS_P_HALFRADIUS;
    const dx = xoffset & (PS_P_RADIUS - 1);
    const dy = yoffset & (PS_P_RADIUS - 1);
    let x = xoffset >> PS_P_RADIUS_SHIFT;
    let y = yoffset >> PS_P_RADIUS_SHIFT;

    pixX[1] = pixX[2] = x;
    pixY[2] = pixY[3] = y;
    x--;
    y--;
    pixX[0] = pixX[3] = x;
    pixY[0] = pixY[1] = y;

    const precal1 = PS_P_RADIUS - dx;
    const precal2 = (PS_P_RADIUS - dy) * brightness;
    const precal3 = dy * brightness;
    pxlbrightness[0] = (precal1 * precal2) >> PS_P_SURFACE;
    pxlbrightness[1] = (dx * precal2) >> PS_P_SURFACE;
    pxlbrightness[2] = (dx * precal3) >> PS_P_SURFACE;
    pxlbrightness[3] = (precal1 * precal3) >> PS_P_SURFACE;

    if (pixX[0] < 0) {
      // left pixels out of frame
      if (wrapX) {
        pixX[0] = pixX[3] = this.maxXpixel;
      } else {
        pixelvalid[0] = pixelvalid[3] = false;
        if (pixX[0] < -1) return;
      }
    } else if (pixX[1] > this.maxXpixel) {
      // right pixels
      if (wrapX) {
        pixX[1] = pixX[2] = 0;
      } else {
        pixelvalid[1] = pixelvalid[2] = false;
        if (pixX[0] > this.maxXpixel) return;
      }
    }

    if (pixY[0] < 0) {
      // bottom pixels out of frame
      if (wrapY) {
        pixY[0] = pixY[1] = this.maxYpixel;
      } else {
        pixelvalid[0] = pixelvalid[1] = false;
        if (pixY[0] < -1) return;
      }
    } else if (pixY[2] > this.maxYpixel) {
      // top pixels
      if (wrapY) {
        pixY[2] = pixY[3] = 0;
      } else {
        pixelvalid[2] = pixelvalid[3] = false;
        if (pixY[2] > this.maxYpixel + 1) return;
      }
    }

    for (let i = 0; i < 4; i++) {
      if (pixelvalid[i]) {
        const idx = pixX[i] + (this.maxYpixel - pixY[i]) * (this.maxXpixel + 1);
        buf[idx] = fast_color_scaleAdd(buf[idx], color, pxlbrightness[i]);
      }
    }
  }

  private renderLargeParticle(
    size: number,
    particleindex: number,
    brightness: number,
    color: number,
    wrapX: boolean,
    wrapY: boolean,
  ): void {
    const buf = this.seg.pixels;
    const p = this.particles[particleindex];
    const xSubcenter = p.x;
    const ySubcenter = p.y;
    const xCenter = xSubcenter >> PS_P_RADIUS_SHIFT;
    const yCenter = ySubcenter >> PS_P_RADIUS_SHIFT;

    let xsize = size;
    let ysize = size;
    if (
      this.advPartSize !== null &&
      this.advPartProps !== null &&
      this.advPartSize[particleindex].asymmetry > 0
    ) {
      ({ xsize, ysize } = this.getParticleXYsize(
        this.advPartProps[particleindex],
        this.advPartSize[particleindex],
      ));
    }

    const rxSubpixel = xsize + PS_P_RADIUS + 1;
    const rySubpixel = ysize + PS_P_RADIUS + 1;
    const rxPixels = rxSubpixel >> PS_P_RADIUS_SHIFT;
    const ryPixels = rySubpixel >> PS_P_RADIUS_SHIFT;
    const xMin = xCenter - rxPixels;
    const xMax = xCenter + rxPixels;
    const yMin = yCenter - ryPixels;
    const yMax = yCenter + ryPixels;
    const matrixX = this.maxXpixel + 1;
    const matrixY = this.maxYpixel + 1;
    const rxSq = rxSubpixel * rxSubpixel;
    const rySq = rySubpixel * rySubpixel;

    for (let py = yMin; py <= yMax; py++) {
      for (let px = xMin; px <= xMax; px++) {
        let renderX = px;
        let renderY = py;
        if (renderX < 0) {
          if (!wrapX) continue;
          renderX += matrixX;
        } else if (renderX > this.maxXpixel) {
          if (!wrapX) continue;
          renderX -= matrixX;
        }
        if (renderY < 0) {
          if (!wrapY) continue;
          renderY += matrixY;
        } else if (renderY > this.maxYpixel) {
          if (!wrapY) continue;
          renderY -= matrixY;
        }
        const dxSubpixel =
          (px << PS_P_RADIUS_SHIFT) - xSubcenter + PS_P_HALFRADIUS;
        const dySubpixel =
          (py << PS_P_RADIUS_SHIFT) - ySubcenter + PS_P_HALFRADIUS;
        const pixelBrightness = calculateEllipseBrightness(
          dxSubpixel,
          dySubpixel,
          rxSq,
          rySq,
          brightness,
        );
        if (pixelBrightness === 0) continue;
        const idx = renderX + (this.maxYpixel - renderY) * matrixX;
        buf[idx] = fast_color_scaleAdd(buf[idx], color, pixelBrightness);
      }
    }
  }

  // --- collisions ----------------------------------------------------------
  private handleCollisions(): void {
    let collDistSq = this.particleHardRadius << 1;
    collDistSq = collDistSq * collDistSq;
    let binWidth = 6 * PS_P_RADIUS;
    let overlap = this.particleHardRadius << 1;
    if (this.perParticleSize && this.advPartProps !== null) overlap = 512;

    const maxBinParticles = Math.max(
      50,
      Math.trunc((this.usedParticles + 1) / 2),
    );
    let numBins = Math.trunc((this.maxX + (binWidth - 1)) / binWidth);
    if (this.usedParticles < maxBinParticles) {
      numBins = 1;
      binWidth = this.maxX + 1;
    }
    const binIndices = new Array<number>(maxBinParticles);
    let nextFrameStartIdx = this.seg.rng.random16(this.usedParticles);
    let pidx = this.collisionStartIdx;

    for (let bin = 0; bin < numBins; bin++) {
      let binParticleCount = 0;
      const binStart = bin * binWidth - overlap;
      const binEnd = binStart + binWidth + (overlap << 1);

      for (let i = 0; i < this.usedParticles; i++) {
        const p = this.particles[pidx];
        if (p.ttl > 0 && p.x >= binStart && p.x <= binEnd) {
          const f = this.particleFlags[pidx];
          if (!f.outofbounds && f.collide) {
            if (binParticleCount >= maxBinParticles) {
              nextFrameStartIdx = pidx;
              break;
            }
            binIndices[binParticleCount++] = pidx;
          }
        }
        pidx++;
        if (pidx >= this.usedParticles) pidx = 0;
      }

      let massratio1 = 0;
      let massratio2 = 0;
      for (let i = 0; i < binParticleCount; i++) {
        const idxI = binIndices[i];
        for (let j = i + 1; j < binParticleCount; j++) {
          const idxJ = binIndices[j];
          if (this.perParticleSize && this.advPartProps !== null) {
            const collDist =
              (PS_P_MINHARDRADIUS << 1) +
              (((this.advPartProps[idxI].size + this.advPartProps[idxJ].size) *
                52) >>
                6);
            collDistSq = collDist * collDist;
            let mass1 = PS_P_RADIUS + this.advPartProps[idxI].size;
            let mass2 = PS_P_RADIUS + this.advPartProps[idxJ].size;
            mass1 = mass1 * mass1; // mass proportional to area
            mass2 = mass2 * mass2;
            const totalmass = mass1 + mass2;
            massratio1 = Math.trunc((mass2 * 256) / totalmass);
            massratio2 = Math.trunc((mass1 * 256) / totalmass);
          }
          const pi = this.particles[idxI];
          const pj = this.particles[idxJ];
          const dx = pj.x + pj.vx - (pi.x + pi.vx); // lookahead distance
          if (dx * dx < collDistSq) {
            const dy = pj.y + pj.vy - (pi.y + pi.vy);
            if (dy * dy < collDistSq)
              this.collideParticles(
                pi,
                pj,
                dx,
                dy,
                collDistSq,
                massratio1,
                massratio2,
              );
          }
        }
      }
    }
    this.collisionStartIdx = nextFrameStartIdx;
  }

  private collideParticles(
    particle1: PSparticle2D,
    particle2: PSparticle2D,
    dx: number,
    dy: number,
    collDistSq: number,
    massratio1: number,
    massratio2: number,
  ): void {
    let distanceSquared = dx * dx + dy * dy;
    let relativeVx = particle2.vx - particle1.vx;
    let relativeVy = particle2.vy - particle1.vy;

    // same position: give them an offset (pushes apart clumped particles)
    if (distanceSquared === 0) {
      dx = -1;
      if (relativeVx < 0) dx = 1;
      else if (relativeVx === 0) relativeVx = 1;
      dy = -1;
      if (relativeVy < 0) dy = 1;
      else if (relativeVy === 0) relativeVy = 1;
      distanceSquared = 2;
    }

    const dotProduct = dx * relativeVx + dy * relativeVy;

    if (dotProduct < 0) {
      // moving towards each other
      const surfacehardness = Math.max(
        this.collisionHardness,
        PS_P_MINSURFACEHARDNESS >> 1,
      );
      const impulse =
        (Math.trunc((-dotProduct << 15) / distanceSquared) * surfacehardness) >>
        8;
      const ximpulse = Math.trunc((impulse * dx) / 32767);
      const yimpulse = Math.trunc((impulse * dy) / 32767);
      if (massratio1) {
        particle1.vx = s8(
          limitSpeed(particle1.vx - ((ximpulse * massratio1) >> 7)),
        );
        particle1.vy = s8(
          limitSpeed(particle1.vy - ((yimpulse * massratio1) >> 7)),
        );
        particle2.vx = s8(
          limitSpeed(particle2.vx + ((ximpulse * massratio2) >> 7)),
        );
        particle2.vy = s8(
          limitSpeed(particle2.vy + ((yimpulse * massratio2) >> 7)),
        );
      } else {
        particle1.vx = s8(particle1.vx - ximpulse);
        particle1.vy = s8(particle1.vy - yimpulse);
        particle2.vx = s8(particle2.vx + ximpulse);
        particle2.vy = s8(particle2.vy + yimpulse);
      }
      if (
        this.collisionHardness < PS_P_MINSURFACEHARDNESS &&
        (this.seg.call & 0x07) === 0
      ) {
        // soft particles turn sticky: apply some friction
        const coeff = this.collisionHardness + (255 - PS_P_MINSURFACEHARDNESS);
        particle1.vx = s8(Math.trunc((particle1.vx * coeff) / 255));
        particle1.vy = s8(Math.trunc((particle1.vy * coeff) / 255));
        particle2.vx = s8(Math.trunc((particle2.vx * coeff) / 255));
        particle2.vy = s8(Math.trunc((particle2.vy * coeff) / 255));
      }
    }

    // particles have volume: push apart if too close and slow
    if (
      distanceSquared < collDistSq &&
      relativeVx * relativeVx + relativeVy * relativeVy < 50
    ) {
      const fairlyrandom = (dotProduct & 0x01) !== 0;
      const pushamount = 1 + ((collDistSq - distanceSquared) >> 13);
      const pushx = s8(dx > 0 ? -pushamount : pushamount);
      const pushy = s8(dy > 0 ? -pushamount : pushamount);

      if (this.collisionHardness < 5) {
        // very soft: stop slow particles so they stick together
        if (fairlyrandom) {
          particle1.vx = 0;
          particle1.vy = 0;
          particle2.vx = 0;
          particle2.vy = 0;
          particle1.x = s16(particle1.x + pushx);
          particle1.y = s16(particle1.y + pushy);
        }
      } else {
        if (fairlyrandom) {
          particle1.vx = s8(particle1.vx + pushx);
          particle1.vy = s8(particle1.vy + pushy);
        } else {
          particle2.vx = s8(particle2.vx - pushx);
          particle2.vy = s8(particle2.vy - pushy);
        }
      }
    }
  }
}

// --- init (module-level, FXparticleSystem.cpp) ------------------------------
function calculateNumberOfParticles2D(
  pixels: number,
  isadvanced: boolean,
  sizecontrol: boolean,
): number {
  let n = Math.max(4, Math.min(pixels, MAXPARTICLES_2D));
  // sizeof(PSparticle)=10, sizeof(PSadvancedParticle)=2
  if (isadvanced) n = Math.trunc((n * 10) / (10 + 2));
  if (sizecontrol) n = Math.trunc(n / 8);
  return (n + 3) & ~0x03;
}

function calculateNumberOfSources2D(
  pixels: number,
  requestedsources: number,
): number {
  let n = Math.min(
    Math.trunc(pixels / SOURCEREDUCTIONFACTOR),
    requestedsources,
  );
  n = Math.max(1, Math.min(n, MAXSOURCES_2D));
  return (n + 3) & ~0x03;
}

const PS2D_STORE = new WeakMap<Segment2D, ParticleSystem2D>();

/**
 * Init a 2D particle system for `seg` (fx first frame) and stash it
 * per-Segment2D. Returns null for a non-matrix segment (effect should fall
 * back, like the firmware's `!strip.isMatrix` bail).
 *
 * The C++ `additionalbytes` arg (extra SEGENV.data past the PS for FX scratch)
 * is dropped -- TS effects keep that in the Segment (aux/step/data) or their
 * own WeakMap, same as the 1D port.
 */
export function initParticleSystem2D(
  seg: Segment2D,
  requestedSources: number,
  advanced = false,
  sizecontrol = false,
): ParticleSystem2D | null {
  if (!seg.is2D()) return null;
  if (sizecontrol) advanced = true; // size control needs advanced properties
  const pixels = seg.width * seg.height;
  const numparticles = calculateNumberOfParticles2D(
    pixels,
    advanced,
    sizecontrol,
  );
  const numsources = calculateNumberOfSources2D(pixels, requestedSources);
  const ps = new ParticleSystem2D(
    seg,
    seg.width,
    seg.height,
    numparticles,
    numsources,
    advanced,
    sizecontrol,
  );
  PS2D_STORE.set(seg, ps);
  return ps;
}

/** Retrieve the particle system created for `seg` (subsequent fx frames). */
export function getParticleSystem2D(seg: Segment2D): ParticleSystem2D | null {
  return PS2D_STORE.get(seg) ?? null;
}
