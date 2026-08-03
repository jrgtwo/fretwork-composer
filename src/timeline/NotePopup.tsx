import type { PatternEvent } from '@fretwork/lib';
import {
  deleteNotes,
  setArticulations,
  setNoteDynamic,
  setNoteFret,
  setNotePitch,
  MAX_FRET,
} from '../patterns/patternService';
import {
  articulationsLostToTie,
  readNotePitch,
  tieLeaderOf,
  tieTargetFor,
} from '../patterns/articulations';
import {
  DynamicControls,
  FlagControls,
  PitchControls,
  TieRow,
  VibratoRow,
} from './NoteControls';
import { applyPitchEdit } from './noteModel';

/**
 * Per-note editing, in tab vocabulary — anchored to the note on the PATTERN
 * PAGE.
 *
 * The controls themselves live in `./NoteControls` and are shared verbatim with
 * `src/composition/NoteInspectorRail.tsx`, which offers the same set in the
 * composition page's right rail (CP-12). What is local to this file is the
 * popup's own frame: the header with the fret stepper, the close button and the
 * footer — the parts that only make sense for ONE note anchored to ONE box.
 *
 * An arrangement lane suppresses this popup entirely (`showNoteOptions`): it
 * would be anchored to a note inside a clipped, scrolling lane stack, and the
 * rail is already showing the same controls for the same selection.
 */
export function NotePopup({
  event,
  events,
  pitchName,
  onClose,
}: {
  event: PatternEvent;
  /** The pattern's other notes — needed to know whether a tie has anywhere to go. */
  events: readonly PatternEvent[];
  pitchName: string;
  onClose: () => void;
}) {
  const pitch = readNotePitch(event);

  // A tie only sounds if the lib can merge it: same string, same fret, starting
  // exactly where this note ends. Offering it otherwise would do nothing.
  const tieTarget = tieTargetFor(events, event);
  const lostToTie = event.tieToNext ? articulationsLostToTie(tieTarget) : [];
  // …and this note may be the one being swallowed, in which case nothing set
  // below it sounds at all.
  const mergedIntoPrevious = tieLeaderOf(events, event) !== undefined;

  return (
    <div
      role="dialog"
      aria-label="Note options"
      className="panel w-[300px] p-3"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="mb-2.5 flex items-center gap-2 border-b border-line pb-2">
        <span className="font-display text-[15px] text-ink-hi">Fret {event.fret}</span>
        <span className="font-mono text-[9px] tracking-[0.13em] text-ink-mut uppercase">
          {pitchName}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          aria-label="Decrease fret"
          onClick={() => setNoteFret(event.id, Math.max(0, event.fret - 1))}
          className="pressable control rounded-md px-1.5 py-0.5 font-mono text-[10px] font-bold"
        >
          –
        </button>
        <button
          type="button"
          aria-label="Increase fret"
          onClick={() => setNoteFret(event.id, Math.min(MAX_FRET, event.fret + 1))}
          className="pressable control rounded-md px-1.5 py-0.5 font-mono text-[10px] font-bold"
        >
          +
        </button>
        <button
          type="button"
          aria-label="Close note options"
          onClick={onClose}
          className="ml-1 font-mono text-[12px] text-ink-mut hover:text-ink"
        >
          ✕
        </button>
      </div>

      <PitchControls
        pitch={pitch}
        onEdit={(edit) => setNotePitch(event.id, applyPitchEdit(pitch, edit))}
      />

      <VibratoRow
        vibrato={event.vibrato}
        onToggle={(next) => setArticulations(event.id, { vibrato: next })}
      />

      <TieRow
        tied={!!event.tieToNext}
        canTie={!!tieTarget}
        lostToTie={lostToTie}
        mergedIntoPrevious={mergedIntoPrevious}
        onToggle={(next) => setArticulations(event.id, { tieToNext: next })}
      />

      <div className="mt-2.5 border-t border-line pt-2.5">
        <DynamicControls
          dynamic={event.dynamic}
          velocity={event.velocity}
          onPick={(next) => setNoteDynamic(event.id, next)}
        />
      </div>

      <div className="mt-2.5 mb-2.5 border-t border-line pt-2.5">
        <FlagControls
          isOn={(key) => !!event[key]}
          onToggle={(key, next) => setArticulations(event.id, { [key]: next })}
        />
      </div>

      <div className="flex gap-1.5 border-t border-line pt-2.5">
        <button
          type="button"
          onClick={() => setNotePitch(event.id, {})}
          className="pressable control rounded-lg px-2.5 py-1.5 font-mono text-[9px] font-bold uppercase"
        >
          Clear pitch
        </button>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => {
            deleteNotes([event.id]);
            onClose();
          }}
          className="pressable control rounded-lg px-2.5 py-1.5 font-mono text-[9px] font-bold uppercase"
        >
          Delete
        </button>
      </div>
    </div>
  );
}
