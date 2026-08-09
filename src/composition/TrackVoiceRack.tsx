/**
 * One track's voice, drawn as a rack down its whole row — voice mode's answer to
 * "what does a lane draw".
 *
 * ── Why the row and not a modal or the header ────────────────────────────────
 *
 * The rejected alternative was a modal per track: a modal can only show one
 * track at a time, and the whole point of per-track voices is comparing two.
 * The 200 px track header was the other, and CP-13 measured it — two `<select>`s
 * in that column leave each about six readable characters, which is why the
 * compact voice PICKER there stays behind a disclosure and stays a picker. A
 * row of the arrangement is the only surface with room for a whole chain, and
 * stacked down the page the rows are a 19" equipment rack, which is the design
 * language this project already chose.
 *
 * ── ⚠ THE STAGES STACK. CP-16 corrected CP-14 here ───────────────────────────
 *
 * They ran left to right, in a flex row with its own horizontal scrollbar. That
 * came out of a brief that said "a rack spanning the full lane width", and it
 * was wrong twice over: it is not what a rack looks like, and it forced the row
 * to a FIXED height that no function could keep in step with what the sections
 * inside it were showing. They are now `flex flex-col`, exactly as `VoicePane`
 * arranges the same four stages on the pattern page.
 *
 * The design argument for racks-over-modals survives intact, because it was
 * never about this axis: what has to be visible at once is TWO TRACKS' settings,
 * and stacking the sections within one track does not touch that.
 *
 * TWO LEVELS OF DISCLOSURE now, and their accessible names have to say which is
 * which — "Voice rack for Lead" folds this whole rack away (its state is
 * `collapsedRacks` in `App`), "Amp stage for Lead" folds one section of it
 * (`collapsedRackSections`, beside it, for the same reason).
 *
 * BOTH DISCLOSURES ARE `shell/Section`, which is the shared one — this file used
 * to hand-roll the stage's, and the note here used to explain why. That reason
 * is gone: it was that `VoiceSection` hard-codes its landmark as `${label} stage`
 * and carries the pane's status vocabulary ("Not on this preset", where a rack
 * says nothing and goes dark). `VoiceSection` no longer owns the disclosure at
 * all. `Section` builds the button and the region, a `chassis` render prop
 * decides what they are bolted to — `RackFace`, here as there — and `buttonLabel`
 * is the track-scoped name. Both of the old blockers are things this file now
 * simply passes in. What stays local is what was always particular: the
 * `regionName`, because up to eight racks are on screen at once and the TRACK is
 * what tells eight "Drive" sliders apart (see the banner below).
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
  DEFAULT_OPEN_SECTIONS,
  PARAM_SECTIONS,
  enabledParamOf,
  sectionPresence,
  type EnumParam,
  type Param,
  type ParamSection,
  type SectionId,
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
import { Section } from '../shell/Section';
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

/**
 * What a rack nobody has folded yet shows: everything except
 * `DEFAULT_OPEN_SECTIONS`, which is the pattern page's default and now the
 * schema's. DERIVED rather than listed, so a fifth `ParamSection` starts folded
 * here without this file being edited — and so the two editors cannot open on
 * different stages, which is what CP-14 shipped.
 *
 * Module-level so the default prop keeps a stable identity across renders.
 */
const DEFAULT_COLLAPSED_SECTIONS: readonly SectionId[] = PARAM_SECTIONS.filter(
  (section) => !DEFAULT_OPEN_SECTIONS.includes(section.id),
).map((section) => section.id);

