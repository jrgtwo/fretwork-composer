/**
 * The fretboard reference view: the current pattern's shape on the neck, lighting
 * up as it plays. Read-only — no click-to-stamp, no click-to-audition (yet).
 *
 * The board itself is the lib's `<Fretboard>`, unmodified. Everything below is the
 * three things it can't know: which cells the pattern occupies, which are sounding
 * right now, and whether the neck it is about to draw is the pattern's at all.
 */
import { useId, useMemo } from 'react';
import {
  DEFAULT_INSTRUMENT_ID,
  Fretboard,
  getInstrument,
  useFretworkStore,
  type Highlight,
} from '@fretwork/lib';
import { useActiveEventIds } from '../audio/playbackService';
import { patternInstrumentId, useEditingPattern } from '../patterns/patternService';
import { activeCellsFor, cellsAboveFret, footprintCellsFor } from './patternCells';

/**
 * LIB-GAP(7): with no `highlights` prop, the board falls back to `useFretworkStore`'s
 * scale — key A / major by default — and draws it in full degree colour. That's a
 * theory claim the pattern never made, on a global this app never sets. An explicit
 * empty set is what keeps the neck bare behind the pattern's own footprint.
 * Delete when `<Fretboard>` treats "no highlights" as "none".
 */
const NO_HIGHLIGHTS: readonly Highlight[] = [];

