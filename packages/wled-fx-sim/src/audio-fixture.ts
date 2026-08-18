// SPDX-License-Identifier: EUPL-1.2
// Original to this package (no upstream port) — see PROVENANCE.md.
/**
 * A synthetic, deterministic stand-in for WLED's audio-reactive `um_data`,
 * used only so the audio-reactive effect previews in effects.ts have something
 * to react to.
 *
 * This is NOT audio analysis and reads no microphone or signal -- it is a
 * canned, looping drum-and-bass pattern sampled purely as a function of
 * elapsed ms, so a preview frame is reproducible. Named "synthetic"
 * throughout (file, type, function, every call site) so it is never mistaken
 * for real audio input. WLED's own no-audio stand-in is simulateSound()
 * (wled00/util.cpp); this fixture is a from-scratch equivalent built for the
 * same purpose, not a port of it -- the channel *shapes* below are derived
 * from what the `mode_*` bodies in FX.cpp read, not from simulateSound's
 * construction.
 *
 * Channel coverage maps onto the `um_data->u_data[]` slots documented at
 * FX.cpp:58-66:
 *
 *   slot 0  volumeSmth     -> volumeSmth
 *   slot 1  volumeRaw      -> volumeRaw
 *   slot 2  fftResult      -> fftResult
 *   slot 3  samplePeak     -> samplePeak
 *   slot 4  FFT_MajorPeak  -> fftMajorPeak
 *   slot 5  my_magnitude   -> myMagnitude
 *   slot 6  maxVol         -- NOT a channel, see below
 *   slot 7  binNum         -- NOT a channel, see below
 *   slot 8  fftBin         -- unused by every ported effect
 *
 * Slots 6/7 look like fixture data but are not: firmware treats them as
 * usermod-owned scratch bytes that the *effect* writes from its own sliders
 * (`*binNum = SEGMENT.custom1`, `*maxVol = SEGMENT.custom2 / 2`, FX.cpp:6676,
 * 7141, 7511). With no usermod present that round-trip has no other end, so
 * the ports treat those lines as no-ops and read the sliders directly.
 */

/** One sampled frame of the synthetic fixture (see the slot map above). */
export interface SyntheticAudioFrame {
  /** 0-255, stand-in for WLED's SEGMENT-facing volumeSmth (slot 0). */
  volumeSmth: number;
  /**
   * 0-255, the un-smoothed envelope (slot 1). Spikier than `volumeSmth`: no
   * hi-hat attenuation and no noise floor, so it drops to 0 between hits.
   */
  volumeRaw: number;
  /** 16 bands, 0-255 each, stand-in for WLED's fftResult (slot 2). */
  fftResult: Uint8Array;
  /** Beat edge (slot 3) -- true on exactly one frame per kick/snare. */
  samplePeak: boolean;
  /** Dominant frequency in Hz (slot 4, firmware `FFT_MajorPeak`). */
  fftMajorPeak: number;
  /** Magnitude of that peak (slot 5, firmware `my_magnitude`). */
  myMagnitude: number;
}

const BPM = 120;
const STEP_MS = 60000 / BPM / 2; // eighth notes, 250ms @ 120bpm
const PATTERN_STEPS = 16; // one 2-bar phrase
const LOOP_MS = STEP_MS * PATTERN_STEPS;

// Kick (bass bands): a syncopated four-on-the-floor pattern.
const KICK_STEPS = new Set([0, 4, 6, 8, 12]);
// Snare/clap (mid bands): the classic backbeat.
const SNARE_STEPS = new Set([4, 12]);
// A short bassline riff (0 = rest); walks the mid bands' contour each step.
const BASS_NOTES = [2, 0, 2, 0, 3, 0, 1, 0, 2, 0, 2, 0, 3, 2, 1, 0];

// --- samplePeak timing -------------------------------------------------------
// Firmware's samplePeak is a per-frame boolean edge: the usermod sets it when
// it detects a beat and clears it after the effects have run, so an effect sees
// each beat on exactly one frame. Sampling it as a pure function of time cannot
// reproduce "the usermod cleared it" directly, so instead it is defined as
// "a hit falls in the FRAMETIME-wide half-open window (nowMs-FRAMETIME, nowMs]".
//
// Consecutive fixed-step frames tile the timeline with disjoint windows, so on
// the sim's FRAMETIME clock (index.ts) every hit fires exactly once -- no
// double-fire, no miss. That property is a property of the *caller's* cadence,
// not of this function: a caller that samples at arbitrary or overlapping times
// can legitimately see a hit twice or not at all. The only caller is the fixed
// step loop, so that is the cadence the window is sized for.
//
// PEAK_WINDOW_MS must equal effects.ts FRAMETIME. It is duplicated rather than
// imported because effects.ts imports this file (importing back would be a
// cycle); it is exported (package-internal -- index.ts does not re-export this
// module) purely so audio-fixture.test.ts can assert the two stay equal.
export const SAMPLE_PEAK_WINDOW_MS = 23;
const PEAK_WINDOW_MS = SAMPLE_PEAK_WINDOW_MS;

/** Every step carrying a transient -- what a beat detector would fire on. */
const PEAK_TIMES = [...new Set([...KICK_STEPS, ...SNARE_STEPS])]
  .sort((a, b) => a - b)
  .map((step) => step * STEP_MS);

