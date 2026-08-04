/**
 * One track's voice, drawn as a rack across its whole lane — voice mode's answer
 * to "what does a lane draw".
 *
 * ── Why the lane and not a modal or the header ───────────────────────────────
 *
 * The rejected alternative was a modal per track: a modal can only show one
 * track at a time, and the whole point of per-track voices is comparing two.
 * The 200 px track header was the other, and CP-13 measured it — two `<select>`s
 * in that column leave each about six readable characters, which is why the
 * compact voice PICKER there stays behind a disclosure and stays a picker. A
 * lane is the only surface wide enough for four stages side by side, and stacked
 * down the page the lanes are a 19" equipment rack, which is the design language
 * this project already chose.
 *
 * ── This is chrome. The table is `paramSchema` ───────────────────────────────
 *
 * Every control here is one row of `PARAM_SECTIONS`, addressed into the preset
 * by `presetPaths` — the same table `VoicePane` renders on the pattern page.
 * Nothing in this file knows that an amp has a "Bass" or what its range is, so
 * adding a parameter is a change to the descriptors and not to this component.
 * The four stages are four `RackFace`s for the same reason `VoiceSection` is
 * one: `RackFace` is the chassis, and its `regionName` is what makes eight
 * racks' worth of identically-named controls navigable — see the note on
 * accessible names below.
 *
 * ── Where the edits go ───────────────────────────────────────────────────────
 *
 * Not into the voice store. They accumulate in `trackVoiceDrafts`, which lives
 * above every component in the app because this one unmounts twice over (leaving
 * voice mode, and every visit to the pattern page) — and because a knob has to
 * be a way of CALLING a capability the agent can call by id and value. Every
 * write here is one seam call whose refusal is rendered rather than swallowed.
 *
 * Saving a draft to a variant is CP-15's, along with the variant list. That is
 * not an oversight in the layout: a voice is a SHARED asset, so writing one back
 * retunes every pattern and every other track pointing at it, and that belongs
 * to a deliberate control and not to the act of turning a knob.
 *
 * ── ⚠ Accessible names, and what is accepted here ────────────────────────────
 *
 * `Knob`, `ParamEnum` and `CabinetGraphic` name their controls from the
 * descriptor's label alone, and none of them takes an override. With eight racks
 * open there are therefore eight sliders called "Drive". They are NOT modified
 * to take one — they are shared with the pattern page and were checked as
 * multi-instance safe as they stand — so the disambiguation is the one `RackFace`
 * documents for exactly this: every stage is a landmark region named for its
 * track ("Rhythm amp"), which is how a screen reader tells two apart and how the
 * tests scope their queries. A per-control override across four shared
 * components is the better answer and is a change to those components, not to
 * this one.
 *
 * ── ⚠ There is no reverb here, and that is deliberate ────────────────────────
 *
 * A `VoicePreset` has its own reverb and `paramSchema` does not declare it, so it
 * is out of scope. The OTHER reverb — `useVoiceStore.reverb` — is a single
 * `Tone.Reverb` send on `MasterBus` that every voice passes through, with one
 * `setReverb` for the whole store. A per-track rack showing "reverb" would show
 * eight controls that are secretly one, so it shows none.
 */
import { getAmpModel, getSamplePack, detectSamplePack, type Track } from '@fretwork/lib';
import {
  PARAM_SECTIONS,
  enabledParamOf,
  sectionPresence,
  type EnumParam,
  type Param,
  type ParamSection,
  type SliderParam,
} from '../voice/paramSchema';
import { getAtPath } from '../voice/presetPaths';
import {
  addTrackVoiceSection,
  discardTrackVoiceDraft,
  removeTrackVoiceSection,
  setTrackVoiceParam,
  useTrackVoiceDirty,
  useTrackVoiceWorkingPreset,
} from '../voice/trackVoiceDrafts';
import { PowerLamp, RackFace } from '../voice/rack/RackFace';
import { AmpHead } from '../voice/rack/AmpHead';
import { CabinetGraphic } from '../voice/rack/CabinetGraphic';
import { Knob } from '../voice/controls/Knob';
import { ParamEnum } from '../voice/controls/ParamEnum';
import { ParamToggle } from '../voice/controls/ParamToggle';
import type { Result } from './compositionService';