export function FretboardView() {
  const pattern = useEditingPattern();
  const activeIds = useActiveEventIds();
  const captionId = useId();

  // The neck the lib is about to draw comes from *its* global store, which this app
  // never writes (it initialises from `window.location.search`). We can't inject it
  // — `useFretboardModel` reads it directly — so the most we can do is read the same
  // value and refuse to draw when it disagrees with the pattern about string count.
  //
  // The house rule that store reads live in a service is about `usePatternsStore`,
  // whose shape the whole app depends on. This is the private UI state of the one lib
  // component rendered here, read by its only consumer: routing it through a service
  // would put a hook nothing else can call in a file about something else. If a second
  // consumer ever appears, that is when it earns a `boardInstrument()` reader.
  //
  // Both `getInstrument` calls are typed nullable but the default id always resolves,
  // so the `undefined` branches below are type guards, not real states.
  const boardInstrumentId = useFretworkStore((s) => s.instrumentId);
  const board = getInstrument(boardInstrumentId) ?? getInstrument(DEFAULT_INSTRUMENT_ID);
  const fretCount = board?.fretCount ?? 0;

  const patternInstrument = pattern ? getInstrument(patternInstrumentId(pattern)) : undefined;

  const footprintCells = useMemo(() => footprintCellsFor(pattern, fretCount), [pattern, fretCount]);
  // Always an array, never undefined — that is what keeps the lib's legacy single-cell
  // playhead (`usePlaybackStore.currentPlayheadCell`, driven by Practice's walk) from
  // taking over the activity layer. Empty on stop, so the board goes dark by itself.
  const activeCells = useMemo(
    () => activeCellsFor(pattern, activeIds, fretCount),
    [pattern, activeIds, fretCount],
  );
  // Memoized alongside the footprint because this component re-renders on every
  // active-id change, i.e. several times a beat while the transport runs.
  const offNeck = useMemo(() => cellsAboveFret(pattern, fretCount), [pattern, fretCount]);

  // A board drawn on the wrong instrument is the failure mode this project has been
  // burned by: `useFretboardModel` drops cells whose string the drawn instrument
  // doesn't have (`if (!openNote) continue`), so a 6-string pattern on a bass neck
  // silently loses its top two strings and looks entirely plausible. Say so instead.
  const wrongNeck =
    board !== undefined &&
    patternInstrument !== undefined &&
    patternInstrument.stringCount !== board.stringCount;

  if (!board || wrongNeck) {
    return (
      <Notice>
        {board && patternInstrument
          ? `${patternInstrument.name} pattern — the board is set to ${board.name}`
          : 'No instrument to draw'}
      </Notice>
    );
  }

  return (
    <figure
      data-testid="fretboard-view"
      // Explicit rather than relying on the caption naming the figure implicitly:
      // that mapping is spec'd but unevenly implemented, and this is the only
      // accessible description of the board (see the LIB-GAP(7) note below).
      aria-labelledby={captionId}
      // Both scrollers, and both ours. Vertical because the board's height follows its
      // width (viewBox 1202×280 at `h-auto`), so at a wide pane it wants ~280px and the
      // pane may be shorter. Horizontal because the lib's own root div is
      // `w-full overflow-x-auto` with no `tabindex`: at a pane narrower than the svg's
      // 820px minimum, that scroller is the only way to the upper frets and a
      // keyboard-only user cannot reach it — and we can't add the attribute, since the
      // div is the lib's. Matching its minimum on our wrapper below keeps the lib's
      // scroller permanently at rest and puts the overflow on this element, which is
      // ours to make focusable.
      //
      // `tabIndex` is what makes either axis keyboard-scrollable. Safe here in a way it
      // would not be inside the `aria-hidden` wrapper: this figure is in the
      // accessibility tree and named by its caption.
      tabIndex={0}
      // Deliberately not `justify-center`: centred content in a scroller makes the
      // top unreachable once it overflows.
      className="well flex min-h-0 flex-1 flex-col overflow-auto px-2 py-1.5"
    >
      {/*
       * LIB-GAP(7), second half: `<Fretboard>` hardcodes its own `aria-label` from
       * the global scale state ("Fretboard showing A major in Standard") and accepts
       * no override, which describes something this board deliberately isn't drawing.
       * Hidden from the accessibility tree and described by the caption instead; the
       * note data itself is reachable in the timeline, not here.
       */}
      {/* `min-w` mirrors the lib svg's own `min-w-[820px]`, so the board is never
          squeezed and the lib's inner `overflow-x-auto` never has anything to scroll —
          see the figure's comment. `flex-none` for the same reason the tab staff has
          it: a flex child in a scrolling column must not be shrinkable, or the thing
          being scrolled to is the thing that shrank away. */}
      <div aria-hidden className="w-full min-w-[820px] flex-none">
        {/*
         * LIB-GAP(8): no scale layer, even when the pattern has a key — a deliberate
         * departure from guitar-tutor's `FretboardInput`.
         *
         * `useFretboardModel` skips any footprint cell the render set already drew,
         * and `dimNonHighlighted` never touches the render set (it only gates the
         * editor's hover-preview marker). Passing the pattern's scale would therefore
         * draw ~57 full-colour degree markers and make every in-scale cell of the
         * pattern indistinguishable from them — the pattern would vanish from the view
         * whose whole job is showing it. `FretboardInput` gets away with it because
         * it's an editor: the dimming exists to support stamping, and nothing is
         * stamped here.
         *
         * `inlayGrid` isn't passed either, despite `FretboardInput` setting it: the lib
         * uses it only to gate a hover-preview marker, and `hoverCell` is set solely by
         * the `.fb-cell-hit` rects, which render only under `onCellClickOverride`. On a
         * read-only board it is inert, and the inlay dots and fret numbers it sounds
         * like it controls come from `FretLines` unconditionally.
         *
         * Delete when `dimNonHighlighted` dims the render set, at which point the
         * scale layer can come back keyed off `pattern.key` / `pattern.scaleType`.
         */}
        <Fretboard
          neutralGrid={false}
          highlights={NO_HIGHLIGHTS}
          footprintCells={footprintCells}
          activeCells={activeCells}
        />
      </div>
      <figcaption
        id={captionId}
        className="text-center font-mono text-[10px] tracking-[0.12em] text-ink-mut uppercase"
      >
        {captionFor(pattern?.name, footprintCells.length, offNeck)}
      </figcaption>
    </figure>
  );
}

/**
 * Its own testid rather than the board's: a caller asserting that the pane drew a
 * board must not be satisfied by the notice saying it couldn't, which is the exact
 * failure this component exists to report.
 */
function Notice({ children }: { children: string }) {
  return (
    <div
      data-testid="reference-notice"
      className="well flex min-h-0 flex-1 items-center justify-center px-2 text-center"
    >
      <span className="font-mono text-[10px] tracking-[0.12em] text-ink-mut uppercase">
        {children}
      </span>
    </div>
  );
}

/**
 * The board's own description, and the only place the app admits to hiding part of
 * a pattern: a note above the last fret has nowhere to be drawn (see
 * `patternCells`), and a silently missing marker is worse than an ugly caption.
 */
function captionFor(name: string | undefined, cells: number, offNeck: number): string {
  if (name === undefined) return 'Fretboard — no pattern open';
  const shown = `${name} — ${cells} ${cells === 1 ? 'cell' : 'cells'} on the neck`;
  return offNeck === 0 ? shown : `${shown}, ${offNeck} above the last fret`;
}
