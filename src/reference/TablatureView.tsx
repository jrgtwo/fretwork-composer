/**
 * The tablature reference view: the current pattern as readable tab, wrapping into
 * stacked systems like sheet music and lighting up as it plays. Read-only.
 *
 * Every number in here comes from `tabLayout` — this component measures its width,
 * hands it over, and draws what comes back. Nothing about wrapping, bar placement
 * or glyph position is decided in the render pass, because jsdom has no layout and
 * anything decided here could never be asserted.
 *
 * Unlike `FretboardView` this draws its own staff, so it needs no agreement with the
 * lib's global neck: the only instrument question is how many strings the *pattern*
 * has, which `patternInstrumentId` already owns.
 */
import { memo, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { getInstrument } from '@fretwork/lib';
import { useActiveEventIds } from '../audio/playbackService';
import { patternInstrumentId, useEditingPattern } from '../patterns/patternService';
import {
  LABEL_GUTTER,
  ROW_HEIGHT,
  SYSTEM_PAD,
  layoutTab,
  stringLabels,
  type TabGlyph,
  type TabSystem,
} from './tabLayout';

/**
 * How many lines to draw with no pattern open. Also the type guard for
 * `getInstrument` — `patternInstrumentId` only ever returns a catalog id, so that
 * lookup can't actually miss.
 */
const DEFAULT_STRING_COUNT = 6;

export function TablatureView() {
  const pattern = useEditingPattern();
  const activeIds = useActiveEventIds();
  const captionId = useId();
  const staffRef = useRef<HTMLDivElement>(null);
  // 0 until the first measurement. `layoutTab` treats that as "one bar wide"
  // rather than dividing by it, so the first paint is cramped but never broken.
  const [width, setWidth] = useState(0);

  const instrumentId = pattern ? patternInstrumentId(pattern) : null;
  const stringCount =
    (instrumentId ? getInstrument(instrumentId)?.stringCount : undefined) ?? DEFAULT_STRING_COUNT;

  // Bars per system follows the width, so a resized pane has to re-wrap the music
  // — measure it, exactly as the timeline measures its pane height.
  //
  // Measuring inside a scroller normally risks a feedback loop (a scrollbar appears,
  // width shrinks, content grows, …). It settles here because the relationship is
  // monotone: a narrower staff only ever makes the stack *taller*, so once the
  // vertical scrollbar is showing it never goes away and the width stops changing.
  useLayoutEffect(() => {
    const el = staffRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(el);
    setWidth(el.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, []);

  const layout = useMemo(
    () =>
      layoutTab({
        width,
        events: pattern?.events ?? [],
        timeSignature: pattern?.timeSignature ?? { numerator: 4, denominator: 4 },
        durationTicks: pattern?.durationTicks ?? 0,
        stringCount,
      }),
    [width, pattern, stringCount],
  );

  // Indexed by row, so top-to-bottom: `stringLabels` is indexed by `stringIndex`,
  // which counts from the bottom string. Reversing it here is the same inversion
  // `rowForString` makes for the notes.
  const labels = useMemo(
    () => (instrumentId ? stringLabels(instrumentId, stringCount).reverse() : []),
    [instrumentId, stringCount],
  );

  const sounding = new Set(activeIds);

  return (
    <figure
      data-testid="tablature-view"
      // Named by its caption for the same reason as the fretboard: the staff itself
      // is a wall of absolutely-positioned numbers with no useful reading order, and
      // the note data is reachable in the timeline. Hiding it is honest; pretending
      // a screen reader can navigate it would not be.
      aria-labelledby={captionId}
      // Focusable for the same reason as the fretboard's: a scroller no one can put the
      // caret in is unreachable without a pointer, and a narrow pane wraps this into a
      // stack taller than the pane. Only the vertical axis overflows — `layoutTab` caps
      // bar width to the measured width, so the staff never runs off the side.
      tabIndex={0}
      className="well flex min-h-0 flex-1 flex-col overflow-y-auto px-2 py-1.5"
    >
      <div
        ref={staffRef}
        aria-hidden
        className="relative w-full flex-none"
        style={{ height: layout.height }}
      >
        {layout.systems.map((system) => (
          <System key={system.index} system={system} labels={labels} />
        ))}
        {layout.glyphs.map((glyph) => (
          <Note key={glyph.id} glyph={glyph} active={sounding.has(glyph.id)} />
        ))}
      </div>
      <figcaption
        id={captionId}
        className="mt-1 text-center font-mono text-[10px] tracking-[0.12em] text-ink-mut uppercase"
      >
        {/* The glyph count, not `events.length`: this sentence mirrors the fretboard's
            "N cells on the neck, M above the last fret", where N excludes M. Counting
            the notes it drew and then the ones it couldn't is the same arithmetic. */}
        {captionFor(pattern?.name, layout.totalBars, layout.glyphs.length, layout.offStaff)}
      </figcaption>
    </figure>
  );
}

/**
 * One staff: six lines, its string labels, and its barlines.
 *
 * The wrapper is a static box holding absolutely-positioned parts, so it groups
 * them without contributing any geometry of its own — the positions still resolve
 * against the measured staff above. `data-tab-system` and `data-tab-string` are
 * test seams: none of this has a role or an accessible name, and with no layout in
 * jsdom the wrap is only observable by counting what got drawn.
 *
 * Memoized because the parent re-renders on every active-id emit — several times a
 * beat while the transport runs — and nothing in a staff depends on what is sounding.
 */
const System = memo(function System({
  system,
  labels,
}: {
  system: TabSystem;
  labels: readonly string[];
}) {
  const staffTop = system.rowYs[0];
  const staffHeight = (system.rowYs.length - 1) * ROW_HEIGHT;

  return (
    <div data-tab-system={system.index}>
      {system.rowYs.map((y, row) => (
        <span key={row}>
          <i
            className="absolute h-px bg-line"
            style={{ top: y, left: system.left, width: system.right - system.left }}
          />
          <span
            data-tab-string={row}
            className="absolute font-mono text-[9px] leading-none font-bold text-ink-mut"
            // Half a row up, so the label reads as sitting *on* its line.
            style={{ top: y - 4, left: 0, width: LABEL_GUTTER - 4, textAlign: 'right' }}
          >
            {labels[row] ?? ''}
          </span>
        </span>
      ))}

      {/* Barlines, plus the closing one — a system with no line at its right edge
          reads as unfinished rather than as a wrap. */}
      {system.bars.map((bar) => (
        <span key={bar.bar}>
          <i
            data-tab-barline={bar.bar}
            className="absolute w-px bg-beat-line"
            style={{ top: staffTop, left: bar.x, height: staffHeight }}
          />
          {/* Only the system's first bar is numbered: numbering every bar in a
              wrapped score is clutter, and the leading number is what tells you
              where you are. */}
          {bar.bar === system.bars[0].bar && (
            <span
              data-tab-bar={bar.bar}
              className="absolute font-mono text-[8.5px] leading-none font-bold text-ink-hi"
              // At the very top of the pad, which is sized to clear the glyph band
              // below it — a note on the top line at the system's first tick overhangs
              // half its own height above that line and would otherwise sit under
              // this number. jsdom has no layout, so nothing can assert the gap.
              style={{ top: staffTop - SYSTEM_PAD + 1, left: bar.x + 2 }}
            >
              {bar.bar}
            </span>
          )}
        </span>
      ))}
      <i
        data-tab-barline="close"
        className="absolute w-px bg-beat-line"
        style={{ top: staffTop, left: system.right, height: staffHeight }}
      />
    </div>
  );
});

/**
 * One note: its ring-out tail, then the fret number over the top of it.
 *
 * `data-tab-note`, `data-tab-tail` and `data-palm-mute` are test seams, not app state
 * — the staff is `aria-hidden` and a fret number has no role or accessible name, so
 * jsdom has no other handle on any of it.
 */
function Note({ glyph, active }: { glyph: TabGlyph; active: boolean }) {
  return (
    <>
      {glyph.tailWidth > 0 && (
        <i
          data-tab-tail={glyph.id}
          // Palm mute is a dimmer tail rather than a character, as in guitar-tutor:
          // the whole point of `noteParts` leaving it out of the text is that a `PM`
          // on the number is the timeline's vocabulary, not tab's.
          className={`absolute h-[2px] ${glyph.palmMute ? 'bg-ink-mut/20' : 'bg-ink-mut/45'}`}
          style={{ top: glyph.y - 1, left: glyph.x, width: glyph.tailWidth }}
        />
      )}
      <span
        data-tab-note={glyph.id}
        data-active={active || undefined}
        data-palm-mute={glyph.palmMute || undefined}
        // Opaque behind the number so the staff line doesn't run through it, which is
        // how printed tab does it too — which is why palm mute *dims* the number
        // instead of replacing that fill with a tint: a translucent one would let the
        // line straight through, reintroducing the thing the fill exists to stop.
        className={`absolute -translate-x-1/2 -translate-y-1/2 rounded-[3px] bg-well px-[3px] font-mono text-[11px] leading-none font-bold whitespace-nowrap ${
          active
            ? 'text-brass-hi shadow-glow-brass'
            : glyph.palmMute
              ? 'text-ink-mut'
              : 'text-ink'
        }`}
        style={{ top: glyph.y, left: glyph.x }}
      >
        {glyph.prefix && <span className="text-brass-hi">{glyph.prefix}</span>}
        {glyph.core}
        {glyph.suffix && <span className="text-brass-hi">{glyph.suffix}</span>}
      </span>
    </>
  );
}

/**
 * The view's own description, and the only place it admits to hiding part of a
 * pattern — a note on a string this staff hasn't got is drawn nowhere at all, and a
 * silently missing note is worse than an ugly caption. Mirrors `FretboardView`.
 */
function captionFor(
  name: string | undefined,
  bars: number,
  /** Notes actually drawn — `offStaff` is counted separately, never in this. */
  notes: number,
  offStaff: number,
): string {
  if (name === undefined) return 'Tab — no pattern open';
  const shown = `${name} — ${bars} ${bars === 1 ? 'bar' : 'bars'}, ${notes} ${notes === 1 ? 'note' : 'notes'}`;
  return offStaff === 0 ? shown : `${shown}, ${offStaff} off the staff`;
}
