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
  type FMSynthParams,
  type PluckSynthParams,
  type VoiceSource,
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
 * would silently discard tuning the user never pointed at. The slice that gives
 * `layer` its own rows (`layer.source.kind`, the same `appliesWhen` mechanism one
 * level down) is where it becomes switchable rather than merely surviving.
 */
export function withSourceKind(preset: VoicePreset, kind: VoiceSourceKind): VoicePreset {
  if (preset.source.kind === kind) return preset;
  return { ...preset, source: defaultSourceFor(kind) };
}