/** Smaller than the pattern pane's 56 px default: eight amp knobs plus a cabinet
 *  and a level stage have to fit one lane's width, and `Knob` scales its own
 *  type off this so the labels stay proportionate rather than overflowing. */
const AMP_KNOB_PX = 42;
const SMALL_KNOB_PX = 38;

/** The cabinet's URL, which is the one path this file names by hand — the mic
 *  dot writes it, and the descriptor beside it is what resolves it. */
const CAB_URL_PATH = 'effects.cabIR.url';

/** `id` on an input, `htmlFor` on its label. Scoped by TRACK as well as by path:
 *  eight racks would otherwise mint eight elements with the same `id`, and a
 *  `<label htmlFor>` resolves to whichever mounted first. */
const domId = (trackId: string, path: string) =>
  `track-voice-${trackId}-${path.replaceAll('.', '-')}`;

const buttonClass =
  'pressable control flex-none rounded-md px-1.5 py-0.5 font-mono text-[8.5px] font-bold tracking-[0.06em] uppercase disabled:opacity-40';

export function TrackVoiceRack({
  track,
  audible,
  collapsed,
  onCollapsedChange,
  onNotice,
}: {
  track: Track;
  /** Whether this track will actually be heard — mute, solo and every other
   *  track's solo state. Computed by the grid, because the answer depends on the
   *  whole stack; drawn here as the rack's power lamp, which is the one honest
   *  reading of a lamp on a mixer. */
  audible: boolean;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  /** Refusals go to the grid's one message strip, as every other track write
   *  does — there is no room for a per-rack alert and no reason for one. */
  onNotice: (message: string) => void;
}) {
  const preset = useTrackVoiceWorkingPreset(track);
  const dirty = useTrackVoiceDirty(track);

  const report = (result: Result) => {
    if (!result.ok) onNotice(result.reason);
  };

  const write = (path: string, value: unknown) =>
    report(setTrackVoiceParam(track.id, path, value));

  /**
   * The same `SliderParam`, drawn as a rotary instead of a row — `VoicePane`'s
   * `renderKnob`, unchanged in substance. Every number still comes from the
   * descriptor, including `fallback` as the double-click reset, so nothing about
   * an amp's ranges is known to this file.
   */
  const renderKnob = (param: SliderParam, size: number) => {
    const raw = getAtPath(preset, param.path);
    return (
      <Knob
        key={param.path}
        label={param.label}
        size={size}
        value={typeof raw === 'number' ? raw : param.fallback}
        min={param.min}
        max={param.max}
        step={param.step}
        defaultValue={param.fallback}
        formatValue={(v) =>
          `${v.toFixed(param.precision)}${param.unit ? ` ${param.unit}` : ''}`
        }
        onChange={(value) => write(param.path, value)}
      />
    );
  };

  const renderParam = (section: ParamSection, param: Param) => {
    const raw = getAtPath(preset, param.path);
    const id = domId(track.id, param.path);

    switch (param.kind) {
      case 'toggle':
        return (
          <ParamToggle
            key={param.path}
            id={id}
            label={param.label}
            // Every stage's bypass is labelled "Enabled" and there are up to
            // eight racks of them, so the name carries the track and the stage
            // while the visible label stays inside a 74 px column.
            ariaLabel={`${track.name} ${section.label} ${param.label}`}
            value={typeof raw === 'boolean' ? raw : param.fallback}
            onChange={(value) => write(param.path, value)}
          />
        );

      case 'enum':
        return (
          <ParamEnum
            key={param.path}
            id={id}
            label={param.label}
            value={param.resolve(raw)}
            options={param.options}
            badgeOf={param.badgeOf}
            onChange={(value) => write(param.path, value)}
          />
        );

      case 'sample-pack': {
        // A preset stores note→URL maps rather than a pack id, so the active
        // entry is found by deep shape; `null` is a hand-authored map matching
        // no registered pack, which the picker admits rather than papering over.
        const banks = Array.isArray(raw)
          ? (raw as ReadonlyArray<Readonly<Record<string, string>>>)
          : null;
        const active = banks ? detectSamplePack(banks) : null;
        return (
          <ParamEnum
            key={param.path}
            id={id}
            label={param.label}
            value={active?.id ?? null}
            placeholder="Custom sample map"
            options={param.options.map((option) => ({
              value: option.id,
              label: option.label,
              description: option.description,
            }))}
            // The seam takes the PACK ID and resolves the maps itself, so the
            // agent addresses a registry entry rather than authoring a sample
            // map. `getSamplePack` is consulted here only to refuse early on an
            // id the registry lost between render and change.
            onChange={(packId) =>
              getSamplePack(packId)
                ? write(param.path, packId)
                : onNotice('That sample pack is no longer registered.')
            }
          />
        );
      }

      case 'slider':
        // Every slider in this table is drawn as a knob here — the lane is a
        // rack face, and a 74 px label plus a 52 px readout per row is the pane
        // layout, not the rack one.
        return renderKnob(param, SMALL_KNOB_PX);
    }
  };

  const stageActions = (section: ParamSection, present: boolean) =>
    section.removableBranch ? (
      <button
        type="button"
        // Up to eight racks × two removable stages, so the name carries both.
        aria-label={`${present ? 'Remove' : 'Add'} ${section.label} for ${track.name}`}
        onClick={() =>
          report(
            present
              ? removeTrackVoiceSection(track.id, section.id)
              : addTrackVoiceSection(track.id, section.id),
          )
        }
        className={buttonClass}
      >
        {present ? 'Remove' : 'Add'}
      </button>
    ) : null;

  /** The amp, as an amp: knobs on the plate, bypass as the power switch, the
   *  model the chain would really build engraved on the face. Split by `kind`,
   *  so a slider the schema gains appears as a knob without touching this. */
  const renderAmp = (section: ParamSection) => {
    const power = enabledParamOf(section);
    const enabled = power ? getAtPath(preset, power.path) !== false : true;
    const rawModel = getAtPath(preset, 'effects.amp.modelId');
    return (
      <>
        <AmpHead
          model={getAmpModel(typeof rawModel === 'string' ? rawModel : undefined).name}
          enabled={enabled}
          power={
            power
              ? {
                  label: `${track.name} ${section.label} ${power.label}`,
                  onChange: (next) => write(power.path, next),
                }
              : undefined
          }
        >
          {section.params
            .filter((param): param is SliderParam => param.kind === 'slider')
            .map((param) => renderKnob(param, AMP_KNOB_PX))}
        </AmpHead>
        {section.params
          .filter((param) => param.kind !== 'slider' && param !== power)
          .map((param) => renderParam(section, param))}
      </>
    );
  };

  /** The cabinet, as a cabinet. The mic dot picks the IR; the schema's `<select>`
   *  stays as the text-level route to the same value and as the only place the
   *  registry's description of a capture is readable.
   *
   *  ⚠ BESIDE THE GRAPHIC, NOT UNDER IT. `DEFAULT_LANE_HEIGHTS.voice` is derived
   *  from the cabinet well plus its caption because that is the tallest thing a
   *  rack contains; stacking the bypass and the IR picker below it adds ~50 px
   *  the lane has not got, and the picker lands below the fold of every open
   *  lane. The column beside a 200 px square has room for both several times
   *  over, so this costs nothing and keeps the stage graphic-height. */
  const renderCabinet = (section: ParamSection) => {
    const cab = section.params.find(
      (param): param is EnumParam => param.kind === 'enum' && param.path === CAB_URL_PATH,
    );
    return (
      <div className="flex flex-wrap items-start gap-1.5">
        {cab ? (
          <CabinetGraphic
            url={cab.resolve(getAtPath(preset, cab.path))}
            onChange={(url) => write(cab.path, url)}
            bypassed={sectionPresence(preset, section) === 'bypassed'}
          />
        ) : null}
        <div className="flex min-w-[190px] flex-1 flex-col gap-1">
          {section.params
            .filter((param): param is SliderParam => param.kind === 'slider')
            .map((param) => renderKnob(param, SMALL_KNOB_PX))}
          {/* The cabinet `<select>` is deliberately still here alongside the
              dot: it is the text-level route to the same value and the only
              place the registry's description of a capture can be read. */}
          {section.params
            .filter((param) => param.kind !== 'slider')
            .map((param) => renderParam(section, param))}
        </div>
      </div>
    );
  };

  const renderStage = (section: ParamSection) => {
    const presence = sectionPresence(preset, section);
    return (
      <RackFace
        key={section.id}
        // The landmark name is what disambiguates eight racks' identically
        // named controls — see the banner. Track first, because that is the
        // axis a listener is navigating.
        regionName={`${track.name} ${section.label}`}
        name={
          <span className="flex-none font-mono text-[9px] font-semibold tracking-[0.16em] text-ink-mut uppercase">
            {section.label}
          </span>
        }
        note={presence === 'bypassed' ? 'Bypassed' : null}
        lit={presence === 'active'}
        actions={stageActions(section, presence !== 'absent')}
      >
        <div className="flex flex-col gap-1 px-1.5 py-1">
          {presence === 'absent' ? (
            <p className="max-w-[26ch] font-mono text-[8.5px] leading-snug text-ink-mut">
              {section.removableBranch
                ? `No ${section.label.toLowerCase()} stage on this voice.`
                : /* Samples has no removable branch: a non-sampler source is a
                     pluck synth, and synth params are a later slice. */
                  'This voice is not sampler-based.'}
            </p>
          ) : section.id === 'amp' ? (
            renderAmp(section)
          ) : section.id === 'cabinet' ? (
            renderCabinet(section)
          ) : (
            <div className="flex flex-wrap items-start gap-x-2 gap-y-1">
              {section.params.map((param) => renderParam(section, param))}
            </div>
          )}
        </div>
      </RackFace>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-1 p-1">
      <div className="flex flex-none items-center gap-1.5">
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-label={`Voice rack for ${track.name}`}
          onClick={() => onCollapsedChange(!collapsed)}
          className="pressable control flex flex-none items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[8.5px] font-bold tracking-[0.1em] uppercase"
        >
          <span aria-hidden className="text-ink-mut">
            {collapsed ? '▸' : '▾'}
          </span>
          {track.name}
        </button>
        {/* `RackFace`'s own lamp, so the strip and the four faceplates below it
            cannot drift apart. It says what will be HEARD, which on a mixer is
            the only honest reading of one: mute wins, and a solo elsewhere
            silences this. */}
        <PowerLamp lit={audible} />
        <span className="min-w-0 truncate font-mono text-[8.5px] tracking-[0.06em] text-ink-mut">
          {preset.name}
        </span>
        {/* Brass marks unsaved, the way it marks every other live state here.
            Announced rather than only coloured — an edit that exists only as a
            colour is one a user cannot confirm they made. */}
        <span
          className={`flex-none font-mono text-[8.5px] tracking-[0.1em] uppercase ${
            dirty ? 'text-brass-hi' : 'text-ink-mut'
          }`}
        >
          {dirty ? 'Unsaved' : 'Saved'}
        </span>
        <span className="flex-1" />
        {dirty && (
          <button
            type="button"
            aria-label={`Discard voice changes for ${track.name}`}
            title="Put this track back on its stored voice"
            onClick={() => report(discardTrackVoiceDraft(track.id))}
            className={buttonClass}
          >
            Revert
          </button>
        )}
        {/* TODO(CP-15): Save / Save as… / Rename and the variant list arrive in
            the rail, which still shows its placeholder. Said out loud here
            because "Unsaved" with no Save beside it otherwise reads as a bug
            rather than as a slice boundary. */}
        <span className="flex-none font-mono text-[8px] tracking-[0.1em] text-ink-mut/70 uppercase">
          Saving arrives with the voice list
        </span>
      </div>

      {!collapsed && (
        // Scrolls rather than clips: the lane's height is a constant in
        // `arrangementMath` measured against the tallest stage, and a browser
        // that lays a face out a few pixels taller must lose nothing.
        <div className="flex min-h-0 flex-1 items-start gap-1.5 overflow-auto">
          {PARAM_SECTIONS.map(renderStage)}
        </div>
      )}
    </div>
  );
}
