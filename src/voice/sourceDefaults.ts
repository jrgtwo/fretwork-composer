/**
 * What a voice source is made of when the user has just chosen it.
 *
 * ── Why replacing the branch is the only correct switch ──────────────────────
 *
 * `VoiceSource` is a discriminated union whose arms carry different payloads: a
 * sampler holds `samples` / `release`, both synths hold `params`. Writing
 * `source.kind` on its own — which is what a generic `setAtPath` row would do —
 * leaves a sampler's `samples` array sitting beside an `fm-synth` discriminant,
 * an object matching NO arm of the union. `Voice` would then read
 * `source.params` off it and build a synth from `undefined`. So the whole
 * `source` branch is replaced, and that means a well-formed starting value per
 * kind, which is this file.
 *
 * The engine needs nothing new for this: `Voice.swapPreset` compares
 * `sameSource(prev, next)`, and a differing `kind` takes the dispose-and-rebuild
 * path rather than the retune-in-place one. `playbackService.applyVoicePreset`
 * and `trackVoiceDrafts` are already the two routes into it.
 *
 * ── ⚠ WHERE THE NUMBERS COME FROM, and where they deliberately do not ────────
 *
 * They are **Tone's own documented defaults**, so that a voice the user has just
 * switched to plays before they have touched a single control. They are NOT
 * taken from any of the fourteen shipped presets (those are preselected
 * settings, and a default derived from one is a default that means "sound like
 * the acoustic bass"), and NOT from guitar-tutor's Sound Lab.
 *
 * Tone's docs site is the citation for each. Note WHICH page: the 15.1.22
 * typedoc pages — the version the lib depends on — document ranges (`Min:` /
 * `Max:` on a property) but document **no default values at all**; that was
 * checked on `classes/PluckSynth.html`, `classes/FMSynth.html`,
 * `interfaces/PluckSynthOptions.html` and `interfaces/FMSynthOptions.html`. The
 * same site's 13.8.25 pages carry an explicit `DEFAULTS` block per class, and
 * that is what is cited below. Exactly one field is documented on neither page —
 * PluckSynth's `release`, which post-dates 13.8.25 and carries no default on
 * 15.1.22 — and it is marked at its declaration as stated rather than cited.
 */
import {
  SAMPLE_PACKS,
  getSamplePack,
  sourceTrimDb,
  type FMSynthParams,
  type PluckSynthParams,
  type VoiceSource,
  type BodyFilterEnvelope,
  type BodyFilterParams,
  type VoiceLayer,
  type VoicePreset,
} from '@fretwork/lib';

/** The union's discriminant, named once so the schema and the seams agree. */
export type VoiceSourceKind = VoiceSource['kind'];

/**
 * Every kind, in the order the picker offers them. A `Record` keyed by the union
 * rather than a hand-written array: `tsc` fails here the day the lib adds a
 * fourth source kind, which is the only warning this app would otherwise get.
 */
export const SOURCE_KIND_LABELS: Record<VoiceSourceKind, string> = {
  sampler: 'Samples',
  'pluck-synth': 'Plucked string',
  'fm-synth': 'FM synth',
};

export const SOURCE_KINDS = Object.keys(SOURCE_KIND_LABELS) as readonly VoiceSourceKind[];

/**
 * `hasOwnProperty`, not `in`: `'toString' in SOURCE_KIND_LABELS` is TRUE through
 * the prototype chain, and this guard is what stands between an agent's
 * `setTrackVoiceParam(id, 'source.kind', 'toString')` and `defaultSourceFor`
 * falling off the end of its switch. Caught by its own test.
 */
export function isSourceKind(value: unknown): value is VoiceSourceKind {
  return typeof value === 'string' && Object.hasOwn(SOURCE_KIND_LABELS, value);
}

/**
 * The pack a freshly-switched sampler starts on.
 *
 * NOT `SAMPLE_PACKS[0]`, which is `empty` — a pack whose one bank is `{}`, whose
 * own label says it "falls back to PluckSynth". Landing there would satisfy the
 * type and silently not be a sampler at all, which is the one outcome "switching
 * lands on a source that plays" rules out. Philharmonia is chosen because it is
 * fully chromatic across the guitar range, so nothing is pitch-shifted; the pack
 * picker sits directly under the kind picker, so this is a starting point rather
 * than a claim about what the user wants.
 */
export const DEFAULT_SAMPLE_PACK_ID = 'philharmonia-classical';

/** Banks with at least one note in them — the property `empty` fails. */
function playable(banks: ReadonlyArray<Readonly<Record<string, string>>>): boolean {
  return banks.some((bank) => Object.keys(bank).length > 0);
}

