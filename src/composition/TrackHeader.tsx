import { useRef, useState } from 'react';
import type { Track } from '@fretwork/lib';
import {
  mismatchedPlacements,
  setTrackName,
  strandedByInstrument,
  trackInstrumentId,
} from './compositionService';
import { TrackControls } from './TrackControls';

/**
 * One track's header, in the fixed column left of the lanes.
 *
 * Exactly as tall as its lane — the height comes from the same `laneRects` entry
 * the lane is drawn from, rather than from a constant repeated here, because the
 * two are only "obviously the same" until edit mode makes lane height depend on
 * the track's string count (CP-11).
 *
 * This component is the track's IDENTITY: its name, whether it is the focused
 * track, and whether it is going to be heard. Everything that writes to the mix
 * or to the stack is `TrackControls`.
 *
 * ── Two things worth knowing ─────────────────────────────────────────────────
 *
 * 1. The name plate is a BUTTON that selects, and rename is a separate control
 *    that swaps it for an input. An always-editable input (guitar-tutor's
 *    version) writes to the store on every keystroke, which is both a store
 *    write per character and a name plate that can pass through empty. Here the
 *    draft is local and reaches the seam once, on Enter or blur.
 *
 * 2. The plate reports AUDIBILITY, not the button states that produced it. Mute
 *    and solo interact — mute wins, and any solo anywhere silences the un-soloed
 *    — so "M is up and S is up on that other track" is a puzzle the user should
 *    not have to solve while mixing. `isTrackAudible` answers it once; this just
 *    says the answer.
 */
