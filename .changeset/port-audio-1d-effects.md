---
'@wiillownet/wled-fx-sim': minor
---

Port the 28 remaining audio-reactive 1D effect bodies into `EFFECT_SIMS`, and
widen the synthetic audio fixture to the channels they need.

**Effects.** Pixels 128, Pixelwave 129, Juggles 130, Matripix 131, Gravimeter
132, Plasmoid 133, Puddles 134, Midnoise 135, Noisemeter 136, Freqwave 137,
Freqmatrix 138, Waterfall 140, Freqpixels 141, Noisefire 143, Puddlepeak 144,
Noisemove 145, Ripple Peak 148, Freqmap 155, Gravcenter 156, Gravcentric 157,
Gravfreq 158, DJ Light 159, Blurz 163, Rocktaves 185, PS GEQ 1D 212, PS Sonic
Stream 214, PS Sonic Boom 215, PS Springy 216. Where firmware shares one body
between several ids it is shared here too: `mode_gravcenter_base` backs
132/156/157/158 and `mode_puddles_base` backs 134/144, each registered as
wrappers exactly as upstream does.

There is still no audio analysis in this package, and no way to feed it real
audio. These previews react to the same canned, deterministic 4-second 120 BPM
phrase the audio-reactive 2D effects already use.

**Fixture.** `sampleSyntheticAudio()` previously returned only `volumeSmth` and
a 16-band `fftResult`. It now also returns `volumeRaw`, `samplePeak`,
`fftMajorPeak` and `myMagnitude` (`um_data` slots 1, 3, 4 and 5), still as a
pure function of elapsed ms and still looping on the same phrase. `samplePeak`
is defined as a beat landing in the current frame's `FRAMETIME`-wide window, so
on the sim's fixed-step clock each beat fires on exactly one frame.

**Behaviour change.** The two already-ported 2D bodies that wanted `volumeRaw`
(Swirl 175, PS Spray 197) were reading `volumeSmth` in its place, because no
raw channel existed. They now read the real channel, so their output moves.
Those are the only two ids whose rendering changes.

The fixture is still not exported; that stays open.
