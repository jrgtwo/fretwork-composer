import type { Track } from '@fretwork/lib';
import { trackInstrumentId } from './compositionService';

/**
 * One track's header, in the fixed column left of the lanes.
 *
 * Exactly as tall as its lane — the height comes from the same `laneRects` entry
 * the lane is drawn from, rather than from a constant repeated here, because the
 * two are only "obviously the same" until edit mode makes lane height depend on
 * the track's string count (CP-11).
 *
 * Selection is the only wired control. Mute, solo and volume are drawn as
 * placeholders and left inert on purpose: CP-07 owns them, and a control that
 * looks live and does nothing is worse than one that plainly isn't.
 */
export function TrackHeader({
  track,
  height,
  selected,
  onSelect,
}: {
  track: Track;
  height: number;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <div
      data-track-header={track.id}
      style={{ height }}
      className="flex flex-col justify-between gap-1 overflow-hidden border-b border-rim-dark px-1.5 py-1.5"
    >
      {/* The whole name plate selects, so the target is the header rather than a
          checkbox-sized thing inside it. `aria-pressed` because this is a toggle
          in the "which track is focused" sense, not navigation. */}
      <button
        type="button"
        // Named rather than left to its contents: the plate reads "Rhythm" over
        // "guitar", which a screen reader would run together into one word that
        // is neither the track's name nor its instrument.
        aria-label={`Select track ${track.name}`}
        aria-pressed={selected}
        onClick={onSelect}
        className={`pressable flex min-w-0 flex-col items-start gap-0.5 rounded-lg px-2 py-1 text-left ${
          selected ? 'control-accent' : 'control'
        }`}
      >
        <span className="max-w-full truncate font-mono text-[10.5px] font-bold">
          {track.name}
        </span>
        <span
          className={`max-w-full truncate font-mono text-[8.5px] tracking-[0.12em] uppercase ${
            selected ? 'opacity-70' : 'text-ink-mut'
          }`}
        >
          {/* Resolved through the seam: `Track.instrumentId` is a free-form
              string and an unknown one must read as the instrument it will
              actually play as. */}
          {trackInstrumentId(track)}
        </span>
      </button>

      <div className="flex items-center gap-1">
        {/* TODO(CP-07): mute, solo and the fader. Disabled rather than absent so
            the header's real size is settled now, not the first time CP-07
            renders and every lane below shifts. */}
        {(['M', 'S'] as const).map((label) => (
          <button
            key={label}
            type="button"
            disabled
            aria-label={label === 'M' ? `Mute ${track.name}` : `Solo ${track.name}`}
            title="Mixing arrives with track management"
            className="control pressable rounded-md px-1.5 py-0.5 font-mono text-[8.5px] font-bold opacity-40"
          >
            {label}
          </button>
        ))}
        <span aria-hidden className="well ml-1 h-1.5 flex-1 rounded-full" />
      </div>
    </div>
  );
}
