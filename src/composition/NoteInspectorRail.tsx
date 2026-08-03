import { getInstrument, type PatternEvent } from '@fretwork/lib';
import {
  articulationsLostToTie,
  readNotePitch,
  tieLeaderOf,
  tieTargetFor,
} from '../patterns/articulations';
import {
  beginEditGesture,
  endEditGesture,
  nudgeSelectedFret,
  patternInstrumentId,
  setArticulations,
  setNoteDynamic,
  setNotePitch,
  useEditingPattern,
  useSelectedIds,
} from '../patterns/patternService';
import {
  DynamicControls,
  FlagControls,
  PitchControls,
  TieRow,
  VibratoRow,
} from '../timeline/NoteControls';
import {
  applyPitchEdit,
  commonValue,
  pitchNamer,
  type PitchDisplay,
  type PitchEdit,
} from '../timeline/noteModel';
import { stringLabels } from '../reference/tabLayout';

/**
 * The selected note's properties, in the composition page's right rail — the
 * edit-mode counterpart of the pattern page's `NotePopup`.
 *
 * SAME CONTROLS, NOT A COPY OF THEM. Everything below the header comes from
 * `src/timeline/NoteControls.tsx` over `src/timeline/noteModel.ts`, which the
 * popup renders too; nothing here decides what a bend depth is or which
 * technique flags exist. A control added to one surface and not the other fails
 * `tests/NoteInspectorRail.test.tsx`, which compares the options the two offer
 * over the same note.
 *
 * ⚠ WHICH SELECTION. This follows `patternService.useSelectedIds()` — the NOTE
 * selection. Edit mode has two live at once and they are different things:
 * `compositionService.useSelectedPlacementIds()` is the PLACEMENT selection,
 * which is what pattern mode's blocks answer to and what arrangement gestures
 * move. The rail is a note inspector, so it follows notes; the placement that
 * happens to be open is not its business.
 *
 * NO WRITE ROUTING. Every write goes through the pattern seam untouched.
 * CP-11's `openPlacementForEditing` already points the lib's edit target at the
 * focused placement, so `setNotePitch` and friends land on that placement's
 * snapshot rather than on the library pattern. A second routing mechanism here
 * would be a second place for that to go wrong.
 */
