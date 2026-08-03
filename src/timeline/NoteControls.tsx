import type { DynamicMark } from '@fretwork/lib';
import { DYNAMICS } from '../patterns/patternService';
import {
  DEPTHS,
  DYNAMIC_NAMES,
  FLAGS,
  type FlagKey,
  type PitchDisplay,
  type PitchEdit,
  type Vibrato,
} from './noteModel';

/**
 * The note-editing controls themselves — the bodies both surfaces that offer
 * them render: `NotePopup` on the pattern page, and `NoteInspectorRail` in the
 * composition page's edit mode.
 *
 * CONTROL BODIES, NOT LAYOUT. Each export below is one control and its rules;
 * the containers, section rules and headers around them belong to whichever
 * surface is drawing. A control that only fitted one of the two would mean the
 * split is in the wrong place, so there is nothing here that knows which.
 *
 * VALUE IN, EDIT OUT. Nothing here writes to the store: a control is given the
 * value to display and reports what the user asked for. That is what lets the
 * rail show a multi-selection's COMMON value and fan one click out over every
 * selected note while the popup passes a single event's value straight through
 * — the toggle semantics ("picking the active option again turns it off") stay
 * here, decided once, rather than once per surface.
 *
 * The tables the controls are generated from, and the pitch-edit rules, are in
 * `./noteModel` — pure, so they are testable without a DOM, and one copy so a
 * second surface cannot quietly offer a different set.
 */

export function Choice({
  on,
  label,
  title,
  onClick,
}: {
  on: boolean;
  label: string;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={on}
      onClick={onClick}
      className={`pressable rounded-lg px-2 py-1.5 font-mono text-[9px] font-bold tracking-[0.06em] uppercase ${
        on ? 'control-accent' : 'control'
      }`}
    >
      {label}
    </button>
  );
}

export function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-1.5 flex items-center gap-1.5">
      <span className="w-14 font-mono text-[9px] tracking-[0.1em] text-ink-mut uppercase">
        {label}
      </span>
      {children}
    </div>
  );
}

/**
 * Slides and bends — the whole pitch group, because its parts are not
 * independent: the depth row only exists while a bend does, and the blend
 * warning is about the combination rather than about either control.
 *
 * Named the way a guitarist would say it ("slide in from below", "bend a full
 * step"), not by curve position — `articulations.ts` owns the translation.
 */
export function PitchControls({
  pitch,
  onEdit,
}: {
  pitch: PitchDisplay;
  onEdit: (edit: PitchEdit) => void;
}) {
  return (
    <>
      {/* Slides read left-to-right the way they're played: into the note, then out. */}
      <Row label="Slide in">
        {(
          [
            { value: 'below', label: '↗ below', title: 'Slide up into the note' },
            { value: 'above', label: '↘ above', title: 'Slide down into the note' },
          ] as const
        ).map(({ value, label, title }) => (
          <Choice
            key={value}
            on={pitch.slideIn === value}
            label={label}
            title={title}
            onClick={() =>
              onEdit({ key: 'slideIn', value: pitch.slideIn === value ? undefined : value })
            }
          />
        ))}
      </Row>

      <Row label="Slide out">
        {(
          [
            { value: 'up', label: 'out ↗', title: 'Slide up off the end of the note' },
            { value: 'down', label: 'out ↘', title: 'Slide down off the end of the note' },
          ] as const
        ).map(({ value, label, title }) => (
          <Choice
            key={value}
            on={pitch.slideOut === value}
            label={label}
            title={title}
            onClick={() =>
              onEdit({ key: 'slideOut', value: pitch.slideOut === value ? undefined : value })
            }
          />
        ))}
      </Row>

      <Row label="Bend">
        {(
          [
            { kind: 'bend', label: '⤴ bend' },
            { kind: 'bend-release', label: '⤴⤵ release' },
            { kind: 'pre-bend', label: 'pre-bend' },
          ] as const
        ).map(({ kind, label }) => (
          <Choice
            key={kind}
            on={pitch.bend?.kind === kind}
            label={label}
            onClick={() =>
              // KIND ONLY, no depth — the displayed depth may be nobody's (a
              // selection agreeing on the bend and not on how far shows none),
              // so each note keeps its own. `applyPitchEdit` resolves it.
              onEdit({
                key: 'bend',
                value: pitch.bend?.kind === kind ? undefined : { kind },
              })
            }
          />
        ))}
      </Row>

      {pitch.bend && (
        <Row label="Depth">
          {DEPTHS.map(({ semitones, label }) => (
            <Choice
              key={label}
              on={pitch.bend!.semitones === semitones}
              label={label}
              title={`${label} step bend`}
              onClick={() =>
                onEdit({ key: 'bend', value: { kind: pitch.bend!.kind, semitones } })
              }
            />
          ))}
          <span className="font-mono text-[9px] text-ink-mut">steps</span>
        </Row>
      )}

      {pitch.bend && (pitch.slideIn || pitch.slideOut) && (
        <p className="mb-1.5 font-mono text-[9px] leading-relaxed text-ink-mut">
          Bend and slide share one pitch line — they'll blend into a single move.
        </p>
      )}
    </>
  );
}