export function TrackVoiceRack({
  track,
  audible,
  collapsed,
  onCollapsedChange,
  collapsedSections = DEFAULT_COLLAPSED_SECTIONS,
  onCollapsedSectionsChange,
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
  /**
   * Which of THIS track's stages are folded. The FOLDED set rather than the open
   * one so it cannot go stale when `paramSchema` gains a section: a name nobody
   * has heard of is open, which is the safe way round for a control surface.
   *
   * `undefined` is "nobody has folded this rack yet" and opens on
   * `DEFAULT_COLLAPSED_SECTIONS` — which is NOT the same as an empty list, and
   * the caller must keep the two apart: an empty list is a user who has unfolded
   * everything, and collapsing it back to `undefined` would re-fold two stages
   * under them on the next render.
   *
   * Reported up rather than kept here for the reason `collapsed` is: this
   * component is replaced on every mode switch and unmounted on every visit to
   * the pattern page, and a section that unfolds itself behind your back is the
   * same bug as a rack that does. It lives in `App`, beside `collapsedRacks`.
   */
  collapsedSections?: readonly SectionId[];
  onCollapsedSectionsChange?: (collapsed: readonly SectionId[]) => void;
  /** Refusals go to the grid's one message strip, as every other track write
   *  does — there is no room for a per-rack alert and no reason for one. */
  onNotice: (message: string) => void;
}) {
  const preset = useTrackVoiceWorkingPreset(track);
  const dirty = useTrackVoiceDirty(track);

  const toggleSection = (id: SectionId) =>
    onCollapsedSectionsChange?.(
      collapsedSections.includes(id)
        ? collapsedSections.filter((candidate) => candidate !== id)
        : [...collapsedSections, id],
    );

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
   *  BESIDE THE GRAPHIC, NOT UNDER IT — still, though the reason has changed.
   *  CP-14 needed it because a fixed lane height had no room for another ~50 px
   *  and the IR picker fell below the fold; CP-16 deleted that height, so the
   *  row would simply grow. It stays because the column beside a 200 px square
   *  is otherwise empty, and a stage that is as tall as its own graphic reads as
   *  one piece of gear rather than as a picture with a form under it. */
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
    const open = !collapsedSections.includes(section.id);
    return (
      <Section
        key={section.id}
        label={section.label}
        // Deliberately NOT the landmark's name, and deliberately not the rack's
        // either: three things are foldable on this page and they have to be
        // tellable apart by name alone — "Voice rack for Lead" is the whole
        // rack, this is one stage of it, and the region it controls is
        // "Lead Amp".
        buttonLabel={`${section.label} stage for ${track.name}`}
        open={open}
        onToggle={() => toggleSection(section.id)}
        actions={stageActions(section, presence !== 'absent')}
        bodyClassName="flex flex-col gap-1 px-1.5 py-1"
        chassis={(parts) => (
          <RackFace
            // The landmark name is what disambiguates eight racks' identically
            // named controls — see the banner. Track first, because that is the
            // axis a listener is navigating.
            regionName={`${track.name} ${section.label}`}
            // The chassis owns the material, and this one's engraved names are
            // muted where the pattern pane's are not.
            name={<span className="text-ink-mut">{parts.name}</span>}
            note={presence === 'bypassed' ? 'Bypassed' : null}
            lit={presence === 'active'}
            actions={parts.actions}
          >
            {parts.region}
          </RackFace>
        )}
      >
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
      </Section>
    );
  };

  return (
    // Normal flow, no height of its own: the ROW is as tall as this is (CP-16),
    // rather than this being clipped or scrolled inside a computed lane.
    <div className="flex flex-col gap-1 p-1">
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
        {/* CP-15 landed the other half: Save / Save as… / Rename and the variant
            list are in the rail, acting on the SELECTED track. Said out loud
            here because "Unsaved" with a Revert and no Save beside it otherwise
            reads as a missing button rather than as a division of labour — this
            strip discards an edit where it was made, the rail is where a voice
            is chosen and written. */}
        <span className="flex-none font-mono text-[8px] tracking-[0.1em] text-ink-mut/70 uppercase">
          Save in the rail
        </span>
      </div>

      {!collapsed && (
        // Stacked, and nothing scrolls here: `VoicePane.tsx`'s arrangement of
        // the same four stages, for the same reason it gives — a rack is as tall
        // as it is, and what scrolls is the surface holding the racks.
        <div className="flex flex-col gap-1.5">{PARAM_SECTIONS.map(renderStage)}</div>
      )}
    </div>
  );
}
