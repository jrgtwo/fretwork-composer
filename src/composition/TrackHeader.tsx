import { useRef, useState } from 'react';
import type { Track } from '@fretwork/lib';
import type { ArrangementMode } from './arrangementMath';
import {
  JOB_LOCK_REASON,
  mismatchedPlacements,
  setTrackName,
  strandedByInstrument,
  trackInstrumentId,
} from './compositionService';
import { TrackControls } from './TrackControls';

/**
 * The three views a track can show, as the header offers them.
 *
 * ⚠ THE LETTER IS NOT THE NAME. `P` is what fits beside a track name in a 200 px
 * column; the ACCESSIBLE NAME is built from `label` and the track's own name, so
 * eight tracks do not give a screen reader twenty-four controls called "P", "E"
 * and "V" with nothing to tell them apart. The `title` says what the view holds,
 * because a single letter teaches nothing on hover either.
 */
const VIEWS: readonly {
  id: ArrangementMode;
  letter: string;
  label: string;
  hint: string;
}[] = [
  { id: 'pattern', letter: 'P', label: 'Pattern view', hint: 'Pattern — the blocks on this track' },
  { id: 'edit', letter: 'E', label: 'Edit view', hint: 'Edit — the notes inside this track’s blocks' },
  { id: 'voice', letter: 'V', label: 'Voice view', hint: 'Voice — this track’s instrument and amp' },
];