export function VibratoRow({
  vibrato,
  onToggle,
}: {
  vibrato: Vibrato | undefined;
  onToggle: (next: Vibrato | undefined) => void;
}) {
  return (
    <Row label="Vibrato">
      {(['slight', 'wide'] as const).map((intensity) => (
        <Choice
          key={intensity}
          on={vibrato === intensity}
          label={intensity}
          title="Applies across the whole note — length isn't adjustable yet"
          onClick={() => onToggle(vibrato === intensity ? undefined : intensity)}
        />
      ))}
      <span className="font-mono text-[9px] text-ink-mut">whole note</span>
    </Row>
  );
}

/**
 * The tie, and what it costs.
 *
 * LIB-GAP(2b): the lib's `mergeTies` keeps the LEADER and drops the follower
 * event outright, so anything expressive on the second note never sounds — the
 * "tie a note on to add vibrato at the end" idea looks reasonable and does
 * nothing. Two consequences, both enforced here rather than per surface:
 *
 *   - a tie the lib cannot merge (no note starting exactly where this one ends,
 *     same string, same fret) is DISABLED, not offered and ignored;
 *   - the articulations the merge will discard are named while the tie is on;
 *   - a note that is itself a FOLLOWER says so, because it is the event being
 *     discarded and nothing set on it survives.
 *
 * The one thing never disabled is turning a tie OFF. An edit elsewhere — moving
 * the follower, or nudging either fret — can leave a tie with nothing to join,
 * and a stale flag that cannot be cleared from either surface is worse than one
 * that cannot be set.
 */
export function TieRow({
  tied,
  canTie,
  lostToTie,
  mergedIntoPrevious = false,
  onToggle,
}: {
  tied: boolean;
  canTie: boolean;
  /** Articulations on the follower(s) that the merge will throw away. */
  lostToTie: readonly string[];
  /** This note is the follower of a tie the lib will merge, so it is the event
   *  that disappears. */
  mergedIntoPrevious?: boolean;
  onToggle: (next: true | undefined) => void;
}) {
  const stale = tied && !canTie;
  return (
    <>
      <Row label="Tie">
        <button
          type="button"
          aria-pressed={tied}
          disabled={!canTie && !tied}
          title={
            canTie
              ? 'Ring on into the next note instead of re-picking it'
              : stale
                ? 'This tie has nothing left to join — press to clear it'
                : 'Needs a note starting exactly where this one ends, on the same string and fret'
          }
          onClick={() => onToggle(tied ? undefined : true)}
          className={`pressable rounded-lg px-2 py-1.5 font-mono text-[9px] font-bold uppercase disabled:cursor-not-allowed disabled:opacity-40 ${
            tied ? 'control-accent' : 'control'
          }`}
        >
          ⌒ tie
        </button>
        {!canTie && (
          <span className="font-mono text-[9px] text-ink-mut">
            {stale ? 'stale tie — nothing to join' : 'no adjacent note'}
          </span>
        )}
      </Row>

      {lostToTie.length > 0 && (
        <p className="mb-1.5 font-mono text-[9px] leading-relaxed text-ink-mut">
          The tied note's {lostToTie.join(', ')} won't sound — tied notes merge into one.
        </p>
      )}

      {mergedIntoPrevious && (
        <p className="mb-1.5 font-mono text-[9px] leading-relaxed text-ink-mut">
          Tied from the note before — this one merges into it, so nothing set here will
          sound.
        </p>
      )}
    </>
  );
}

/**
 * Loudness, offered as dynamics rather than as a number because that is how it
 * is read and played. `dynamic` is display-only in the lib, so the service
 * writes the matching `velocity` — the field playback actually reads — at the
 * same time.
 */
export function DynamicControls({
  dynamic,
  velocity,
  mixed = false,
  onPick,
}: {
  dynamic: DynamicMark | undefined;
  velocity: number | undefined;
  /** The selection disagrees, so there is no one value to report. */
  mixed?: boolean;
  onPick: (next: DynamicMark | undefined) => void;
}) {
  return (
    <>
      <Row label="Dynamic">
        {/* A note can carry `velocity` with no mark — nothing here writes that,
            but an imported or persisted pattern can. Reporting it as unset would
            contradict both the timeline's bar and what playback does. */}
        <span className="font-mono text-[9px] text-ink-mut">
          {mixed
            ? 'mixed across the selection'
            : dynamic
              ? DYNAMIC_NAMES[dynamic]
              : velocity !== undefined
                ? `${Math.round(velocity * 100)}% — no mark`
                : 'unset — plays at full'}
        </span>
      </Row>
      <div role="group" aria-label="Dynamic" className="grid grid-cols-4 gap-1.5">
        {DYNAMICS.map((mark) => (
          <Choice
            key={mark}
            on={dynamic === mark}
            label={mark}
            title={DYNAMIC_NAMES[mark]}
            onClick={() => onPick(dynamic === mark ? undefined : mark)}
          />
        ))}
      </div>
    </>
  );
}

/**
 * Technique flags. Independent fields in the lib rather than one choice — a
 * note can be a palm-muted ghost hammer-on — so these are toggles, and the lib
 * keeps hammer-on and pull-off mutually exclusive for us.
 */
export function FlagControls({
  isOn,
  onToggle,
}: {
  isOn: (key: FlagKey) => boolean;
  onToggle: (key: FlagKey, next: true | undefined) => void;
}) {
  return (
    <div className="grid grid-cols-3 gap-1.5">
      {FLAGS.map(({ key, label }) => (
        <Choice
          key={key}
          on={isOn(key)}
          label={label}
          onClick={() => onToggle(key, isOn(key) ? undefined : true)}
        />
      ))}
    </div>
  );
}
