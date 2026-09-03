/**
 * What each pedal is made of when the user has just added it.
 *
 * The pedalboard counterpart of `sourceDefaults.ts`, and it follows that file's
 * rule exactly: **the numbers are Tone's own defaults**, so a pedal makes a
 * sound the moment it is switched on and before a single control is turned.
 * They are not taken from any shipped preset — those are preselected settings,
 * and a default derived from one means "sound like the ambient patch" rather
 * than "sound like a chorus".
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
 * ── THE ONE SEED THAT IS OURS, and it says so ────────────────────────────────
 *
 * The graphic EQ is not a Tone node. The lib composes it from seven
 * `Tone.Filter` peaking bands and a `Tone.Gain`, so there is no `getDefaults()`
 * to cite and no neutral Tone ever published. Flat — every band at 0 dB, level
 * at 0 dB — is the app's choice, stated as the app's, the same honesty
 * `paramSchema`'s `layer.octaveOffset` floor uses for the same absence.
 *
 * ── WHY A WHOLE VALUE RATHER THAN ROW FALLBACKS ──────────────────────────────
 *
 * `addTrackVoiceSection` builds a section by writing each required row's
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
 * ⚠ `delayTime` IS MILLISECONDS. Tone types it `Milliseconds` and defaults it to
 * 3.5; the lib's `ChorusParams.delayTime` comment says "Seconds", which is
 * wrong about the field it stores — the value goes to `Tone.Chorus.delayTime`
 * unconverted. The row in `paramSchema` carries Tone's unit, not the comment's.
 */
export const SEED_CHORUS: ChorusParams = {
  frequency: 1.5,
  depth: 0.7,
  wet: 0.5,
  type: 'sine',
  feedback: 0,
  delayTime: 3.5,
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
