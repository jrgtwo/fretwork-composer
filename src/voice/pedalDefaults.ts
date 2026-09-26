/**
 * What an effect branch is made of when the user has just added it — every
 * pedal, and the cabinet's room.
 *
 * The effects counterpart of `sourceDefaults.ts`, and it follows that file's
 * rule as far as the rule goes: **the numbers are Tone's own defaults**, so a
 * branch makes a sound the moment it is switched on and before a single control
 * is turned. They are not taken from any shipped preset — those are preselected
 * settings, and a default derived from one means "sound like the ambient patch"
 * rather than "sound like a chorus". TWO seeds deviate, both below, and each
 * says so at its own declaration.
 *
 * ── WHERE THE CITATION COMES FROM, and why it is not the docs site ───────────
 *
 * `sourceDefaults.ts` had to cite the 13.8.25 documentation pages, because the
 * 15.1.22 typedoc — the version the lib depends on — publishes ranges but no
 * default values at all. That detour is unnecessary here: every node below
 * ships a `static getDefaults()` in the installed package, so the citation is
 * the FILE THE APP ACTUALLY RESOLVES, at the version in `node_modules`. Each
 * seed names it. A dependency bump that changes a default is then a diff in a
 * file this repo can read, rather than a claim about a web page.
 *
 * ── THE TWO SEEDS THAT DEVIATE, and they say so ──────────────────────────────
 *
 * They deviate for different reasons and neither is a taste import.
 *
 * The GRAPHIC EQ has nothing to cite. It is not a Tone node — the lib composes
 * it from seven `Tone.Filter` peaking bands and a `Tone.Gain` — so there is no
 * `getDefaults()` and no neutral Tone ever published. Flat (every band at 0 dB,
 * level at 0 dB) is the app's choice, stated as the app's, the same honesty
 * `paramSchema`'s `layer.octaveOffset` floor uses for the same absence.
 *
 * The ROOM has one and refuses it on ONE field. `JCReverb`'s `roomSize: 0.5` is
 * kept verbatim; `wet` inherits `1` from `StereoEffect`, which is the dry signal
 * gone entirely. Every other seed here keeps Tone's `wet` because a pedal at
 * `wet: 0` would be an inaudible lit stage — a reverb is the opposite case,
 * where Tone's default is the unusable end. The replacement is provisional and
 * marked as such at the seed.
 *
 * ── WHY A WHOLE VALUE RATHER THAN ROW FALLBACKS ──────────────────────────────
 *
 * `addVoiceSection` builds a section by writing each required row's
 * `fallback` one at a time. That works for a flat stage and it is not what a
 * pedal wants: a pedal is added as one branch in one write, so the value has to
 * be well-formed the instant it lands — the same argument `ParamSubBranch.seed`
 * makes, and the same reason it exists. Typed as the lib's own params interface
 * here, which is where `tsc` checks the shape; the descriptor table stores it as
 * `object` because a table has no one type for "a branch of a preset".
 */
import type {
  AutoWahParams,
  ChorusParams,
  CompressorParams,
  DelayParams,
  DistortionParams,
  GraphicEqParams,
  PedalParamsOf,
  PedalType,
  VoiceReverbParams,
} from '@fretwork/lib';

/**
 * `tone/build/esm/component/dynamics/Compressor.js` `getDefaults()` (15.1.22).
 *
 * The one fully-bounded pedal in the set — that same file carries real `@min` /
 * `@max` on all five fields, which is why every compressor row in `paramSchema`
 * is a slider and almost nothing else is.
 */
export const SEED_COMPRESSOR: CompressorParams = {
  threshold: -24,
  ratio: 12,
  attack: 0.003,
  release: 0.25,
  knee: 30,
};

/**
 * `tone/build/esm/effect/Distortion.js` `getDefaults()` (15.1.22) for `drive`
 * (Tone calls it `distortion`) and `oversample`; `wet` is inherited from
 * `effect/Effect.js` `getDefaults()`, which is 1.
 *
 * Fully wet is Tone's default and it is kept. A distortion added at `wet: 0`
 * would be a stage that is in the chain, lit, and inaudible — which is what
 * bypass is for and what an Add gesture should never produce.
 */
export const SEED_DISTORTION: DistortionParams = {
  drive: 0.4,
  wet: 1,
  oversample: 'none',
};

