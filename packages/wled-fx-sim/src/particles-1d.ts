// SPDX-License-Identifier: EUPL-1.2
// Ported from WLED v16.0.0 (commit 4374f01) wled00/FXparticleSystem.cpp/.h (1D engine
// + PS-1D effects, fx 202-213).
// Copyright (c) 2016-present Christian Schwinne and individual WLED contributors
/**
 * Port of WLED's 1D particle-system engine (wled00/FXparticleSystem.h/.cpp, tag
 * v16.0.0) -- the shared physics/rendering framework the "PS" 1D effects (fx ids
 * 202-213) build on. Firmware logic matched line-for-line (emit, gravity,
 * friction, wall bounce, binned collisions, sub-pixel rendering) at perceptual
 * accuracy, not frame-parity (decisions.md, 2026-07-17).
 *
 * Adaptations from the C++:
 * - No raw pointer/SEGENV.data memory model. The system owns plain arrays and is
 *   stashed per-Segment in a WeakMap (auto-cleared when the sim resets, since
 *   reset() builds a fresh Segment). `additionalbytes` is a no-op -- effects keep
 *   their extra scratch in the Segment (aux/step/data) or their own WeakMap.
 * - `SEGMENT.*` reads route through the held Segment: SEGPALETTE ->
 *   seg.getCurrentPalette(), SEGCOLOR(x) -> seg.color(x), the framebuffer -> the
 *   packed seg.pixels buffer, SEGMENT.blur -> seg.blur, SEGMENT.call -> seg.call.
 * - `hw_random*` routes through seg.rng (seeded, deterministic preview).
 * - `gammaCorrectCol` is false (the sim renders linear packed RGB; the canvas
 *   owns display gamma), so the gamma branches are inert -- kept for fidelity.
 * - Particle saturation (advanced prop < 255) desaturates toward luma rather than
 *   a full RGB->HSV->RGB roundtrip; visually equivalent at the perceptual bar.
 */
import type { Segment } from './segment.js';
import {
  B,
  G,
  LINEARBLEND,
  LINEARBLEND_NOWRAP,
  R,
  colorFromPalette,
  fast_color_scale,
  fast_color_scaleAdd,
  gamma8,
  gamma8inv,
} from './lib8.js';
import {
  applySaturation,
  calcForce_dv,
  checkBoundsAndWrap,
  limitSpeed,
  PS_P_MAXSPEED,
} from './particles-common.js';

// --- constants (FXparticleSystem.h) -----------------------------------------
export const PS_P_RADIUS_1D = 32; // subpixel resolution per pixel
const PS_P_HALFRADIUS_1D = PS_P_RADIUS_1D >> 1;
const PS_P_RADIUS_SHIFT_1D = 5; // 1 << shift == PS_P_RADIUS_1D
const PS_P_SURFACE_1D = 5; // 2^surface == PS_P_RADIUS_1D
const PS_P_MINHARDRADIUS_1D = 32; // min hard-surface radius (do not change: hourglass depends on it)
const PS_P_MINSURFACEHARDNESS_1D = 120;
// Generic-ESP32 tier (FXparticleSystem.h:265-266), the #else fallback WLED uses
// for everything that is not ESP8266 or ESP32-S2 -- matching particles-2d.ts.
const MAXPARTICLES_1D = 2600;
const MAXSOURCES_1D = 64;

const GAMMA_CORRECT = false; // sim renders linear; canvas owns display gamma

// --- structs (as mutable records) -------------------------------------------
export interface PSparticle1D {
  x: number; // sub-pixel position (int32)
  ttl: number; // frames to live (uint16)
  vx: number; // velocity (int8, |vx| <= PS_P_MAXSPEED)
  hue: number; // palette index (uint8)
}

export interface PSparticleFlags1D {
  outofbounds: boolean;
  collide: boolean;
  perpetual: boolean; // does not age
  reversegrav: boolean;
  forcedirection: boolean;
  fixed: boolean; // does not move
  custom1: boolean;
  custom2: boolean;
}