/**
 * Guarded rather than indexed: if the registry ever renames or drops
 * {@link DEFAULT_SAMPLE_PACK_ID}, the fall-back is the first pack that actually
 * has samples — never `empty`, and never a crash.
 */
export function defaultSampleBanks(): ReadonlyArray<Readonly<Record<string, string>>> {
  const named = getSamplePack(DEFAULT_SAMPLE_PACK_ID);
  if (named && playable(named.samples)) return named.samples;
  const fallback = SAMPLE_PACKS.find((pack) => playable(pack.samples));
  return fallback ? fallback.samples : SAMPLE_PACKS[0].samples;
}

/**
 * Tone `PluckSynth` DEFAULTS — https://tonejs.github.io/docs/13.8.25/PluckSynth
 * (`{ attackNoise: 1, dampening: 4000, resonance: 0.7 }`).
 *
 * `release` is the one number here with no citation behind it: the field
 * post-dates 13.8.25, so there is no `DEFAULTS` entry for it, and the 15.1.22
 * page documents it with neither a default nor a `Min:`/`Max:` (only "the release
 * time which corresponds to a resonance ramp down to 0"). One second is stated
 * here rather than cited — a plain seconds-of-tail choice that lets the string
 * ring — and the control beside it is an encoder for exactly the reason the bound
 * is unknown. It is not a *departure* from Tone either, as far as anyone can tell
 * from the documentation; it simply is not documented.
 */
export const TONE_PLUCK_DEFAULTS: PluckSynthParams = {
  attackNoise: 1,
  dampening: 4000,
  resonance: 0.7,
  release: 1,
};

/**
 * Tone `FMSynth` DEFAULTS — https://tonejs.github.io/docs/13.8.25/FMSynth
 * (`harmonicity: 3, modulationIndex: 10, detune: 0, oscillator.type: sine,
 * envelope: {0.01, 0.01, 1, 0.5}, modulation.type: square,
 * modulationEnvelope: {0.5, 0, 1, 0.5}`).
 *
 * ⚠ ONE DEVIATION, and it is a conflict between two documented statements rather
 * than a preference. Tone's FMSynth default `modulationEnvelope.decay` is `0`,
 * while `classes/Envelope.html` documents the decay parameter as "Value must be
 * greater than 0". A source that cannot be built is not a source that plays, so
 * the smaller documented constraint wins and the seed is the slider's own
 * smallest non-zero step. The declared RANGE still starts at 0, because that is
 * the `Min:` the same page publishes — see the note in `paramSchema.ts`.
 */
const MOD_ENVELOPE_DECAY_S = 0.01;

export const TONE_FM_DEFAULTS: FMSynthParams = {
  harmonicity: 3,
  modulationIndex: 10,
  detune: 0,
  carrierWaveform: 'sine',
  modulatorWaveform: 'square',
  envelope: { attack: 0.01, decay: 0.01, sustain: 1, release: 0.5 },
  modulationEnvelope: { attack: 0.5, decay: MOD_ENVELOPE_DECAY_S, sustain: 1, release: 0.5 },
};

/**
 * A well-formed `VoiceSource` of the given kind.
 *
 * The sampler arm deliberately OMITS `release`. It is optional in the lib's type
 * and `Voice` builds `release: source.release ?? 1`, so leaving it out means the
 * lib's own default applies — the same rule the editor follows everywhere else
 * for optional fields, where writing our guess would turn "unspecified" into a
 * value the user never chose. Tone's documented Sampler default is 0.1 s
 * (https://tonejs.github.io/docs/13.8.25/Sampler), which this library overrides;
 * writing either number here would state a choice nobody made.
 */
export function defaultSourceFor(kind: VoiceSourceKind): VoiceSource {
  switch (kind) {
    case 'sampler':
      return { kind: 'sampler', samples: defaultSampleBanks() };
    case 'pluck-synth':
      return { kind: 'pluck-synth', params: TONE_PLUCK_DEFAULTS };
    case 'fm-synth':
      return { kind: 'fm-synth', params: TONE_FM_DEFAULTS };
  }
}