/**
 * `tone/build/esm/effect/Chorus.js` `getDefaults()` (15.1.22). Chorus overrides
 * the inherited `wet` to 0.5 itself, so that number is Chorus's own.
 *
 * ⚠ `delayTime` IS SECONDS HERE, and Tone's default is 3.5 MILLISECONDS. The
 * field this seeds is the lib's, not the node's: `ChorusParams.delayTime` is
 * seconds, the lib's own shipped preset stores `0.004` (`presets.ts`), and
 * `Voice.ts` multiplies by 1000 on the way into `Tone.Chorus.delayTime` — which
 * is the millisecond field, and which divides by 1000 again inside Tone. So
 * Tone's 3.5 ms is written here as 0.0035.
 *
 * Written as `3.5` it asked for a 3.5-SECOND swept delay against delay lines
 * whose default `maxDelay` is 1 s. Both LFOs clamp flat at the ceiling and the
 * chorus is a static one-second slapback, which is what it sounded like.
 */
export const SEED_CHORUS: ChorusParams = {
  frequency: 1.5,
  depth: 0.7,
  wet: 0.5,
  type: 'sine',
  feedback: 0,
  delayTime: 0.0035,
  spread: 180,
};

/**
 * `tone/build/esm/effect/FeedbackDelay.js` `getDefaults()` (15.1.22) for
 * `delayTime`; `feedback` from `effect/FeedbackEffect.js` (0.125) and `wet`
 * from `effect/Effect.js` (1), which FeedbackDelay does not override.
 *
 * `delayTime` here is SECONDS — Tone types this one `Time`, unlike the chorus's.
 * The two rows differ in unit for that reason and not by oversight.
 */
export const SEED_DELAY: DelayParams = {
  delayTime: 0.25,
  feedback: 0.125,
  wet: 1,
};

/** `tone/build/esm/effect/AutoWah.js` `getDefaults()` (15.1.22); `wet` from
 *  `effect/Effect.js` (1), which AutoWah does not override. Tone spells the
 *  resonance `Q`; the lib stores it as `q`. */
export const SEED_AUTO_WAH: AutoWahParams = {
  baseFrequency: 100,
  octaves: 6,
  sensitivity: 0,
  q: 2,
  gain: 2,
  wet: 1,
};

/**
 * ⚠ THE APP'S, NOT TONE'S — see the header. Seven `Tone.Filter` peaking bands
 * and a `Tone.Gain` have no composed default anywhere to cite.
 *
 * Flat, because the alternative is a tone-shaper that shapes tone the moment it
 * is added. A graphic EQ switched on and doing nothing is the honest starting
 * point: every band is where the user left it, which on a new one is nowhere.
 */
export const SEED_GRAPHIC_EQ: GraphicEqParams = {
  band100Hz: 0,
  band200Hz: 0,
  band400Hz: 0,
  band800Hz: 0,
  band1_6kHz: 0,
  band3_2kHz: 0,
  band6_4kHz: 0,
  levelDb: 0,
};

/**
 * Every pedal kind's seed, by the lib's `PedalType` — what the pedalboard's type
 * picker appends. A mapped type rather than six loose constants so a seventh kind
 * in the lib is a `tsc` failure here instead of a picker entry that seeds nothing,
 * and so each seed is checked against `PedalParamsOf` for ITS kind, which is the
 * shape `addPedal` stores.
 */
export const PEDAL_SEEDS: { readonly [K in PedalType]: PedalParamsOf<K> } = {
  compressor: SEED_COMPRESSOR,
  distortion: SEED_DISTORTION,
  chorus: SEED_CHORUS,
  delay: SEED_DELAY,
  autoWah: SEED_AUTO_WAH,
  graphicEq: SEED_GRAPHIC_EQ,
};

/**
 * The room the speaker is standing in — the per-voice reverb, wired after the
 * cabinet (lib `Voice.wireChain`), which is why it is seeded from the Cabinet
 * section rather than from a pedal.
 *
 * ⚠ ONE OF THE TWO SEEDS THAT IS NOT TONE'S DEFAULT, and the deviation is on
 * `wet` alone. `tone/build/esm/effect/JCReverb.js` `getDefaults()` (15.1.22)
 * gives `roomSize: 0.5` and that is kept verbatim; `wet` is inherited from
 * `effect/StereoEffect.js` `getDefaults()` — `JCReverb extends StereoEffect`,
 * not `Effect` — which is 1, a fully wet room, i.e. the
 * dry signal gone entirely. Every other seed in this file keeps Tone's `wet`
 * because a pedal at `wet: 0` would be an inaudible lit stage; a reverb is the
 * opposite case, where Tone's default is the unusable end.
 *
 * 0.25 is PROVISIONAL — a modest room, deliberately not the 0.9/0.55 the Surf
 * and Ambient built-ins carry, because a preset is a preselected setting and
 * not a source for a default. To be tuned by ear once the post-cab position is
 * something to listen to.
 */
export const SEED_VOICE_REVERB: VoiceReverbParams = {
  roomSize: 0.5,
  wet: 0.25,
};