// --- fftMajorPeak / myMagnitude ----------------------------------------------
// A real FFT major peak is the frequency of the loudest bin, so the fixture
// picks the loudest of the four voices it already models rather than inventing
// an independent oscillator. The bass note is the voice that is loudest most of
// the time, so the reported peak tracks the bassline contour, with transients
// briefly pulling it into their own register the way a real analysis would.
//
// Pitches of the bassline notes (BASS_NOTES 1/2/3). C2 sits below firmware's
// 80 Hz "treat as silence" cutoff (FX.cpp:7318, 7410) on purpose, so the ports'
// blackout branch is actually reachable.
const NOTE_HZ = [0, 65.41, 98.0, 130.81]; // rest, C2, G2, C3
const KICK_HZ = 55;
const SNARE_HZ = 1800;
const HAT_HZ = 7500;

// Perceptual weights on the voices' envelopes. Without them the kick's raw
// envelope masks the snare at every onset and the peak never leaves the bass
// register, which would leave every log-frequency effect showing three colours.
const SNARE_WEIGHT = 1.6;
const HAT_WEIGHT = 1.4;

// myMagnitude scale. Consumers divide it by 4 (Freqmap), 8 (Waterfall) or 16
// (Freqpixels, Rocktaves) before casting to uint8, so the scale is chosen to
// land all four in a usable brightness band at once. A kick sampled at phase 0
// gives energy 255 -> 1020, which Freqmap's /4 maps to exactly 255.
//
// The ceiling above that is a snare at phase 0 (200 * SNARE_WEIGHT = 320 ->
// 1280), and it IS reachable: gcd(23, 4000) = 1, so the FRAMETIME lattice
// eventually lands on every millisecond of the loop. It first happens at
// seg.now = 23000 (frame 1000), where Freqmap's /4 gives 320 and the uint8 cast
// wraps to 64. More generally the cast wraps whenever a frame falls within
// ~5.7ms of a snare onset -- about a quarter of snare onsets, ~12 frames per
// 4000-frame lattice period, i.e. roughly once every 8s of preview.
//
// The wrap itself is faithful: fToU8 reproduces firmware's truncate-then-mask
// cast exactly. Whether MAGNITUDE_SCALE or SNARE_WEIGHT should be retuned so
// the four consumer casts stay in range is a fixture-design question, not a
// port-fidelity one.
const MAGNITUDE_SCALE = 4;

function clamp8(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

/** Pitch driving the peak at `step`; a rest holds the last sounding note. */
function soundingNote(step: number): number {
  for (let i = 0; i < PATTERN_STEPS; i++) {
    const note = BASS_NOTES[(step - i + PATTERN_STEPS) % PATTERN_STEPS];
    if (note > 0) return note;
  }
  return 1; // unreachable: BASS_NOTES[0] is a sounding note
}

/** Sample the synthetic fixture at `nowMs` (typically a Segment's `now`). */
export function sampleSyntheticAudio(nowMs: number): SyntheticAudioFrame {
  const t = ((nowMs % LOOP_MS) + LOOP_MS) % LOOP_MS;
  const step = Math.floor(t / STEP_MS) % PATTERN_STEPS;
  const stepPhase = (t % STEP_MS) / STEP_MS;

  const fftResult = new Uint8Array(16);

  // Bands 0-3: sub/bass -- a decaying kick envelope riding on the bassline's
  // note height, so there's always some body even between kicks.
  const kickEnv = KICK_STEPS.has(step) ? 255 * Math.exp(-stepPhase * 6) : 0;
  const bassNote = BASS_NOTES[step];
  const bassBody = bassNote > 0 ? 60 + bassNote * 40 : 20;
  for (let i = 0; i < 4; i++) {
    fftResult[i] = clamp8(Math.max(kickEnv, bassBody) - i * 10);
  }

  // Bands 4-9: mids -- snare/clap hits plus the bassline's melodic contour.
  const snareEnv = SNARE_STEPS.has(step)
    ? 200 * Math.exp(-stepPhase * 10)
    : 0;
  for (let i = 4; i < 10; i++) {
    const contour =
      40 + bassNote * 25 + 20 * Math.sin((i - 4) * 0.8 + t * 0.002);
    fftResult[i] = clamp8(Math.max(snareEnv, contour));
  }

  // Bands 10-15: highs -- a hi-hat on every eighth note, accented on the beat.
  const hatAccent = step % 2 === 0 ? 140 : 90;
  const hatEnv = hatAccent * Math.exp(-stepPhase * 14);
  for (let i = 10; i < 16; i++) {
    fftResult[i] = clamp8(hatEnv - (i - 10) * 8 + 10);
  }

  const volumeSmth = clamp8(Math.max(kickEnv, snareEnv, hatEnv * 0.6, 30));
  const volumeRaw = clamp8(Math.max(kickEnv, snareEnv, hatEnv));

  // A hit lands in this frame's window (see PEAK_WINDOW_MS above).
  const samplePeak = PEAK_TIMES.some((p) => {
    const since = ((t - p) % LOOP_MS + LOOP_MS) % LOOP_MS;
    return since < PEAK_WINDOW_MS;
  });

  // Loudest voice wins the peak; ties go to the lower register (kick first).
  let fftMajorPeak = NOTE_HZ[soundingNote(step)];
  let peakEnergy = bassBody;
  if (kickEnv > peakEnergy) {
    fftMajorPeak = KICK_HZ;
    peakEnergy = kickEnv;
  }
  if (snareEnv * SNARE_WEIGHT > peakEnergy) {
    fftMajorPeak = SNARE_HZ;
    peakEnergy = snareEnv * SNARE_WEIGHT;
  }
  if (hatEnv * HAT_WEIGHT > peakEnergy) {
    fftMajorPeak = HAT_HZ;
    peakEnergy = hatEnv * HAT_WEIGHT;
  }

  return {
    volumeSmth,
    volumeRaw,
    fftResult,
    samplePeak,
    fftMajorPeak,
    myMagnitude: peakEnergy * MAGNITUDE_SCALE,
  };
}
