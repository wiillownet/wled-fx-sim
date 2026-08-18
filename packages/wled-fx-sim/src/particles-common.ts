// SPDX-License-Identifier: EUPL-1.2
// Ported from WLED v16.0.0 (commit 4374f01) wled00/FXparticleSystem.cpp/.h.
// Copyright (c) 2016-present Christian Schwinne and individual WLED contributors
/**
 * Physics/bounds helpers shared by the 1D and 2D particle engines.
 *
 * Upstream these are single file-scope definitions in FXparticleSystem.cpp/.h
 * (`limitSpeed` at FXparticleSystem.h:34, `calcForce_dv` at .cpp:1881,
 * `checkBoundsAndWrap` at .cpp:1902) called from both the 1D and 2D code paths,
 * so they live in one place here too rather than once per engine.
 *
 * Internal to the package -- not re-exported from index.ts.
 */

import { B, G, R } from './lib8.js';

/** PS_P_MAXSPEED -- max |v| (kept < 127 to avoid int8 overflow in collisions). */
export const PS_P_MAXSPEED = 120;

export function limitSpeed(speed: number): number {
  return speed > PS_P_MAXSPEED
    ? PS_P_MAXSPEED
    : speed < -PS_P_MAXSPEED
      ? -PS_P_MAXSPEED
      : speed;
}

// force is 3.4 fixed point; small forces use the counter so they apply over time
export function calcForce_dv(force: number, counter: { v: number }): number {
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
export function checkBoundsAndWrap(
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

// desaturate a packed color toward its luma (stand-in for the CHSV roundtrip)
export function applySaturation(color: number, sat: number): number {
  if (sat >= 255) return color;
  const r = R(color);
  const g = G(color);
  const b = B(color);
  const luma = (r * 77 + g * 150 + b * 29) >> 8;
  const mix = (c: number): number => (c * sat + luma * (255 - sat)) >> 8;
  return ((mix(r) << 16) | (mix(g) << 8) | mix(b)) >>> 0;
}
