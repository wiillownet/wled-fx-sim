---
'@wiillownet/wled-fx-sim': minor
---

Port 16 more 2D effect bodies into `EFFECT_SIMS_2D` (43 -> 59), and let the
caller choose the branch for effects that have both.

**Dual effects.** The 7 WLED `mode_*` bodies that branch on `SEGMENT.is2D()`
(Fireworks 42, Rain 43, Palette 65, Ripple 79, Halloween Eyes 82, Fireworks 1D
90, Ripple Rainbow 99) now have their matrix branch ported alongside the
existing 1D one. Firmware routes by the segment's own dimensionality, so these
ids are no longer answerable from the registry alone:

- New `EffectSimParams.dimensions?: '1d' | '2d'`. Default is `'2d'` when both
  `width` and `height` are supplied, else `'1d'`. An effect with only one body
  ignores it.
- New `supports1D(fxId)` / `supports2D(fxId)` capability queries.
- `is2DEffect(fxId)` now means matrix-*only* (a 2D body and no 1D one), so a
  dual id answers `false`. This keeps the answer identical for every id that
  existed before -- no id shipped in 0.1.0 had both bodies -- and keeps it
  useful for its actual job, picking a renderer. Read `width`/`height` off the
  built `EffectSim` if you want what was really constructed.
- `portedFxIds()` dedupes, since a dual id is a key in both registries.

**Audio-reactive effects.** 9 audio-reactive 2D effects (GEQ 139, Funky Plank
160, Waverly 165, Swirl 175, Akemi 186, PS Spray 197, PS GEQ 2D 198, PS GEQ Nova
199, PS Blobs 201) are wired to a new internal synthetic band-energy fixture
standing in for WLED's `um_data`: a deterministic, looping 4-second 120 BPM
phrase. There is still no audio analysis in this package, and no way to feed it
real audio -- those previews react to a canned pattern, which the README now
states plainly. The fixture is not exported; that stays open.
