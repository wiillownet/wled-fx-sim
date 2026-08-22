// SPDX-License-Identifier: EUPL-1.2
// Test code original to this package.
import { describe, expect, it } from 'vitest';
import {
  SAMPLE_PEAK_WINDOW_MS,
  sampleSyntheticAudio,
} from './audio-fixture.js';
import { FRAMETIME, createEffectSim } from './index.js';

// The fixture's whole job is to be a *stable* stand-in: the audio-reactive
// effect bodies read it every frame, and the golden-frame snapshots bake its
// output in. Anything non-deterministic here would surface as flaky pixels
// several layers away, so the contract is pinned directly.

const BPM = 120;
const STEP_MS = 60000 / BPM / 2;
const LOOP_MS = STEP_MS * 16; // eighth notes x 16 steps = 4000ms

/** The steps the fixture puts a kick or a snare on -- what a beat fires from. */
const BEAT_MS = [0, 4, 6, 8, 12].map((step) => step * STEP_MS);

/** Every t a fixed-step sim actually samples over one phrase. */
function phraseFrameTimes(): number[] {
  const times: number[] = [];
  for (let t = 0; t < LOOP_MS; t += FRAMETIME) times.push(t);
  return times;
}

describe('sampleSyntheticAudio', () => {
  it('returns a full frame, every channel in range', () => {
    for (const t of [0, 1, 137, 999, 2500, 60_000]) {
      const frame = sampleSyntheticAudio(t);
      const {
        volumeSmth,
        volumeRaw,
        fftResult,
        samplePeak,
        fftMajorPeak,
        myMagnitude,
      } = frame;

      expect(fftResult).toHaveLength(16);
      for (const band of fftResult) {
        expect(Number.isFinite(band)).toBe(true);
        expect(band).toBeGreaterThanOrEqual(0);
        expect(band).toBeLessThanOrEqual(255);
      }

      for (const [name, v] of [
        ['volumeSmth', volumeSmth],
        ['volumeRaw', volumeRaw],
      ] as const) {
        expect(Number.isInteger(v), name).toBe(true);
        expect(v, name).toBeGreaterThanOrEqual(0);
        expect(v, name).toBeLessThanOrEqual(255);
      }

      expect(typeof samplePeak).toBe('boolean');

      // Bodies feed fftMajorPeak straight into log10() (Freqmap, Waterfall,
      // Gravfreq, Rocktaves), so a zero or negative would be poison.
      expect(Number.isFinite(fftMajorPeak)).toBe(true);
      expect(fftMajorPeak).toBeGreaterThan(0);
      expect(fftMajorPeak).toBeLessThanOrEqual(11025); // MAX_FREQUENCY

      expect(Number.isFinite(myMagnitude)).toBe(true);
      expect(myMagnitude).toBeGreaterThanOrEqual(0);
    }
  });

  it('is a pure function of time (no RNG, no accumulated state)', () => {
    for (const t of [0, 333, 1000, 1750, 3999]) {
      const a = sampleSyntheticAudio(t);
      const b = sampleSyntheticAudio(t);
      expect(a.volumeSmth).toBe(b.volumeSmth);
      expect(a.volumeRaw).toBe(b.volumeRaw);
      expect(a.samplePeak).toBe(b.samplePeak);
      expect(a.fftMajorPeak).toBe(b.fftMajorPeak);
      expect(a.myMagnitude).toBe(b.myMagnitude);
      expect([...a.fftResult]).toEqual([...b.fftResult]);
    }
  });

  it('does not leak its buffer between calls', () => {
    // A shared Uint8Array would make every caller see the newest frame.
    const first = sampleSyntheticAudio(0);
    const firstBands = [...first.fftResult];
    const second = sampleSyntheticAudio(2000);
    expect([...first.fftResult]).toEqual(firstBands);
    expect(second.fftResult).not.toBe(first.fftResult);
    // Mutating a returned buffer must not reach back into the fixture.
    first.fftResult[0] = 123;
    expect(sampleSyntheticAudio(0).fftResult[0]).toBe(firstBands[0]);
  });

  it('loops on a 4s phrase, so a preview never runs dry or drifts', () => {
    for (const t of [0, 250, 1000, 1234, 3999]) {
      const base = sampleSyntheticAudio(t);
      for (const cycles of [1, 2, 10]) {
        const later = sampleSyntheticAudio(t + LOOP_MS * cycles);
        expect(later.volumeSmth).toBe(base.volumeSmth);
        expect(later.volumeRaw).toBe(base.volumeRaw);
        expect(later.samplePeak).toBe(base.samplePeak);
        expect(later.fftMajorPeak).toBe(base.fftMajorPeak);
        expect(later.myMagnitude).toBe(base.myMagnitude);
        expect([...later.fftResult]).toEqual([...base.fftResult]);
      }
    }
  });

  it('handles negative time on every channel without NaN or out-of-range', () => {
    // seg.now is always >= 0 today, but the modulo is written to survive it.
    for (const t of [-1, -1500, -LOOP_MS, -LOOP_MS - 7, -123_456]) {
      const frame = sampleSyntheticAudio(t);
      expect(frame.volumeSmth).toBeGreaterThanOrEqual(0);
      expect(frame.volumeSmth).toBeLessThanOrEqual(255);
      expect(frame.volumeRaw).toBeGreaterThanOrEqual(0);
      expect(frame.volumeRaw).toBeLessThanOrEqual(255);
      expect(typeof frame.samplePeak).toBe('boolean');
      expect(frame.fftMajorPeak).toBeGreaterThan(0);
      expect(Number.isFinite(frame.myMagnitude)).toBe(true);
      for (const band of frame.fftResult) {
        expect(band).toBeGreaterThanOrEqual(0);
        expect(band).toBeLessThanOrEqual(255);
      }
      // A negative time is just an earlier point on the same loop.
      const wrapped = sampleSyntheticAudio(t + LOOP_MS * 100);
      expect(wrapped.volumeRaw).toBe(frame.volumeRaw);
      expect(wrapped.fftMajorPeak).toBe(frame.fftMajorPeak);
      expect(wrapped.samplePeak).toBe(frame.samplePeak);
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

describe('volumeRaw (um_data slot 1)', () => {
  it('is spikier than volumeSmth: no noise floor, no hi-hat attenuation', () => {
    let raws: number[] = [];
    let smths: number[] = [];
    for (const t of phraseFrameTimes()) {
      const { volumeRaw, volumeSmth } = sampleSyntheticAudio(t);
      raws.push(volumeRaw);
      smths.push(volumeSmth);
    }
    // volumeSmth carries a deliberate floor of 30; volumeRaw has none and falls
    // to silence between hits. It is not pinned to exactly 0: the hi-hat's decay
    // is a 50ms exponential that never mathematically reaches zero, so the tail
    // of a step rounds to 1 rather than 0. What the channel contrast needs is
    // that raw's floor is negligible and smth's is not, which is the assertion.
    expect(Math.min(...raws)).toBeLessThanOrEqual(1);
    expect(Math.min(...smths)).toBeGreaterThanOrEqual(30);
    // ...but both reach full scale on a transient
    expect(Math.max(...raws)).toBe(255);
    // and they are genuinely different signals, not one aliased onto the other
    raws = raws.slice();
    smths = smths.slice();
    expect(raws).not.toEqual(smths);
  });
});

describe('samplePeak (um_data slot 3)', () => {
  it('fires exactly once per beat on the fixed-step clock', () => {
    // Firmware's samplePeak is an edge the usermod clears after every frame.
    // The fixture reproduces that with a FRAMETIME-wide window, which only
    // behaves if the caller steps at FRAMETIME -- the property under test.
    const fired = phraseFrameTimes().filter(
      (t) => sampleSyntheticAudio(t).samplePeak,
    );
    expect(fired).toHaveLength(BEAT_MS.length);

    // each firing is the first frame at or after its beat, so no beat is
    // reported late by more than one step and none is reported twice
    for (let i = 0; i < BEAT_MS.length; i++) {
      const lag = fired[i] - BEAT_MS[i];
      expect(lag).toBeGreaterThanOrEqual(0);
      expect(lag).toBeLessThan(FRAMETIME);
    }
  });

  it('never double-fires on consecutive frames', () => {
    const times = phraseFrameTimes();
    for (let i = 1; i < times.length; i++) {
      const prev = sampleSyntheticAudio(times[i - 1]).samplePeak;
      const cur = sampleSyntheticAudio(times[i]).samplePeak;
      expect(prev && cur, `double fire at ${times[i]}ms`).toBe(false);
    }
  });

  it('stays exactly-once across the loop seam', () => {
    // 4000ms is not a whole number of 23ms steps, so the step phase shifts
    // every lap -- the window has to tile the timeline, not the phrase.
    let fired = 0;
    for (let t = 0; t < LOOP_MS * 5; t += FRAMETIME) {
      if (sampleSyntheticAudio(t).samplePeak) fired++;
    }
    expect(fired).toBe(BEAT_MS.length * 5);
  });

  it('keeps its window in step with FRAMETIME', () => {
    // If FRAMETIME ever changes, the window must move with it or beats start
    // double-firing (window too wide) or vanishing (too narrow).
    expect(SAMPLE_PEAK_WINDOW_MS).toBe(FRAMETIME);
  });
});

describe('fftMajorPeak / myMagnitude (um_data slots 4 and 5)', () => {
  it('tracks the bassline rather than wandering, but spans the log range', () => {
    const peaks = phraseFrameTimes().map(
      (t) => sampleSyntheticAudio(t).fftMajorPeak,
    );
    const distinct = new Set(peaks);
    // Effects map log10(peak) onto position/colour, so a single-valued peak
    // would render as one frozen pixel (Freqmap) or one hue (Waterfall).
    expect(distinct.size).toBeGreaterThan(3);
    expect(Math.min(...peaks)).toBeLessThan(100); // reaches the bass register
    expect(Math.max(...peaks)).toBeGreaterThan(2000); // and the treble one

    // The bass voice is the loudest most of the time, so most frames report a
    // bassline pitch rather than a transient's register.
    const bassFrames = peaks.filter((hz) => hz < 200).length;
    expect(bassFrames).toBeGreaterThan(peaks.length / 2);
  });

  it('dips below the 80Hz cutoff the effect bodies branch on', () => {
    // FX.cpp:7318/7410 blacks out below 80Hz; if the fixture never went there
    // that branch would be dead code in the ports.
    const peaks = phraseFrameTimes().map(
      (t) => sampleSyntheticAudio(t).fftMajorPeak,
    );
    expect(peaks.some((hz) => hz < 80)).toBe(true);
  });

  it('stays in the band its consumers divide down into a uint8 brightness', () => {
    // Freqmap divides by 4, Waterfall by 8, Freqpixels/Rocktaves by 16 before
    // casting to uint8_t. Keep the raw value where all four stay meaningful.
    const mags = phraseFrameTimes().map(
      (t) => sampleSyntheticAudio(t).myMagnitude,
    );
    expect(Math.min(...mags)).toBeGreaterThan(0);
    expect(Math.max(...mags)).toBeLessThanOrEqual(2040); // Waterfall's /8 ceiling
    // Rocktaves squelches below 48 after its /16, so the loud frames have to
    // clear that or the effect never lights at all.
    expect(mags.some((m) => m / 16 > 48)).toBe(true);
  });

  it('peaks together with the transients, not independently', () => {
    // magnitude is the winning voice's energy, so a beat frame must be louder
    // than the quietest rest frame.
    const onBeat = sampleSyntheticAudio(0).myMagnitude;
    const offBeat = sampleSyntheticAudio(250 + 200).myMagnitude;
    expect(onBeat).toBeGreaterThan(offBeat);
  });
});

describe('audio-reactive effects driven by the fixture', () => {
  // The 2D bodies that read the fixture instead of WLED's um_data.
  const AUDIO_2D = [139, 160, 165, 175, 186, 197, 198, 199, 201];
  // ...and the 1D ones. Being audio-reactive is not recorded in the registry
  // (nothing downstream needs it), so this list is explicit by necessity.
  const AUDIO_1D = [
    128, 129, 130, 131, 132, 133, 134, 135, 136, 137, 138, 140, 141, 143, 144,
    145, 148, 155, 156, 157, 158, 159, 163, 185, 212, 214, 215, 216,
  ];

  it('2D: animate over a phrase rather than sitting on one frame', () => {
    for (const id of AUDIO_2D) {
      const sim = createEffectSim(id, { width: 16, height: 16, length: 16 });
      const frames = new Set<string>();
      for (let t = 0; t < LOOP_MS; t += 200) {
        frames.add(JSON.stringify(sim.frame(t)));
      }
      expect(frames.size, `fx ${id} never changed`).toBeGreaterThan(1);
    }
  });

  it('1D: animate over a phrase, sampled at the real frame cadence', () => {
    // A frozen audio effect is the failure mode that matters here, and coarse
    // sampling can miss motion, so this walks the actual FRAMETIME steps.
    for (const id of AUDIO_1D) {
      const sim = createEffectSim(id, {
        length: 32,
        sx: 180,
        ix: 200,
        pal: 11,
        seed: 0x1234,
      });
      const frames = new Set<string>();
      let changes = 0;
      let prev = '';
      for (const t of phraseFrameTimes()) {
        const key = JSON.stringify(sim.frame(t));
        frames.add(key);
        if (prev !== '' && key !== prev) changes++;
        prev = key;
      }
      expect(frames.size, `fx ${id} never changed`).toBeGreaterThan(1);
      // Not just a single transition somewhere -- it has to keep moving.
      expect(changes, `fx ${id} barely moves`).toBeGreaterThan(10);
    }
  });

  it('1D: still animating late in a long run, not settling into a still', () => {
    for (const id of AUDIO_1D) {
      const sim = createEffectSim(id, {
        length: 32,
        sx: 180,
        ix: 200,
        pal: 11,
        seed: 0x1234,
      });
      const late = new Set<string>();
      for (let step = 0; step <= 400; step++) {
        const key = JSON.stringify(sim.frame(step * FRAMETIME));
        if (step >= 300) late.add(key);
      }
      expect(late.size, `fx ${id} froze after warm-up`).toBeGreaterThan(1);
    }
  });

  it('1D: light at least some pixels over a phrase', () => {
    // Determinism plus "it changed" would both still pass on an all-black
    // effect, which is how a mis-scaled brightness channel would hide.
    for (const id of AUDIO_1D) {
      const sim = createEffectSim(id, {
        length: 32,
        sx: 180,
        ix: 200,
        pal: 11,
        seed: 0x1234,
      });
      let maxLum = 0;
      for (const t of phraseFrameTimes()) {
        for (const px of sim.frame(t)) {
          maxLum = Math.max(maxLum, px[0] + px[1] + px[2]);
        }
      }
      expect(maxLum, `fx ${id} rendered nothing but black`).toBeGreaterThan(0);
    }
  });

  it('stay deterministic despite reading the fixture', () => {
    for (const id of [...AUDIO_2D, ...AUDIO_1D]) {
      const params = { width: 8, height: 8, length: 16, seed: 0x1234 };
      const a = createEffectSim(id, params);
      const b = createEffectSim(id, params);
      expect(a.frame(1500), `fx ${id} diverged`).toEqual(b.frame(1500));
    }
  });
});