export function TrackHeader({
  track,
  index,
  trackCount,
  height,
  selected,
  audible,
  onSelect,
  onNotice,
}: {
  track: Track;
  index: number;
  trackCount: number;
  height: number;
  selected: boolean;
  /** From `isTrackAudible` — the ENGINE's verdict on this track, not this
   *  track's own flags. Passed in rather than computed here because it depends
   *  on every OTHER track's solo state, which a single header does not have. */
  audible: boolean;
  onSelect: () => void;
  onNotice: (message: string) => void;
}) {
  const [draftName, setDraftName] = useState<string | null>(null);
  /**
   * Set by Escape, read by the commit that Escape's own unmount can trigger.
   *
   * Escape clears `draftName`, which removes the focused input — and a browser
   * fires `blur`/`focusout` on a focused node being removed, running the
   * PREVIOUS render's `commitName` closure, whose `draftName` is still the
   * abandoned draft. That is an Escape that renames. jsdom fires no blur on
   * removal, so no test in this suite can see it; the guard is checked in the
   * browser and this comment is why it looks unnecessary here.
   */
  const cancelledRef = useRef(false);

  const commitName = () => {
    if (cancelledRef.current) {
      cancelledRef.current = false;
      return;
    }
    if (draftName === null) return;
    const name = draftName.trim();
    setDraftName(null);
    // An empty name is a plate with nothing on it and a lane with no label. The
    // SEAM refuses it (the agent must not be able to blank a track's name); the
    // field drops it instead of showing that refusal, because the user's intent
    // when they clear a box and tab away is not "call it nothing".
    if (name === '' || name === track.name) return;
    const result = setTrackName(track.id, name);
    if (!result.ok) onNotice(result.reason);
  };

  /**
   * The track's one standing status line, and why it is one line rather than two.
   *
   * STRANDED is the durable defect and wins the slot: those notes sit on strings
   * this instrument has not got, and nothing but re-recording them or changing
   * the instrument back will fix it. It is also not only reachable through the
   * picker's confirmation — dropping a six-string pattern onto a bass track
   * strands two strings and asks nothing (CP-05/06's path) — so a one-time
   * question could never have covered it.
   *
   * MISMATCHED is the milder one (the block was authored elsewhere; the notes
   * still have strings) and shows only when nothing is stranded. The header has
   * 88 px for three control rows, so a second optional line would push the mixer
   * strip out of its own lane — and jsdom has no layout, so no test here could
   * catch that.
   */
  const stranded = strandedByInstrument(track, trackInstrumentId(track));
  const mismatched = mismatchedPlacements(track);

  return (
    <div
      data-track-header={track.id}
      style={{ height }}
      // Tight on purpose: three control rows and a status line have to fit the
      // lane's 88 px without the header driving lane height (`DEFAULT_LANE_HEIGHTS`
      // in arrangementMath is the single source of that number, and CP-11 will
      // vary it per track). jsdom has no layout, so nothing here can TEST that
      // it fits — it is checked in the browser, and the rows are sized so the
      // mismatch line is the only optional one.
      className="flex flex-col justify-between gap-0.5 overflow-hidden border-b border-rim-dark px-1.5 py-1"
    >
      <div className="flex items-center gap-1">
        {draftName === null ? (
          /* The whole name plate selects, so the target is the header rather
             than a checkbox-sized thing inside it. `aria-pressed` because this
             is a toggle in the "which track is focused" sense, not navigation. */
          <button
            type="button"
            // Named rather than left to its contents: the plate carries a name
            // and a status mark, which a screen reader would otherwise run
            // together into a word that is neither.
            aria-label={`Select track ${track.name}`}
            aria-pressed={selected}
            onClick={onSelect}
            className={`pressable flex min-w-0 flex-1 items-center gap-1 rounded-lg px-2 py-1 text-left ${
              selected ? 'control-accent' : 'control'
            }`}
          >
            <span
              className={`max-w-full truncate font-mono text-[10.5px] font-bold ${
                audible ? '' : 'opacity-45'
              }`}
            >
              {track.name}
            </span>
            {/* Stated in words for anything that isn't looking at it: a silent
                track is the single most confusing state a mixer can be in, and
                dimmed text is not a message. */}
            {!audible && (
              <span className="ml-auto font-mono text-[7.5px] tracking-[0.12em] uppercase opacity-70">
                silent
              </span>
            )}
          </button>
        ) : (
          <input
            aria-label={`Rename ${track.name}`}
            value={draftName}
            autoFocus
            onChange={(e) => setDraftName(e.currentTarget.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitName();
              // Escape abandons the draft. The flag is set BEFORE the state
              // update, because clearing the draft unmounts this input and the
              // blur that follows would otherwise commit it — see `cancelledRef`.
              //
              // `stopPropagation` is belt and braces only: the window shortcut
              // handler already bails inside an `input`, and the drag-abort
              // listener is registered in the capture phase, so it has run
              // before this one either way.
              if (e.key === 'Escape') {
                e.stopPropagation();
                cancelledRef.current = true;
                setDraftName(null);
              }
            }}
            className="well min-w-0 flex-1 rounded-lg px-2 py-1 font-mono text-[10.5px] font-bold text-ink"
          />
        )}
        {/* Gone while editing, not merely inert: pressing it mid-edit would
            blur-commit the draft and then reopen the field on the name it had
            before that commit, which is a rename that silently undoes itself. */}
        {draftName === null && (
          <button
            type="button"
            aria-label={`Rename track ${track.name}`}
            title="Rename"
            onClick={() => setDraftName(track.name)}
            className="pressable control rounded-md px-1 py-0.5 font-mono text-[8.5px] font-bold leading-none"
          >
            ✎
          </button>
        )}
      </div>

      {/* A standing fact rather than an event, and never a claim about what will
          be heard (LIB-GAP(15)): a track's instrument selects its voice, not its
          tuning, so what this can honestly report is the STRINGS. Not an error —
          CP-07 decided the change is allowed — so it states the count and stays
          out of the way. */}
      {stranded > 0 ? (
        <span
          title={`${stranded} ${stranded === 1 ? 'note sits' : 'notes sit'} on strings this track's instrument hasn't got`}
          className="font-mono text-[7.5px] tracking-[0.12em] text-ink-mut uppercase"
        >
          ⚠ {stranded} off-instrument
        </span>
      ) : (
        mismatched > 0 && (
          <span
            title={`${mismatched} ${mismatched === 1 ? 'block was' : 'blocks were'} written for another instrument`}
            className="font-mono text-[7.5px] tracking-[0.12em] text-ink-mut uppercase"
          >
            ≠ {mismatched} mismatched
          </span>
        )
      )}

      <TrackControls
        track={track}
        index={index}
        trackCount={trackCount}
        onNotice={onNotice}
      />
    </div>
  );
}