export interface PSadvancedParticle1D {
  sat: number; // saturation
  size: number; // per-particle size
  forcecounter: number;
}

export interface PSsource1D {
  minLife: number;
  maxLife: number;
  source: PSparticle1D; // emitter (position/speed/color)
  sourceFlags: PSparticleFlags1D;
  var: number; // speed variation (+/-)
  v: number; // emit speed
  sat: number;
  size: number;
}

export interface PSsettings1D {
  bounce: boolean;
  killoutofbounds: boolean;
  wrap: boolean;
  useGravity: boolean;
  useCollisions: boolean;
  colorByAge: boolean;
  colorByPosition: boolean;
}

/** All-false PSsettings1D -- for effects that pass custom move options (e.g. Sparkler). */
export function newPSsettings1D(): PSsettings1D {
  return {
    bounce: false,
    killoutofbounds: false,
    wrap: false,
    useGravity: false,
    useCollisions: false,
    colorByAge: false,
    colorByPosition: false,
  };
}

function newParticle(): PSparticle1D {
  return { x: 0, ttl: 0, vx: 0, hue: 0 };
}
function newFlags(): PSparticleFlags1D {
  return {
    outofbounds: false,
    collide: false,
    perpetual: false,
    reversegrav: false,
    forcedirection: false,
    fixed: false,
    custom1: false,
    custom2: false,
  };
}

// int8 / uint16 coercion helpers (emulate the C++ storage widths that matter)
const s8 = (v: number): number => (v << 24) >> 24;
const u16 = (v: number): number => v & 0xffff;

export class ParticleSystem1D {
  particles: PSparticle1D[];
  particleFlags: PSparticleFlags1D[];
  sources: PSsource1D[];
  advPartProps: PSadvancedParticle1D[] | null;

  maxX = 0;
  maxXpixel = 0;
  numSources: number;
  numParticles: number;
  usedParticles: number;
  perParticleSize: boolean;

  private seg: Segment;
  private settings: PSsettings1D = {
    bounce: false,
    killoutofbounds: false,
    wrap: false,
    useGravity: false,
    useCollisions: false,
    colorByAge: false,
    colorByPosition: false,
  };
  private emitIndex = 0;
  private collisionStartIdx = 0;
  private collisionHardness = 255;
  private particleHardRadius = PS_P_MINHARDRADIUS_1D;
  private wallHardness = 255;
  private gforce = 0;
  private gforcecounter = { v: 0 };
  private forcecounter = { v: 0 };
  private particlesize = 0;
  private motionBlur = 0;
  private smearBlur = 0;

