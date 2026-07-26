import type { PatternEvent } from '@fretwork/lib';
import { setArticulations, setNoteFret, setPitchSpec, deleteNotes } from '../patterns/patternService';
import { EMPTY_PITCH, readPitchSpec, type PitchSpec } from '../patterns/articulations';

/**
 * Per-note editing. Articulations are independent fields in the lib, so these
 * are toggles rather than a single choice — a note can be a palm-muted ghost
 * hammer-on with a bend and vibrato at once.
 */

/** Booleans that simply flip on the event. */
const FLAGS = [
  { key: 'hammerOn', label: 'H-on' },
  { key: 'pullOff', label: 'P-off' },
  { key: 'tieToNext', label: 'Tie' },
  { key: 'palmMute', label: 'P.Mute' },
  { key: 'ghost', label: 'Ghost' },
  { key: 'dead', label: 'Dead' },
  { key: 'tap', label: 'Tap' },
] as const;

function Toggle({
  on,
  label,
  onClick,
  title,
}: {
  on: boolean;
  label: string;
  onClick: () => void;
  title?: string;
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

function Stepper({
  label,
  value,
  suffix,
  onChange,
  step = 1,
  min = -Infinity,
  max = Infinity,
  format,
}: {
  label: string;
  value: number;
  suffix?: string;
  onChange: (next: number) => void;
  step?: number;
  min?: number;
  max?: number;
  format?: (n: number) => string;
}) {
  const clamp = (n: number) => Math.min(max, Math.max(min, Math.round(n * 100) / 100));
  return (
    <span className="flex items-center gap-1">
      <span className="font-mono text-[9px] tracking-[0.1em] text-ink-mut uppercase">{label}</span>
      <button
        type="button"
        aria-label={`Decrease ${label}`}
        onClick={() => onChange(clamp(value - step))}
        className="pressable control rounded-md px-1.5 py-0.5 font-mono text-[9px] font-bold"
      >
        –
      </button>
      <span className="min-w-8 text-center font-mono text-[11px] font-bold text-ink-hi">
        {format ? format(value) : value}
        {suffix}
      </span>
      <button
        type="button"
        aria-label={`Increase ${label}`}
        onClick={() => onChange(clamp(value + step))}
        className="pressable control rounded-md px-1.5 py-0.5 font-mono text-[9px] font-bold"
      >
        +
      </button>
    </span>
  );
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

export function NotePopup({
  event,
  pitchName,
  onClose,
}: {
  event: PatternEvent;
  pitchName: string;
  onClose: () => void;
}) {
  const pitch = readPitchSpec(event);

  const update = (next: PitchSpec) => setPitchSpec(event.id, next);

  return (
    <div
      role="dialog"
      aria-label="Note options"
      className="panel w-[320px] p-3"
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
          aria-label="Close note options"
          onClick={onClose}
          className="font-mono text-[12px] text-ink-mut hover:text-ink"
        >
          ✕
        </button>
      </div>

      <div className="mb-2.5 flex items-center gap-2">
        <Stepper
          label="Fret"
          value={event.fret}
          min={0}
          max={24}
          onChange={(n) => setNoteFret(event.id, n)}
        />
      </div>

      {/* ---- pitch movement: which side, how far, how long ---- */}
      <fieldset className="mb-2.5">
        <legend className="mb-1.5 font-mono text-[9px] tracking-[0.12em] text-ink-mut uppercase">
          Pitch movement
        </legend>

        <div className="mb-1.5 flex items-center gap-1.5">
          <Toggle
            on={!!pitch.in}
            label="Slide in"
            title="Approach the note from another pitch"
            onClick={() =>
              update({ ...pitch, in: pitch.in ? undefined : { semitones: -2, at: 0.15 } })
            }
          />
          {pitch.in && (
            <>
              <Stepper
                label="from"
                value={pitch.in.semitones}
                suffix=" st"
                min={-12}
                max={12}
                onChange={(n) => update({ ...pitch, in: { ...pitch.in!, semitones: n } })}
              />
              <Stepper
                label="len"
                value={pitch.in.at}
                step={0.05}
                min={0.05}
                max={0.9}
                format={pct}
                onChange={(n) => update({ ...pitch, in: { ...pitch.in!, at: n } })}
              />
            </>
          )}
        </div>

        <div className="mb-1.5 flex items-center gap-1.5">
          <Toggle
            on={!!pitch.out}
            label="Slide out"
            title="Leave the note toward another pitch"
            onClick={() =>
              update({ ...pitch, out: pitch.out ? undefined : { semitones: 3, at: 0.85 } })
            }
          />
          {pitch.out && (
            <>
              <Stepper
                label="to"
                value={pitch.out.semitones}
                suffix=" st"
                min={-12}
                max={12}
                onChange={(n) => update({ ...pitch, out: { ...pitch.out!, semitones: n } })}
              />
              <Stepper
                label="from"
                value={pitch.out.at}
                step={0.05}
                min={0.1}
                max={0.95}
                format={pct}
                onChange={(n) => update({ ...pitch, out: { ...pitch.out!, at: n } })}
              />
            </>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <Toggle
            on={!!pitch.bend}
            label="Bend"
            onClick={() =>
              update({
                ...pitch,
                bend: pitch.bend ? undefined : { semitones: 2, start: 0.1, end: 0.5 },
              })
            }
          />
          {pitch.bend && (
            <>
              <Stepper
                label="depth"
                value={pitch.bend.semitones}
                suffix=" st"
                step={0.5}
                min={-12}
                max={12}
                onChange={(n) => update({ ...pitch, bend: { ...pitch.bend!, semitones: n } })}
              />
              <Stepper
                label="start"
                value={pitch.bend.start}
                step={0.05}
                min={0}
                max={0.9}
                format={pct}
                onChange={(n) => update({ ...pitch, bend: { ...pitch.bend!, start: n } })}
              />
              <Stepper
                label="end"
                value={pitch.bend.end}
                step={0.05}
                min={0.05}
                max={1}
                format={pct}
                onChange={(n) => update({ ...pitch, bend: { ...pitch.bend!, end: n } })}
              />
              <Toggle
                on={!!pitch.bend.release}
                label="Release"
                title="Return to pitch before the note ends"
                onClick={() =>
                  update({
                    ...pitch,
                    bend: { ...pitch.bend!, release: !pitch.bend!.release },
                  })
                }
              />
            </>
          )}
        </div>
        {(pitch.in || pitch.out || pitch.bend) && (
          <p className="mt-1.5 font-mono text-[9px] text-ink-mut">
            {hasCurveConflict(pitch)
              ? 'Bend and slide share one pitch line — they blend into a single curve.'
              : ' '}
          </p>
        )}
      </fieldset>

      {/* ---- vibrato: whole-note only, see docs/FOLLOW-UPS.md ---- */}
      <fieldset className="mb-2.5">
        <legend className="mb-1.5 font-mono text-[9px] tracking-[0.12em] text-ink-mut uppercase">
          Vibrato
        </legend>
        <div className="flex items-center gap-1.5">
          {(['slight', 'wide'] as const).map((intensity) => (
            <Toggle
              key={intensity}
              on={event.vibrato === intensity}
              label={intensity}
              title="Applies across the whole note — position and length aren't adjustable yet"
              onClick={() =>
                setArticulations(event.id, {
                  vibrato: event.vibrato === intensity ? undefined : intensity,
                })
              }
            />
          ))}
          <span className="font-mono text-[9px] text-ink-mut">whole note</span>
        </div>
      </fieldset>

      <fieldset className="mb-2.5">
        <legend className="mb-1.5 font-mono text-[9px] tracking-[0.12em] text-ink-mut uppercase">
          Technique
        </legend>
        <div className="grid grid-cols-4 gap-1.5">
          {FLAGS.map(({ key, label }) => (
            <Toggle
              key={key}
              on={!!event[key]}
              label={label}
              onClick={() => setArticulations(event.id, { [key]: event[key] ? undefined : true })}
            />
          ))}
        </div>
      </fieldset>

      <div className="flex gap-1.5 border-t border-line pt-2.5">
        <button
          type="button"
          onClick={() => update(EMPTY_PITCH)}
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

/** Bend and slide are drawn on one pitch line, so they combine rather than layer. */
function hasCurveConflict(pitch: PitchSpec): boolean {
  return !!pitch.bend && (!!pitch.in || !!pitch.out);
}
