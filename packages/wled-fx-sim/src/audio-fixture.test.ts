// SPDX-License-Identifier: EUPL-1.2
// Test code original to this package.
import { describe, expect, it } from 'vitest';
import { sampleSyntheticAudio } from './audio-fixture.js';
import { createEffectSim } from './index.js';

// The fixture's whole job is to be a *stable* stand-in: the audio-reactive
// effect bodies read it every frame, and the golden-frame snapshots bake its
// output in. Anything non-deterministic here would surface as flaky pixels
// several layers away, so the contract is pinned directly.

const BPM = 120;
const LOOP_MS = (60000 / BPM / 2) * 16; // eighth notes x 16 steps = 4000ms

describe('sampleSyntheticAudio', () => {
  it('returns a full 16-band frame in range', () => {
    for (const t of [0, 1, 137, 999, 2500, 60_000]) {
      const { volumeSmth, fftResult } = sampleSyntheticAudio(t);
      expect(fftResult).toHaveLength(16);
      expect(volumeSmth).toBeGreaterThanOrEqual(0);
      expect(volumeSmth).toBeLessThanOrEqual(255);
      for (const band of fftResult) {
        expect(Number.isFinite(band)).toBe(true);
        expect(band).toBeGreaterThanOrEqual(0);
        expect(band).toBeLessThanOrEqual(255);
      }
    }
  });

  it('is a pure function of time (no RNG, no accumulated state)', () => {
    for (const t of [0, 333, 1750, 3999]) {
      const a = sampleSyntheticAudio(t);
      const b = sampleSyntheticAudio(t);
      expect(a.volumeSmth).toBe(b.volumeSmth);
      expect([...a.fftResult]).toEqual([...b.fftResult]);
    }
  });

  it('does not leak its buffer between calls', () => {
    // A shared Uint8Array would make every caller see the newest frame.
    const first = sampleSyntheticAudio(0);
    const firstBands = [...first.fftResult];
    sampleSyntheticAudio(2000);
    expect([...first.fftResult]).toEqual(firstBands);
  });

  it('loops on a 4s phrase, so a preview never runs dry or drifts', () => {
    for (const t of [0, 250, 1234, 3999]) {
      const base = sampleSyntheticAudio(t);
      for (const cycles of [1, 2, 10]) {
        const later = sampleSyntheticAudio(t + LOOP_MS * cycles);
        expect(later.volumeSmth).toBe(base.volumeSmth);
        expect([...later.fftResult]).toEqual([...base.fftResult]);
      }
    }
  });

  it('handles negative time without producing NaN or out-of-range bands', () => {
    // seg.now is always >= 0 today, but the modulo is written to survive it.
    const { volumeSmth, fftResult } = sampleSyntheticAudio(-1500);
    expect(Number.isFinite(volumeSmth)).toBe(true);
    expect(volumeSmth).toBeGreaterThanOrEqual(0);
    for (const band of fftResult) {
      expect(band).toBeGreaterThanOrEqual(0);
      expect(band).toBeLessThanOrEqual(255);
    }
  });

  it('actually moves: bands vary across the phrase, bass leads treble', () => {
    const seen = new Set<string>();
    let bassTotal = 0;
    let trebleTotal = 0;
    for (let t = 0; t < LOOP_MS; t += 50) {
      const { fftResult } = sampleSyntheticAudio(t);
      seen.add(fftResult.join(','));
      bassTotal += fftResult[0];
      trebleTotal += fftResult[15];
    }
    // A constant fixture would give the effects nothing to react to.
    expect(seen.size).toBeGreaterThan(10);
    // Bands are shaped like a drum mix, not noise: the kick/bass band carries
    // more energy over a phrase than the top hi-hat band.
    expect(bassTotal).toBeGreaterThan(trebleTotal);
  });
});

describe('audio-reactive effects driven by the fixture', () => {
  // The nine 2D bodies that read the fixture instead of WLED's um_data.
  const AUDIO_2D = [139, 160, 165, 175, 186, 197, 198, 199, 201];

  it('animate over a phrase rather than sitting on one frame', () => {
    for (const id of AUDIO_2D) {
      const sim = createEffectSim(id, { width: 16, height: 16, length: 16 });
      const frames = new Set<string>();
      for (let t = 0; t < LOOP_MS; t += 200) {
        frames.add(JSON.stringify(sim.frame(t)));
      }
      expect(frames.size, `fx ${id} never changed`).toBeGreaterThan(1);
    }
  });

  it('stay deterministic despite reading the fixture', () => {
    for (const id of AUDIO_2D) {
      const params = { width: 8, height: 8, length: 16, seed: 0x1234 };
      const a = createEffectSim(id, params);
      const b = createEffectSim(id, params);
      expect(a.frame(1500), `fx ${id} diverged`).toEqual(b.frame(1500));
    }
  });
});
