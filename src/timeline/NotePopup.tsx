import type { DynamicMark, PatternEvent } from '@fretwork/lib';
import {
  deleteNotes,
  setArticulations,
  setNoteDynamic,
  setNoteFret,
  setNotePitch,
  DYNAMICS,
  MAX_FRET,
} from '../patterns/patternService';
import {
  articulationsLostToTie,
  readNotePitch,
  tieTargetFor,
  type NotePitch,
} from '../patterns/articulations';

/**
 * Per-note editing, in tab vocabulary.
 *
 * Articulations are independent fields in the lib, so these are toggles rather
 * than one choice — a note can be a palm-muted ghost hammer-on that bends and
 * has vibrato. The pitch controls name what a guitarist would say ("slide in
 * from below", "bend a full step"), not curve positions.
 */

/** Bend depths guitarists actually use. */
const DEPTHS = [
  { semitones: 1, label: '½' },
  { semitones: 2, label: 'full' },
  { semitones: 3, label: '1½' },
  { semitones: 4, label: '2' },
] as const;

/** What the marks are called out loud — the abbreviations alone are ambiguous
 *  to anyone who doesn't already read them. */
const DYNAMIC_NAMES: Record<DynamicMark, string> = {
  ppp: 'pianississimo — barely audible',
  pp: 'pianissimo — very soft',
  p: 'piano — soft',
  mp: 'mezzo-piano — moderately soft',
  mf: 'mezzo-forte — moderately loud',
  f: 'forte — loud',
  ff: 'fortissimo — very loud',
  fff: 'fortississimo — as loud as it goes',
};

const FLAGS = [
  { key: 'hammerOn', label: 'H-on' },
  { key: 'pullOff', label: 'P-off' },
  { key: 'palmMute', label: 'P.Mute' },
  { key: 'ghost', label: 'Ghost' },
  { key: 'dead', label: 'Dead' },
  { key: 'tap', label: 'Tap' },
] as const;

function Choice({
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

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-1.5 flex items-center gap-1.5">
      <span className="w-14 font-mono text-[9px] tracking-[0.1em] text-ink-mut uppercase">
        {label}
      </span>
      {children}
    </div>
  );
}

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
  const update = (next: NotePitch) => setNotePitch(event.id, next);

  // A tie only sounds if the lib can merge it: same string, same fret, starting
  // exactly where this note ends. Offering it otherwise would do nothing.
  const tieTarget = tieTargetFor(events, event);
  const lostToTie = event.tieToNext ? articulationsLostToTie(tieTarget) : [];

  /** Selecting the active option again turns it off. */
  const pick = <K extends keyof NotePitch>(key: K, value: NotePitch[K]) =>
    update({ ...pitch, [key]: pitch[key] === value ? undefined : value });

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

      {/* Slides read left-to-right the way they're played: into the note, then out. */}
      <Row label="Slide in">
        <Choice
          on={pitch.slideIn === 'below'}
          label="↗ below"
          title="Slide up into the note"
          onClick={() => pick('slideIn', 'below')}
        />
        <Choice
          on={pitch.slideIn === 'above'}
          label="↘ above"
          title="Slide down into the note"
          onClick={() => pick('slideIn', 'above')}
        />
      </Row>

      <Row label="Slide out">
        <Choice
          on={pitch.slideOut === 'up'}
          label="out ↗"
          title="Slide up off the end of the note"
          onClick={() => pick('slideOut', 'up')}
        />
        <Choice
          on={pitch.slideOut === 'down'}
          label="out ↘"
          title="Slide down off the end of the note"
          onClick={() => pick('slideOut', 'down')}
        />
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
              update({
                ...pitch,
                bend:
                  pitch.bend?.kind === kind
                    ? undefined
                    : { kind, semitones: pitch.bend?.semitones ?? 2 },
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
              onClick={() => update({ ...pitch, bend: { ...pitch.bend!, semitones } })}
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

      <Row label="Vibrato">
        {(['slight', 'wide'] as const).map((intensity) => (
          <Choice
            key={intensity}
            on={event.vibrato === intensity}
            label={intensity}
            title="Applies across the whole note — length isn't adjustable yet"
            onClick={() =>
              setArticulations(event.id, {
                vibrato: event.vibrato === intensity ? undefined : intensity,
              })
            }
          />
        ))}
        <span className="font-mono text-[9px] text-ink-mut">whole note</span>
      </Row>

      <Row label="Tie">
        <button
          type="button"
          aria-pressed={!!event.tieToNext}
          disabled={!tieTarget}
          title={
            tieTarget
              ? 'Ring on into the next note instead of re-picking it'
              : 'Needs a note starting exactly where this one ends, on the same string and fret'
          }
          onClick={() =>
            setArticulations(event.id, { tieToNext: event.tieToNext ? undefined : true })
          }
          className={`pressable rounded-lg px-2 py-1.5 font-mono text-[9px] font-bold uppercase disabled:cursor-not-allowed disabled:opacity-40 ${
            event.tieToNext ? 'control-accent' : 'control'
          }`}
        >
          ⌒ tie
        </button>
        {!tieTarget && (
          <span className="font-mono text-[9px] text-ink-mut">no adjacent note</span>
        )}
      </Row>

      {lostToTie.length > 0 && (
        <p className="mb-1.5 font-mono text-[9px] leading-relaxed text-ink-mut">
          The tied note's {lostToTie.join(', ')} won't sound — tied notes merge into one.
        </p>
      )}

      {/* Loudness is offered as dynamics rather than a number because that is
          how it's read and played. `dynamic` is display-only in the lib, so the
          service writes the matching `velocity` — the field playback actually
          reads — at the same time. */}
      <div className="mt-2.5 border-t border-line pt-2.5">
        <Row label="Dynamic">
          {/* A note can carry `velocity` with no mark — nothing here writes that,
              but an imported or persisted pattern can. Reporting it as unset would
              contradict both the timeline's bar and what playback does. */}
          <span className="font-mono text-[9px] text-ink-mut">
            {event.dynamic
              ? DYNAMIC_NAMES[event.dynamic]
              : event.velocity !== undefined
                ? `${Math.round(event.velocity * 100)}% — no mark`
                : 'unset — plays at full'}
          </span>
        </Row>
        <div role="group" aria-label="Dynamic" className="grid grid-cols-4 gap-1.5">
          {DYNAMICS.map((mark) => (
            <Choice
              key={mark}
              on={event.dynamic === mark}
              label={mark}
              title={DYNAMIC_NAMES[mark]}
              onClick={() => setNoteDynamic(event.id, event.dynamic === mark ? undefined : mark)}
            />
          ))}
        </div>
      </div>

      <div className="mt-2.5 mb-2.5 grid grid-cols-3 gap-1.5 border-t border-line pt-2.5">
        {FLAGS.map(({ key, label }) => (
          <Choice
            key={key}
            on={!!event[key]}
            label={label}
            onClick={() => setArticulations(event.id, { [key]: event[key] ? undefined : true })}
          />
        ))}
      </div>

      <div className="flex gap-1.5 border-t border-line pt-2.5">
        <button
          type="button"
          onClick={() => update({})}
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