  constructor(
    seg: Segment,
    length: number,
    numberofparticles: number,
    numberofsources: number,
    isadvanced: boolean,
  ) {
    this.seg = seg;
    this.numSources = numberofsources;
    this.numParticles = numberofparticles;
    this.usedParticles = numberofparticles;
    this.advPartProps = isadvanced
      ? Array.from({ length: numberofparticles }, () => ({
          sat: 255,
          size: 0,
          forcecounter: 0,
        }))
      : null;
    this.particles = Array.from({ length: numberofparticles }, newParticle);
    this.particleFlags = Array.from({ length: numberofparticles }, newFlags);
    this.sources = Array.from({ length: numberofsources }, () => ({
      minLife: 0,
      maxLife: 0,
      source: { ...newParticle(), ttl: 1 },
      sourceFlags: newFlags(),
      var: 0,
      v: 0,
      sat: 255,
      size: 0,
    }));
    this.setSize(length);
    this.setWallHardness(255);
    this.setGravity(0);
    this.setParticleSize(0);
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
  setSize(x: number): void {
    this.maxXpixel = x - 1;
    this.maxX = x * PS_P_RADIUS_1D - 1;
  }
  setWrap(enable: boolean): void {
    this.settings.wrap = enable;
  }
  setBounce(enable: boolean): void {
    this.settings.bounce = enable;
  }
  setKillOutOfBounds(enable: boolean): void {
    this.settings.killoutofbounds = enable;
  }
  setColorByAge(enable: boolean): void {
    this.settings.colorByAge = enable;
  }
  setColorByPosition(enable: boolean): void {
    this.settings.colorByPosition = enable;
  }
  setMotionBlur(amount: number): void {
    this.motionBlur = amount & 0xff;
  }
  setSmearBlur(amount: number): void {
    this.smearBlur = amount & 0xff;
  }
  setParticleSize(size: number): void {
    this.particlesize = size & 0xff;
    this.particleHardRadius = PS_P_MINHARDRADIUS_1D;
    this.perParticleSize = false;
    if (this.particlesize > 1)
      this.particleHardRadius =
        PS_P_MINHARDRADIUS_1D + ((this.particlesize * 52) >> 6);
    else if (this.particlesize === 0)
      this.particleHardRadius = PS_P_MINHARDRADIUS_1D >> 1;
  }
  setGravity(force = 8): void {
    if (force) {
      this.gforce = s8(force);
      this.settings.useGravity = true;
    } else this.settings.useGravity = false;
  }
  enableParticleCollisions(enable: boolean, hardness = 255): void {
    this.settings.useCollisions = enable;
    this.collisionHardness = hardness & 0xff;
  }

  // --- system update -------------------------------------------------------
  updateSystem(): void {
    this.setSize(this.seg.length);
  }

  update(): void {
    if (this.settings.useGravity) this.applyGravityAll();

    if (this.settings.useCollisions) {
      this.handleCollisions();
      if (this.perParticleSize) this.handleCollisions();
    }

    for (let i = 0; i < this.usedParticles; i++) {
      this.particleMoveUpdate(
        this.particles[i],
        this.particleFlags[i],
        null,
        this.advPartProps ? this.advPartProps[i] : null,
      );
    }

    if (this.settings.colorByPosition) {
      const scale = Math.trunc((255 << 16) / this.maxX);
      for (let i = 0; i < this.usedParticles; i++) {
        this.particles[i].hue = (scale * this.particles[i].x) >> 16;
      }
    }

    this.render();
  }

  // --- emit ----------------------------------------------------------------
  sprayEmit(emitter: PSsource1D): number {
    for (let i = 0; i < this.usedParticles; i++) {
      this.emitIndex++;
      if (this.emitIndex >= this.usedParticles) this.emitIndex = 0;
      const p = this.particles[this.emitIndex];
      if (p.ttl === 0) {
        p.vx = s8(
          emitter.v + this.seg.rng.random16(emitter.var << 1) - emitter.var,
        );
        p.x = emitter.source.x;
        p.hue = emitter.source.hue & 0xff;
        p.ttl = u16(this.seg.rng.random16(emitter.minLife, emitter.maxLife));
        const f = this.particleFlags[this.emitIndex];
        f.collide = emitter.sourceFlags.collide;
        f.reversegrav = emitter.sourceFlags.reversegrav;
        f.perpetual = emitter.sourceFlags.perpetual;
        if (this.advPartProps) {
          this.advPartProps[this.emitIndex].sat = emitter.sat;
          this.advPartProps[this.emitIndex].size = emitter.size;
        }
        return this.emitIndex;
      }
    }
    return -1;
  }

  // --- movement ------------------------------------------------------------
  particleMoveUpdate(
    part: PSparticle1D,
    partFlags: PSparticleFlags1D,
    options: PSsettings1D | null = null,
    advancedproperties: PSadvancedParticle1D | null = null,
  ): void {
    const opt = options ?? this.settings;
    if (part.ttl <= 0) return;

    if (!partFlags.perpetual) part.ttl--;
    if (opt.colorByAge) part.hue = Math.min(part.ttl, 255);

    let renderradius = PS_P_HALFRADIUS_1D - 1 + this.particlesize;
    const posBox = { v: part.x + part.vx };
    partFlags.outofbounds = false;

    if (this.perParticleSize && advancedproperties !== null) {
      renderradius = PS_P_HALFRADIUS_1D - 1 + advancedproperties.size;
      if (advancedproperties.size > 1)
        this.particleHardRadius =
          PS_P_MINHARDRADIUS_1D + ((advancedproperties.size * 52) >> 6);
      else this.particleHardRadius = PS_P_MINHARDRADIUS_1D >> 1;
    }

    if (opt.bounce) {
      if (
        posBox.v < this.particleHardRadius ||
        posBox.v > this.maxX - this.particleHardRadius
      ) {
        let bouncethis = true;
        if (opt.useGravity) {
          if (partFlags.reversegrav) {
            if (posBox.v < this.particleHardRadius) bouncethis = false;
          } else if (posBox.v > this.particleHardRadius) {
            bouncethis = false;
          }
        }
        if (bouncethis) {
          part.vx = s8(-part.vx);
          part.vx = s8(Math.trunc((part.vx * this.wallHardness) / 255));
          if (posBox.v < this.particleHardRadius)
            posBox.v = this.particleHardRadius;
          else posBox.v = this.maxX - this.particleHardRadius;
        }
      }
    }

    if (!checkBoundsAndWrap(posBox, this.maxX, renderradius, opt.wrap)) {
      partFlags.outofbounds = true;
      if (opt.killoutofbounds) {
        let killthis = true;
        if (opt.useGravity) {
          if (partFlags.reversegrav) {
            if (posBox.v < 0 || posBox.v > this.maxX << 2) killthis = false;
          } else {
            if (posBox.v > 0 && posBox.v < this.maxX << 2) killthis = false;
          }
        }
        if (killthis) part.ttl = 0;
      }
    }

    if (!partFlags.fixed) part.x = posBox.v;
    else part.vx = 0;
  }

  // --- forces --------------------------------------------------------------
  applyForceOne(
    part: PSparticle1D,
    xforce: number,
    counter: { v: number },
  ): void {
    const dv = calcForce_dv(s8(xforce), counter);
    part.vx = s8(limitSpeed(part.vx + dv));
  }

  applyForce(xforce: number): void {
    const dv = calcForce_dv(s8(xforce), this.forcecounter);
    for (let i = 0; i < this.usedParticles; i++) {
      this.particles[i].vx = s8(limitSpeed(this.particles[i].vx + dv));
    }
  }

  private applyGravityAll(): void {
    const dvRaw = calcForce_dv(this.gforce, this.gforcecounter);
    for (let i = 0; i < this.usedParticles; i++) {
      const dv = this.particleFlags[i].reversegrav ? -dvRaw : dvRaw;
      this.particles[i].vx = s8(limitSpeed(this.particles[i].vx - dv));
    }
  }

  // apply gravity to a single particle/source without advancing the counter
  applyGravity(part: PSparticle1D, partFlags: PSparticleFlags1D): void {
    const bkp = this.gforcecounter.v;
    let dv = calcForce_dv(this.gforce, this.gforcecounter);
    if (partFlags.reversegrav) dv = -dv;
    this.gforcecounter.v = bkp;
    part.vx = s8(limitSpeed(part.vx - dv));
  }

  applyFriction(coefficient: number): void {
    const friction = 255 - coefficient;
    for (let i = 0; i < this.usedParticles; i++) {
      if (this.particles[i].ttl)
        this.particles[i].vx = s8(
          Math.trunc((this.particles[i].vx * friction) / 255),
        );
    }
  }

  // --- rendering -----------------------------------------------------------
  private render(): void {
    const buf = this.seg.pixels;
    const blend =
      this.settings.colorByAge || this.settings.colorByPosition
        ? LINEARBLEND_NOWRAP
        : LINEARBLEND;
    const palette = this.seg.getCurrentPalette();

    if (this.motionBlur) {
      for (let x = 0; x <= this.maxXpixel; x++)
        buf[x] = fast_color_scale(buf[x], this.motionBlur);
    } else {
      for (let x = 0; x <= this.maxXpixel; x++) buf[x] = 0;
    }

    for (let i = 0; i < this.usedParticles; i++) {
      if (this.particles[i].ttl === 0 || this.particleFlags[i].outofbounds)
        continue;
      let brightness = Math.min(this.particles[i].ttl << 1, 255);
      let baseRGB = colorFromPalette(
        palette,
        this.particles[i].hue,
        255,
        blend,
      );
      if (this.advPartProps !== null && this.advPartProps[i].sat < 255)
        baseRGB = applySaturation(baseRGB, this.advPartProps[i].sat);
      if (GAMMA_CORRECT) brightness = gamma8(brightness);
      this.renderParticle(i, brightness, baseRGB, this.settings.wrap);
    }

    if (this.smearBlur) this.seg.blur(this.smearBlur, true);

    const bgColor = this.seg.color(1) & 0x00ffffff;
    if (bgColor > 0) {
      for (let i = 0; i <= this.maxXpixel; i++)
        buf[i] = fast_color_scaleAdd(buf[i], bgColor);
    }
  }

  private renderParticle(
    idx: number,
    brightness: number,
    color: number,
    wrap: boolean,
  ): void {
    const buf = this.seg.pixels;
    let size = this.particlesize;
    if (this.perParticleSize && this.advPartProps !== null)
      size = 1 + this.advPartProps[idx].size;

    if (size === 0) {
      const x = this.particles[idx].x >> PS_P_RADIUS_SHIFT_1D;
      if (x >= 0 && x <= this.maxXpixel)
        buf[x] = fast_color_scaleAdd(buf[x], color, brightness);
      return;
    }
    if (size > 1) {
      this.renderLargeParticle(size, idx, brightness, color, wrap);
      return;
    }

    // standard 2-pixel rendering with sub-pixel interpolation
    const pxlisinframe = [true, true];
    const pxlbrightness = [0, 0];
    const pixco = [0, 0];
    const xoffset = this.particles[idx].x + PS_P_HALFRADIUS_1D;
    const dx = xoffset & (PS_P_RADIUS_1D - 1);
    let x = xoffset >> PS_P_RADIUS_SHIFT_1D;
    pixco[1] = x;
    x--;
    pixco[0] = x;
    pxlbrightness[0] = ((PS_P_RADIUS_1D - dx) * brightness) >> PS_P_SURFACE_1D;
    pxlbrightness[1] = (dx * brightness) >> PS_P_SURFACE_1D;
    if (GAMMA_CORRECT) {
      pxlbrightness[0] = gamma8inv(pxlbrightness[0]);
      pxlbrightness[1] = gamma8inv(pxlbrightness[1]);
    }
    if (pixco[0] < 0) {
      if (wrap) pixco[0] = this.maxXpixel;
      else {
        pxlisinframe[0] = false;
        if (pixco[0] < -1) return;
      }
    } else if (pixco[1] > this.maxXpixel) {
      if (wrap) pixco[1] = 0;
      else {
        pxlisinframe[1] = false;
        if (pixco[0] > this.maxXpixel) return;
      }
    }
    for (let i = 0; i < 2; i++) {
      if (pxlisinframe[i])
        buf[pixco[i]] = fast_color_scaleAdd(
          buf[pixco[i]],
          color,
          pxlbrightness[i],
        );
    }
  }

  private renderLargeParticle(
    size: number,
    idx: number,
    brightness: number,
    color: number,
    wrap: boolean,
  ): void {
    const buf = this.seg.pixels;
    const xSubcenter = this.particles[idx].x;
    const xCenter = xSubcenter >> PS_P_RADIUS_SHIFT_1D;
    const rSubpixel = size + PS_P_RADIUS_1D + 1;
    const rPixels = rSubpixel >> PS_P_RADIUS_SHIFT_1D;
    const xMin = xCenter - rPixels - 1;
    const xMax = xCenter + rPixels + 1;
    const matrixX = this.maxXpixel + 1;

    for (let px = xMin; px <= xMax; px++) {
      let renderX = px;
      if (renderX < 0) {
        if (!wrap) continue;
        renderX += matrixX;
      } else if (renderX > this.maxXpixel) {
        if (!wrap) continue;
        renderX -= matrixX;
      }
      let dxSq = (px << PS_P_RADIUS_SHIFT_1D) - xSubcenter + PS_P_HALFRADIUS_1D;
      dxSq = dxSq * dxSq;
      const rxSq = rSubpixel * rSubpixel;
      const distSq = Math.trunc((dxSq << 8) / rxSq);
      const pixelBrightness =
        distSq >= 256 ? 0 : ((256 - distSq) * brightness) >> 8;
      buf[renderX] = fast_color_scaleAdd(buf[renderX], color, pixelBrightness);
    }
  }

  // --- collisions ----------------------------------------------------------
  private handleCollisions(): void {
    const collisiondistance = this.particleHardRadius << 1;
    let checkDistSq = Math.max(2 * PS_P_MAXSPEED, collisiondistance);
    if (this.perParticleSize && this.advPartProps !== null)
      checkDistSq = Math.max(2 * PS_P_MAXSPEED, (512 * 52) >> 6);
    checkDistSq = checkDistSq * checkDistSq;
    let binWidth = 64 * PS_P_RADIUS_1D;
    let overlap = collisiondistance + 2 * PS_P_MAXSPEED;
    if (this.perParticleSize && this.advPartProps !== null) overlap = 512;
    const maxBinParticles = Math.max(50, (this.usedParticles + 1) >> 2);
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
        if (p.ttl > 0) {
          if (p.x >= binStart && p.x <= binEnd) {
            const f = this.particleFlags[pidx];
            if (!f.outofbounds && f.collide) {
              if (binParticleCount >= maxBinParticles) {
                nextFrameStartIdx = pidx;
                break;
              }
              binIndices[binParticleCount++] = pidx;
            }
          }
        }
        pidx++;
        if (pidx >= this.usedParticles) pidx = 0;
      }
      for (let i = 0; i < binParticleCount; i++) {
        const idxI = binIndices[i];
        for (let j = i + 1; j < binParticleCount; j++) {
          const idxJ = binIndices[j];
          const dx = this.particles[idxJ].x - this.particles[idxI].x;
          if (dx * dx <= checkDistSq)
            this.collideParticles(idxI, idxJ, dx, collisiondistance);
        }
      }
    }
    this.collisionStartIdx = nextFrameStartIdx;
  }

  private collideParticles(
    partIdx1: number,
    partIdx2: number,
    dx: number,
    collisiondistance: number,
  ): void {
    const p1 = this.particles[partIdx1];
    const p2 = this.particles[partIdx2];
    const f1 = this.particleFlags[partIdx1];
    const f2 = this.particleFlags[partIdx2];
    let massratio1 = 0;
    let massratio2 = 0;
    if (this.perParticleSize && this.advPartProps !== null) {
      collisiondistance =
        PS_P_MINHARDRADIUS_1D * 2 +
        (((this.advPartProps[partIdx1].size +
          this.advPartProps[partIdx2].size) *
          52) >>
          6);
      const mass1 = PS_P_RADIUS_1D + this.advPartProps[partIdx1].size;
      const mass2 = PS_P_RADIUS_1D + this.advPartProps[partIdx2].size;
      const totalmass = mass1 + mass2 - 2;
      massratio1 = (mass2 << 8) / totalmass;
      massratio2 = (mass1 << 8) / totalmass;
    }
    const dv = p2.vx - p1.vx;
    const absdv = Math.abs(dv);
    const dotProduct = dx * dv;
    const dxAbs = Math.abs(dx);

    if (dotProduct < 0) {
      const lookaheadDistance = collisiondistance + absdv;
      if (dxAbs <= lookaheadDistance) {
        if (f1.fixed) {
          p2.vx = s8(-Math.trunc((p2.vx * this.collisionHardness) / 255));
          p2.x = p1.x + (dx < 0 ? -collisiondistance : collisiondistance);
          return;
        } else if (f2.fixed) {
          p1.vx = s8(-Math.trunc((p1.vx * this.collisionHardness) / 255));
          p1.x = p2.x + (dx < 0 ? collisiondistance : -collisiondistance);
          return;
        }
        const surfacehardness = Math.max(
          this.collisionHardness,
          PS_P_MINSURFACEHARDNESS_1D,
        );
        const impulse = Math.trunc((dv * surfacehardness) / 255);
        if (massratio1) {
          p1.vx = s8(limitSpeed(p1.vx + ((impulse * massratio1) >> 7)));
          p2.vx = s8(limitSpeed(p2.vx - ((impulse * massratio2) >> 7)));
        } else {
          p1.vx = s8(p1.vx + impulse);
          p2.vx = s8(p2.vx - impulse);
        }
        if (
          this.collisionHardness < PS_P_MINSURFACEHARDNESS_1D &&
          (this.seg.call & 0x07) === 0
        ) {
          const coeff =
            this.collisionHardness + (250 - PS_P_MINSURFACEHARDNESS_1D);
          p1.vx = s8(Math.trunc((p1.vx * coeff) / 255));
          p2.vx = s8(Math.trunc((p2.vx * coeff) / 255));
        }
      } else {
        return;
      }
    }

    if (dxAbs < collisiondistance) {
      let pushamount = 1 + ((collisiondistance - dxAbs) >> 3);
      let addspeed = 1;
      if (dx < 0) {
        pushamount = -pushamount;
        addspeed = -addspeed;
      }
      if (absdv < 4) {
        p1.vx = s8(p1.vx - addspeed);
        p2.vx = s8(p2.vx + addspeed);
      }
      if (dotProduct & 0x01) p1.x -= pushamount;
      else p2.x += pushamount;
    }
  }
}

