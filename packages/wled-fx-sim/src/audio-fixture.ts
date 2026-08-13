// SPDX-License-Identifier: EUPL-1.2
// Original to this package (no upstream port) — see PROVENANCE.md.
/**
 * A synthetic, deterministic stand-in for WLED's audio-reactive `um_data`
 * (volumeSmth + the 16-band fftResult), used only so the 2D audio-reactive
 * effect previews in effects.ts have something to react to.
 *
 * This is NOT audio analysis and reads no microphone or signal -- it is a
 * canned, looping drum-and-bass pattern sampled purely as a function of
 * elapsed ms, so a preview frame is reproducible. Named "synthetic"
 * throughout (file, type, function, every call site) so it is never mistaken
 * for real audio input. WLED's own no-audio stand-in is simulateSound()
 * (wled00/util.cpp); this fixture is a from-scratch equivalent built for the
 * same purpose, not a port of it.
 */

export interface SyntheticAudioFrame {
  /** 0-255, stand-in for WLED's SEGMENT-facing volumeSmth. */
  volumeSmth: number;
  /** 16 bands, 0-255 each, stand-in for WLED's fftResult. */
  fftResult: Uint8Array;
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

function clamp8(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
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
  for (let i = 0; i < 4; i++) {
    const body = bassNote > 0 ? 60 + bassNote * 40 : 20;
    fftResult[i] = clamp8(Math.max(kickEnv, body) - i * 10);
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

  return { volumeSmth, fftResult };
}