/**
 * `preset` with its source replaced by a well-formed one of `kind`.
 *
 * Returns the SAME reference when the kind already matches — two reasons, and
 * both are load-bearing. The editor's dirty check is reference-based
 * (`presetPaths` guarantees an unchanged write returns the same object), so a
 * picker reporting its current value must not mark the preset dirty. And a
 * re-selection must not throw the user's tuning away and reseed Tone's defaults
 * over it.
 *
 * A typed object spread rather than `setAtPath(preset, 'source', …)`: this is the
 * one write in the editor where the value's SHAPE is the whole point, and a
 * spread is checked against `VoiceSource` while a dotted path is not.
 *
 * ⚠ `preset.layer` IS DELIBERATELY LEFT ALONE, and it is audible. `Voice._buildLayer`
 * builds a second source from `layer` and triggers it alongside the primary, and the
 * three FM built-ins (Acoustic Bass, Electric Bass, Acoustic Ukulele) all carry one —
 * so switching one of them to Samples yields a sampler PLUS that untouched FM
 * sub-body, which can read as "the switch didn't take". Kept on purpose: a layer is a
 * separate voice with its own kind, and throwing it away because the primary moved
 * would silently discard tuning the user never pointed at. The second source now has
 * its own rows and its own picker ({@link withLayerSourceKind}), so that sub-body is
 * visible, mixable and removable rather than merely surviving — which is what made
 * leaving it alone here defensible in the first place.
 */
export function withSourceKind(preset: VoicePreset, kind: VoiceSourceKind): VoicePreset {
  if (preset.source.kind === kind) return preset;
  return { ...preset, source: defaultSourceFor(kind) };
}

/**
 * `preset` with its SECOND source replaced by a well-formed one of `kind`.
 *
 * `withSourceKind` one level down, and separate from it rather than a `branch`
 * argument on it for a reason that is not stylistic: `trackVoiceDrafts`
 * `setTrackVoiceParam` handles a `source-kind` row by calling
 * `withSourceKind(preset, value)` with no path at all, so ANY second row of that
 * kind in `PARAM_SECTIONS` would swap the PRIMARY source while the caller
 * pointed at the layer. That is why the layer's picker is declared on
 * `ParamSubBranch.kindRow` and never in `section.params` — see the note there.
 *
 * Same identity contract as `withSourceKind`: unchanged in, same reference out,
 * because the editors' dirty checks are reference-based. A preset with no layer
 * is returned untouched — re-kinding something that is not there is not an
 * operation, and creating one here would hide the add gesture inside a picker.
 */
export function withLayerSourceKind(preset: VoicePreset, kind: VoiceSourceKind): VoicePreset {
  const layer = preset.layer;
  if (!layer || layer.source.kind === kind) return preset;
  return { ...preset, layer: { ...layer, source: defaultSourceFor(kind) } };
}

/**
 * How far under the primary a freshly added second source sits, in dB.
 *
 * A second source at unity is a second VOICE, which is the level jump this seed
 * exists to avoid: summed coherently, two equal sources are +6 dB. Twelve dB
 * down sums to +1.9 dB — under a just-perceptible step — while still being
 * plainly audible as body when soloed by ear.
 *
 * ⚠ RELATIVE TO THE PRIMARY, WHICH IS NOT THE SAME AS RELATIVE TO FULL SCALE —
 * see {@link seedLayerFor}, which is the only thing that should ever write it.
 */
const SEED_LAYER_MIX_DB = -12;

/**
 * What a second source is when the user has just added one.
 *
 * ⚠ NOT A TONE CITATION, and it cannot be: a `VoiceLayer` is the lib's own
 * construct — one extra synth mixed under the primary and triggered on the same
 * note — and no Tone node has a "layer". So every number here is the APP's
 * choice, stated with its reason, which is the same treatment `paramSchema`
 * gives `layer.octaveOffset`.
 *
 *   `source`  — an FM synth on Tone's documented FM defaults. FM because it is
 *               the one kind whose `detuneCents` the engine honours
 *               (`applyLayerDetune` ignores a PluckSynth), and because it is the
 *               only kind that needs no download before the next note.
 *   `gainDb`  — {@link SEED_LAYER_MIX_DB}, the NOMINAL mix level: what a layer
 *               sits at under a primary that needs no calibration trim. The
 *               value actually written on Add comes from {@link seedLayerFor},
 *               which corrects it for the primary in hand.
 *   `octaveOffset` — 0. Adding a stage must not change the voice's PITCH
 *               content: at −1 the first thing the user hears is a new bass note
 *               they did not ask for. The octave control is the row directly
 *               beneath, so a sub-octave is one click away.
 *   `detuneCents` — 0. Unison; a detune the user did not dial is a chorus they
 *               did not ask for.
 */
export const SEED_LAYER: VoiceLayer = {
  source: defaultSourceFor('fm-synth'),
  gainDb: SEED_LAYER_MIX_DB,
  octaveOffset: 0,
  detuneCents: 0,
};