// --- init (module-level, FXparticleSystem.cpp) ------------------------------
function calculateNumberOfParticles1D(
  length: number,
  fraction: number,
  isadvanced: boolean,
): number {
  let n = Math.min(length, MAXPARTICLES_1D);
  if (isadvanced) n = Math.trunc((n * 8) / (8 + 3)); // sizeof ratio 8:(8+adv≈3)
  n = (n * (fraction + 1)) >> 8;
  n = n < 10 ? 10 : n;
  return (n + 3) & ~0x03;
}

function calculateNumberOfSources1D(requestedsources: number): number {
  const n = Math.max(1, Math.min(requestedsources, MAXSOURCES_1D));
  return (n + 3) & ~0x03;
}

const PS_STORE = new WeakMap<Segment, ParticleSystem1D>();

/**
 * Init a 1D particle system for `seg` (fx first frame) and stash it per-Segment.
 * Returns null for single-pixel strips (unsupported, effect should fall back).
 * `fractionOfParticles` (0-255) scales the particle count; `advanced` allocates
 * per-particle saturation/size.
 *
 * Note: the C++ `initParticleSystem1D(PartSys, sources, fraction, additionalBytes,
 * advanced)` `additionalBytes` arg is dropped here -- it reserved SEGENV.data
 * space past the system for FX scratch; TS effects keep that in the Segment
 * (aux/step/data) or their own WeakMap instead.
 */
export function initParticleSystem1D(
  seg: Segment,
  requestedSources: number,
  fractionOfParticles = 255,
  advanced = false,
): ParticleSystem1D | null {
  if (seg.length <= 1) return null;
  const numparticles = calculateNumberOfParticles1D(
    seg.length,
    fractionOfParticles,
    advanced,
  );
  const numsources = calculateNumberOfSources1D(requestedSources);
  const ps = new ParticleSystem1D(
    seg,
    seg.length,
    numparticles,
    numsources,
    advanced,
  );
  PS_STORE.set(seg, ps);
  return ps;
}

/** Retrieve the particle system created for `seg` (subsequent fx frames). */
export function getParticleSystem1D(seg: Segment): ParticleSystem1D | null {
  return PS_STORE.get(seg) ?? null;
}