/**
 * One track's header, in the fixed column left of the lanes.
 *
 * Exactly as tall as its lane — the height comes from the same `laneRects` entry
 * the lane is drawn from, rather than from a constant repeated here, because the
 * two are only "obviously the same" while every lane is the same height, and an
 * Edit lane's depends on the track's string count (CP-11).
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
  view,
  onViewChange,
  locked = false,
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
  /** What THIS track's lane is drawing. One of three, per track — there is no
   *  page mode any more (COMPS-TRACK-TABS milestone 4). */
  view?: ArrangementMode;
  /** Sets this track's view AND selects it, even when the view picked is the one
   *  already showing (§2). The host routes it through the activation
   *  coordinator; this component only says which button was pressed. */
  onViewChange?: (view: ArrangementMode) => void;
  /** A generation job owns the document, so nothing here may repoint it. Only
   *  the view buttons are disabled: they are the control whose press can CLOSE
   *  an open block, and the agent may be inside one. */
  locked?: boolean;
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
   * still have strings) and shows only when nothing is stranded. The header's
   * FLOOR is `TRACK_HEADER_HEIGHT`'s three control rows, so a second optional
   * line would push the mixer strip out of the shortest lane — and jsdom has no
   * layout, so no test here could catch that.
   */
  const stranded = strandedByInstrument(track, trackInstrumentId(track));
  const mismatched = mismatchedPlacements(track);
  /** Defaulted so a host that knows nothing about views — the pattern page has
   *  none, and neither did this column before milestone 4 — still renders a
   *  header whose buttons agree with what a lane with no entry draws. */
  const viewShown: ArrangementMode = view ?? 'pattern';

  return (
    <div
      data-track-header={track.id}
      style={{ height }}
      /**
       * ── WHERE IN THE STACK THIS TRACK IS (COMPS-TRACK-TABS milestone 6) ─────
       *
       * A NAMED GROUP AROUND THE WHOLE COLUMN, and the name carries the track's
       * POSITION. Two things wanted it:
       *
       *  1. The seam does not enforce unique track names, so `Select track Bass`
       *     and `Rename track Bass` collide outright on two tracks both called
       *     Bass. A group entered by name disambiguates them by context without
       *     renaming a single control — which matters, because the racks in the
       *     voice layer, the rail and four test suites all address those
       *     controls by the names they have.
       *  2. A mixed stack's tab order is not its visual order: every rack in the
       *     voice layer comes after this whole column, whatever position its
       *     track sits at. "Track 2 of 3" is what makes landing in the middle of
       *     that run legible — the voice rows say the same thing in the same
       *     shape (`ArrangementGrid`'s voice layer).
       *
       * Position is 1-BASED and spoken, not the array index: this is read out,
       * not indexed into.
       */
      role="group"
      aria-label={`Track ${index + 1} of ${trackCount}: ${track.name}`}
      /**
       * ⚠ TOUCHING ANYTHING IN THIS HEADER SELECTS ITS TRACK (§2) — by pointer
       * and by keyboard focus alike. Tabbing into this track's fader, its
       * instrument picker or its view buttons makes it the selected one, and so
       * does pressing one; without it a user can change a control on track 3
       * while the rail, the note keyboard and every direct-editing command are
       * still pointed at track 1.
       *
       * BOTH HALVES, and that is not belt-and-braces. Clicking a `<button>`
       * focuses it on Chrome and does NOT on Safari or Firefox, so focus alone
       * would be a selection model that differs per browser — mute selects the
       * track on one and not on another. Pointer-down capture is the uniform
       * path; focus capture is the KEYBOARD one, and the guard below makes the
       * second of the two a no-op wherever both fire.
       *
       * CAPTURE for the same reason on both: `focus` does not bubble (the React
       * prop is `focusin` underneath, which does), and a press deep inside a
       * control must reach this before that control's own handler runs.
       *
       * Guarded on both sides. Already selected: nothing to do, and calling the
       * coordinator on every focus move WITHIN the header would sweep the note
       * surfaces' teardowns for no reason. Locked: a job owns the document, and
       * a mere focus must not spend the track strip's one alert line on a
       * refusal the user did not ask for — the view buttons still refuse out loud.
       *
       * ⚠ THE COST, stated because it is a real behaviour change and not an
       * accident: a MIXER press on track 5 while track 1 has a block open closes
       * that block, and the block's note undo history goes with it (its EDITS
       * survive — the documented reset). Selecting a track is what closes another
       * track's editor, and reaching for a fader is reaching for that track.
       *
       * §2's "programmatic focus after an action must not reactivate a stale
       * track" is satisfied by WHAT is activated rather than by a guard: the
       * track is this header's own, drawn from the live stack, and the
       * coordinator re-validates the id against `getTracks()` anyway.
       */
      onPointerDownCapture={() => {
        if (selected || locked) return;
        onSelect();
      }}
      onFocusCapture={() => {
        if (selected || locked) return;
        onSelect();
      }}
      // Tight on purpose: a name/view row, three control rows and a status line
      // have to fit `TRACK_HEADER_HEIGHT` (arrangementMath), which is the FLOOR
      // under every lane — so what this needs is exactly what a pattern or a
      // folded-voice lane comes out at.
      //
      // ⚠ TOP-ALIGNED, not `justify-between`. `height` is the LANE's, not that
      // constant, and since COMPS-TRACK-TABS milestone 2's correction it can be
      // far taller — an open rack's lane is several hundred pixels, and
      // `justify-between` threw the name plate, the status line and the mixer
      // strip into three corners of it. The rows stack from the top and the
      // slack falls at the bottom, so a header reads the same beside a 143 px
      // pattern lane and a 900 px voice one.
      //
      // ⚠ AND IT ALL FITS THE 143 px FLOOR — checked in the BROWSER at milestone
      // 4's pass: every control present, nothing clipped, no resting scrollbar.
      // That is the standing measurement this column is designed against, and it
      // is the reason milestone 6's header work is sizing rather than culling:
      // the only thing left to spend was the slack inside the name row, which is
      // where the enlarged view buttons came from. That slack is bounded by the
      // name plate's own height (~26 px — the arithmetic is beside the view
      // buttons), and the buttons now sit just under it, so there is no more of
      // it to spend without a second row.
      //
      // jsdom has no layout, so nothing here can TEST that any of it fits; it is
      // checked in the browser, and the rows are sized so the mismatch line is
      // the only optional one.
      className="flex flex-col gap-0.5 overflow-hidden border-b border-rim-dark px-1.5 py-1"
    >
      {/* `flex-none`: the name and the view buttons are the one row that must
          never be squeezed, because they are how the track is identified and how
          its view is changed. Everything below them takes the remaining height
          and scrolls if it has to. */}
      <div className="flex flex-none items-center gap-1">
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
            // Height matched to the view buttons and the plate so the row reads
            // as one strip; width deliberately NOT — this is the row's secondary
            // gesture and every px it takes comes out of the track name. The
            // 24 px ceiling is the view buttons' (see there for the arithmetic).
            className="pressable control flex h-6 items-center justify-center rounded-md px-1 font-mono text-[9px] font-bold leading-none"
          >
            ✎
          </button>
        )}

        {/* ── THIS TRACK'S VIEW ────────────────────────────────────────────────
            A LABELLED GROUP OF MUTUALLY EXCLUSIVE `aria-pressed` BUTTONS, which
            is one of the two shapes §6 allows. The other is real tab semantics,
            and it is the wrong one here: a `tablist` promises arrow-key movement
            between the tabs of ONE panel, and these are eight independent
            three-way switches down a column whose arrow keys already belong to
            the arrangement. `aria-pressed` says exactly what this is — a toggle
            per view, one of which is on.

            NOT VISUAL TABS. The letters are the only thing compact enough for a
            200 px column; the accessible name and the tooltip carry the meaning
            (see `VIEWS`).

            The group is named with the TRACK, because eight of these are on
            screen and "View" alone would be eight identical groups. It does not
            close the case of two tracks NAMED THE SAME — the seam does not
            enforce unique names, and `Select track X` and `Rename track X`
            collide the same way. That is answered one level OUT rather than
            here: the header's own `role="group"` carries the stack position, so
            every control in the column is disambiguated by the group it is
            entered through and not one of them had to be renamed. */}
        <div
          className="flex flex-none gap-px"
          role="group"
          aria-label={`View for ${track.name}`}
        >
          {VIEWS.map((option) => (
            <button
              key={option.id}
              type="button"
              // ⚠ AND while a generation job holds the composition: pressing one
              // of these can CLOSE an open placement, and the agent may be
              // inside one — a close would repoint the lib's one pattern pointer
              // out from under it and land the job's next notes in the user's
              // library pattern, which a cancel does not restore. The host's
              // coordinator refuses the callback too (§4 asks for both); this is
              // what makes the refusal legible before the press.
              disabled={locked}
              title={locked ? JOB_LOCK_REASON : option.hint}
              aria-label={`${option.label}, ${track.name}`}
              aria-pressed={viewShown === option.id}
              // Unconditional: §2 is explicit that a view press selects its
              // track EVEN IF that view is already active, which is the whole
              // reason this is not `disabled` when pressed.
              onClick={() => onViewChange?.(option.id)}
              // ⚠ A FIXED 24 px SQUARE, and the number is load-bearing in both
              // directions. It is the user's milestone 4 note ("the p/e/v are
              // too small") answered where the answer is free, and FREE HAS AN
              // ARITHMETIC — get it wrong and you either grow the header or
              // leave hit-area unspent. The row is `items-center`, so its height
              // is whatever the tallest item in it needs, and that is the name
              // plate:
              //
              //   line box   10.5 × 1.55  = 16.275  (`text-[10.5px]` sets only
              //                                      font-size; NOTHING on the
              //                                      span or above it declares a
              //                                      `leading-*`, so it inherits
              //                                      `body { line-height: 1.55 }`
              //                                      from `styles/index.css`)
              //   `py-1`                  =  8
              //   `.control` border       =  2      (1 px each side)
              //   plate                   = 26.275 px
              //
              // So anything up to ~26 px is free, and 24 px is the largest whole
              // step of the scale under it. Go past the plate and the header
              // grows, and `TRACK_HEADER_HEIGHT` is the FLOOR under every lane in
              // the stack: a header that needs 150 px makes every pattern lane
              // 150 px. The letter goes to 12 px with it, which is the legibility
              // half — a centred glyph rather than a padded one, so the box is
              // the hit area and the type size is free to change inside it.
              //
              // THE COST, which is width and not height. The old button was
              // `px-1 py-0.5 text-[8.5px]` with a 1 px `.control` border: 8 px of
              // padding + 2 px of border + one ~5.1 px monospace advance ≈ 15 px,
              // so the group was 3 × 15 + 2 px of `gap-px` ≈ 47 px. It is now
              // 3 × 24 + 2 = 74 px, so ~27 px of the 200 px column has moved
              // from the name plate to this group since milestone 4. The rename
              // button beside it is unchanged in width (same `px-1`, 8.5 → 9 px
              // glyph), so the plate lands near 200 − 12 (`px-1.5`) − 8 (two
              // `gap-1`) − 74 − 15 ≈ 90 px, about eleven monospace characters
              // inside its own `px-2`. jsdom has no layout, so whether that
              // truncation is acceptable is a BROWSER observation (checklist
              // item 9), not something asserted here.
              className={`pressable flex h-6 w-6 items-center justify-center rounded-md font-mono text-[12px] font-bold leading-none disabled:opacity-40 ${
                viewShown === option.id ? 'control-accent' : 'control'
              }`}
            >
              {option.letter}
            </button>
          ))}
        </div>
      </div>

      {/* THE LOWER CONTROLS, in a bounded scroll area.
          `flex-1` takes whatever the lane leaves after the name row, and
          `overflow-y-auto` is what §6 asks for on a SHORT lane: the floor is
          143 px, the name row and the mixer strip are sized to it, and a
          four-string edit lane sits exactly on it — but the status line is
          optional and a narrow window can wrap a row, and the alternative to
          scrolling is a fader clipped away with no way to reach it. Preserves
          every control; hides none of them. `min-h-0` because a flex item's
          default `min-height: auto` refuses to shrink below its content, which
          is what turns an overflow into an overflowing COLUMN instead of a
          scroller. Nothing in jsdom can see any of this (every box is 0×0).

          ⚠ IT IS ALSO A WHEEL TARGET. The header column scrolls in sync with the
          lane stack, so a wheel over a header that actually overflows scrolls
          this box first and chains to the stack only once it bottoms out, and a
          resting scrollbar eats ~15 px of a 200 px column. Both are the SYMPTOM
          of the header not fitting, and NEITHER WAS OBSERVED at milestone 4's
          browser pass: nothing rests at the 143 px floor, so the scroller is the
          safety net it was meant to be rather than the standing state. It stays
          for the cases layout still cannot promise — a wrapped row in a narrow
          window, the optional status line — and `scrollbar-gutter` is still the
          wrong cure, because it would spend that 15 px in every header to hide a
          bar that does not appear. Milestone 6 spent the name row's slack on the
          view buttons and nothing else, precisely so this stays true. */}
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
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
    </div>
  );
}