/**
 * {@link SEED_LAYER}, levelled against the primary it is about to sit under.
 *
 * ⚠ THE PRIMARY AND THE LAYER DO NOT MEET THE MIXER AT THE SAME REFERENCE, and
 * a flat −12 dB is therefore wrong on ten of the fourteen built-ins.
 * `Voice._ensureBuilt` puts the primary through a `_sourceTrim` node of
 * `sourceTrimDb(preset.source)` — **−17 dB for a sampler**, because the packs
 * are mastered to −1 dBFS and the lib calibrates every source to −18 — while
 * `_buildLayer` connects the layer straight to the mixer, folding in only
 * `sourceTrimDb(layer.source)`, which is 0 for both synths. That bypass is
 * deliberate (a synth layer must not inherit the packs' mastering trim), so the
 * correction belongs here.
 *
 * A layer seeded at a flat −12 under a SAMPLED primary therefore arrives about
 * 5 dB LOUDER than the thing it is meant to sit beneath, not 12 dB under it —
 * a level jump on Acoustic Guitar, both Karoryfer guitars and all seven amp
 * presets, i.e. on the sound the user meets first.
 *
 * The correction is the difference of the two trims, so the layer lands
 * {@link SEED_LAYER_MIX_DB} below the primary AT THE MIXER whichever family the
 * primary belongs to: −29 dB under a sampler, −12 dB under a synth. It assumes
 * the two sources' raw peaks are comparable, which is the only assumption
 * available — `levels.ts` says outright that a synth "passes at unity because
 * nothing has measured it" — and it is the assumption the flat number was
 * making silently for the primary alone.
 */
export function seedLayerFor(preset: VoicePreset): VoiceLayer {
  return {
    ...SEED_LAYER,
    gainDb: SEED_LAYER_MIX_DB + sourceTrimDb(preset.source) - sourceTrimDb(SEED_LAYER.source),
  };
}

/**
 * What a body filter is when the user has just added one.
 *
 * ⚠ A SECTION SEED IS "NEUTRAL", NOT "TONE'S DEFAULT" — the rule the Amp and
 * Cabinet sections already follow (`preDrive: 0.3`, the first registered IR),
 * and the one the pane's own copy states: adding a stage "seeds it with neutral
 * values you can then tune". Tone's 15.1.22 `classes/Filter.html` publishes no
 * defaults at all; the 13.8.25 `Filter` DEFAULTS block gives
 * `frequency: 350, Q: 1`, and 350 Hz is a lowpass that would visibly darken every
 * voice it was added to. A seed that changes the sound the moment you press Add
 * is a seed that has to be undone before it can be used.
 *
 *   `cutoff` — 8000 Hz. Above the register a guitar's or bass's partials carry,
 *              so the stage arrives near-transparent through the lib's fixed
 *              `-12 dB/oct` lowpass and the user sweeps DOWN into the sound.
 *   `q`      — 0.7 ≈ 1/√2, the maximally-flat (Butterworth) response: the one
 *              value at which a lowpass has no resonant peak at all. A DSP fact
 *              about the filter, not a range claim about the field.
 *
 * `enabled` is omitted on purpose — the lib documents `undefined` as
 * implicit-on, and writing `true` would turn "unspecified" into a value nobody
 * chose. `envelope` is omitted because a static cutoff is a real sound and not a
 * degraded one; it is added by its own gesture.
 */
export const SEED_BODY_FILTER: BodyFilterParams = {
  cutoff: 8000,
  q: 0.7,
};

/**
 * What the body filter's cutoff envelope is when the user has just added one.
 *
 * The lib: the envelope sweeps the cutoff from `baseFrequency` upward by
 * `octaves`, then settles at `baseFrequency * 2^(sustain * octaves)` — and while
 * an envelope is present the static `cutoff` is IGNORED. So the seed's job is to
 * arrive without moving the sound the static filter was already making.
 *
 * ⚠ THE ONE NUMBER THAT IS NOT FREE: `baseFrequency * 2^octaves` is 2000 × 4 =
 * 8000 Hz, which is exactly {@link SEED_BODY_FILTER}.cutoff. The envelope's PEAK
 * therefore lands where the static filter sat, so the attack of a note is
 * unchanged and only the sustained body darkens (to 2000 × 2^1 = 4000 Hz at
 * `sustain: 0.5`) — audibly the thing a body filter is for, with no jump.
 * `sourceDefaults.test.ts` pins that identity, because the two constants can
 * otherwise drift apart silently.
 *
 * The four time/level fields are the app's, like everything else here: a 50 ms
 * attack is fast enough not to smear a pluck and slow enough to be heard as a
 * sweep rather than a click.
 */
export const SEED_BODY_FILTER_ENVELOPE: BodyFilterEnvelope = {
  attack: 0.05,
  decay: 0.2,
  sustain: 0.5,
  release: 0.5,
  baseFrequency: 2000,
  octaves: 2,
};