export function NoteInspectorRail() {
  const pattern = useEditingPattern();
  const selectedIds = useSelectedIds();
  const events = pattern?.events ?? [];
  const selected = events.filter((event) => selectedIds.includes(event.id));

  if (!pattern || selected.length === 0) {
    // The rail is ALWAYS mounted in edit mode, so an empty one has to say which
    // kind of empty it is. Silence here reads as broken — the same reason the
    // page states a failed composition open instead of drawing nothing.
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-1.5 px-4 text-center">
        <p className="font-mono text-[10px] tracking-[0.14em] text-ink uppercase">
          No note selected
        </p>
        <p className="max-w-[28ch] font-mono text-[9px] leading-relaxed text-ink-mut">
          Click a note in a lane to edit it. Shift-click or band a group to change several
          at once.
        </p>
      </div>
    );
  }

  /**
   * One click is ONE undo step, however many notes it touches.
   *
   * Each seam call captures for undo on its own, so a bare loop over eight
   * notes would leave eight steps to press ⌘Z through. The gesture bracket
   * records the pattern once, before the first write, and ignores the captures
   * inside it — the same mechanism a drag uses.
   */
  const applyToAll = (write: (event: PatternEvent) => void) => {
    beginEditGesture();
    for (const event of selected) write(event);
    endEditGesture();
  };

  /**
   * Rebuilt per note from that note's OWN pitch, not from the common one shown
   * above. In a selection where one note slides and another bends, asking for a
   * slide out must not wipe the bend off the second note — only the field the
   * user actually touched is replaced.
   */
  const editPitch = (edit: PitchEdit) =>
    applyToAll((event) => setNotePitch(event.id, applyPitchEdit(readNotePitch(event), edit)));

  // A tie the lib cannot merge does nothing at playback (LIB-GAP(2b)), so it is
  // offered only when EVERY selected note has somewhere to tie to — one control
  // that half-worked would be worse than one that says it can't.
  const tieTargets = selected.map((event) => tieTargetFor(events, event));
  const canTie = tieTargets.every((target) => target !== undefined);
  const lostToTie = [
    ...new Set(
      selected.flatMap((event, i) =>
        event.tieToNext ? articulationsLostToTie(tieTargets[i]) : [],
      ),
    ),
  ];

  // The other half of the same gap: a note the merge will DISCARD. Nothing set
  // on it survives, so it is worth saying before the user sets anything.
  const mergedIntoPrevious = selected.some((event) => tieLeaderOf(events, event) !== undefined);

  const pitch = commonPitch(selected);
  const dynamic = commonValue(selected, (event) => event.dynamic);
  const velocity = commonValue(selected, (event) => event.velocity);
  // NOT derivable from `dynamic` being undefined: `commonValue` cannot tell a
  // disagreement from unanimous agreement that there is no mark, and two
  // unmarked notes are agreed, not mixed.
  const dynamicsDiffer = selected.some((event) => event.dynamic !== selected[0].dynamic);

  // The neck the pattern is written on names its notes, exactly as the timeline
  // does. `patternInstrumentId` only ever returns an id the lib's catalog knows,
  // so a miss here is unreachable; a zero string count would name nothing rather
  // than name it wrongly, which is `openStrings`' own rule.
  const instrumentId = patternInstrumentId(pattern);
  const stringCount = getInstrument(instrumentId)?.stringCount ?? 0;
  const nameOf = pitchNamer(instrumentId, stringCount);
  const labels = stringLabels(instrumentId, stringCount);

  const fret = commonValue(selected, (event) => event.fret);
  const single = selected.length === 1 ? selected[0] : undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3">
      <div className="mb-2.5 flex items-center gap-2 border-b border-line pb-2">
        <span className="font-display text-[15px] text-ink-hi">
          {fret === undefined ? `${selected.length} notes` : `Fret ${fret}`}
        </span>
        <span className="font-mono text-[9px] tracking-[0.13em] text-ink-mut uppercase">
          {single
            ? [labels[single.stringIndex], nameOf(single.stringIndex, single.fret)]
                .filter(Boolean)
                .join(' · ')
            : `${selected.length} selected`}
        </span>
        <span className="flex-1" />
        {/* Relative, not absolute, and deliberately: `nudgeSelectedFret` clamps
            the shared delta against the extremes of the selection, so a chord
            nudged into the nut keeps its shape instead of flattening onto it.
            It also writes the whole selection in one step already. */}
        <button
          type="button"
          aria-label="Decrease fret"
          onClick={() => nudgeSelectedFret(-1)}
          className="pressable control rounded-md px-1.5 py-0.5 font-mono text-[10px] font-bold"
        >
          –
        </button>
        <button
          type="button"
          aria-label="Increase fret"
          onClick={() => nudgeSelectedFret(1)}
          className="pressable control rounded-md px-1.5 py-0.5 font-mono text-[10px] font-bold"
        >
          +
        </button>
      </div>

      <PitchControls pitch={pitch} onEdit={editPitch} />

      <VibratoRow
        vibrato={commonValue(selected, (event) => event.vibrato)}
        onToggle={(next) => applyToAll((event) => setArticulations(event.id, { vibrato: next }))}
      />

      <TieRow
        tied={commonValue(selected, (event) => !!event.tieToNext) ?? false}
        canTie={canTie}
        lostToTie={lostToTie}
        mergedIntoPrevious={mergedIntoPrevious}
        onToggle={(next) =>
          applyToAll((event) => setArticulations(event.id, { tieToNext: next }))
        }
      />

      <div className="mt-2.5 border-t border-line pt-2.5">
        <DynamicControls
          dynamic={dynamic}
          velocity={velocity}
          mixed={dynamicsDiffer}
          onPick={(next) => applyToAll((event) => setNoteDynamic(event.id, next))}
        />
      </div>

      <div className="mt-2.5 mb-2.5 border-t border-line pt-2.5">
        <FlagControls
          isOn={(key) => commonValue(selected, (event) => !!event[key]) ?? false}
          onToggle={(key, next) =>
            applyToAll((event) => setArticulations(event.id, { [key]: next }))
          }
        />
      </div>

      <div className="flex gap-1.5 border-t border-line pt-2.5">
        <button
          type="button"
          onClick={() => applyToAll((event) => setNotePitch(event.id, {}))}
          className="pressable control rounded-lg px-2.5 py-1.5 font-mono text-[9px] font-bold uppercase"
        >
          Clear pitch
        </button>
      </div>
    </div>
  );
}

/**
 * What a multi-selection's pitch controls show: a field only where every
 * selected note agrees on it. Field by field rather than whole-object, so a
 * selection that agrees on the slide but not the bend still shows the slide.
 */
function commonPitch(selected: readonly PatternEvent[]): PitchDisplay {
  const pitches = selected.map(readNotePitch);
  return {
    slideIn: commonValue(pitches, (p) => p.slideIn),
    slideOut: commonValue(pitches, (p) => p.slideOut),
    bend: commonValue(pitches, (p) => p.bend?.kind)
      ? {
          kind: pitches[0].bend!.kind,
          // Depth is its own question, and genuinely ABSENT when they disagree
          // — same bend, different amounts lights no depth. Substituting a
          // number here would be read straight back out by the kind buttons and
          // written to every note.
          semitones: commonValue(pitches, (p) => p.bend?.semitones),
        }
      : undefined,
  };
}
