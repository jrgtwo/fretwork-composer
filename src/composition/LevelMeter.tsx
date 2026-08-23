/**
 * One signal-level meter.
 *
 * ── It does not re-render ───────────────────────────────────────────────────
 *
 * A meter that updated through React state would re-render its whole strip 30
 * times a second to move a bar a few pixels, and there is one of these per track
 * per tap. So the component renders ONCE and then writes to its own DOM nodes
 * from the subscription callback — `transform` on the fill, `left` on the peak
 * marker, a class on the clip dot. Nothing above it ever hears about a level.
 *
 * That is also why the readout is written as `textContent` rather than rendered:
 * it is the same number the bar is already showing, and putting it in state
 * would undo the whole arrangement.
 *
 * ── What it shows ───────────────────────────────────────────────────────────
 *
 *  - **the bar** — the level right now, on a dB scale (see {@link METER_MIN_DB}).
 *  - **the peak marker** — the loudest of the last moment, falling back slowly.
 *    A pluck is over in a few frames; without a held peak the bar flicks up and
 *    is gone before the eye lands on it, which is the difference between a meter
 *    you can read and a meter that just moves.
 *  - **the clip dot** — LATCHING. It lights the moment a reading reaches
 *    {@link CLIP_DB} and stays lit for {@link CLIP_HOLD_MS} after the last one,
 *    because the event worth seeing lasts one frame and looking away must not
 *    mean missing it. Click it to clear.
 */
import { useEffect, useRef } from 'react';
import { subscribeMeter, type MeterSource } from '../audio/levelMeters';

/** Bottom of the scale. Below this the bar is empty — a guitar's noise floor
 *  and a silent track are not worth distinguishing in a 200 px strip. */
export const METER_MIN_DB = -60;

/** Top of the scale. Deliberately ABOVE 0 dBFS: the whole point of these meters
 *  is to show a signal that has gone past full scale, and a meter that stops at
 *  0 pins itself and hides exactly the number we are looking for. */
export const METER_MAX_DB = 6;

/** At or above this, the clip indicator latches. 0 dBFS is full scale — the
 *  loudest a sample can be — so anything at or over it is being squashed by
 *  something downstream, or has already been flattened by something upstream. */
export const CLIP_DB = 0;

/** How long the clip indicator stays lit after the last over-level reading. */
const CLIP_HOLD_MS = 1600;

/** How fast the held peak falls, in dB per second. Roughly a broadcast meter's
 *  fallback — slow enough to read, fast enough to follow a part. */
const PEAK_FALL_DB_PER_SEC = 24;

function fractionOf(db: number): number {
  if (!Number.isFinite(db)) return 0;
  const span = METER_MAX_DB - METER_MIN_DB;
  return Math.max(0, Math.min(1, (db - METER_MIN_DB) / span));
}

function readoutOf(db: number): string {
  if (!Number.isFinite(db)) return '-∞';
  if (db <= METER_MIN_DB) return '-∞';
  return `${db > 0 ? '+' : ''}${db.toFixed(1)}`;
}

interface LevelMeterProps {
  /** Which point in the graph to watch. */
  readonly source: MeterSource;
  /** Row label — `IN`, `OUT`, `MSTR`. Kept short: the strip gives it 26 px. */
  readonly label: string;
  /** Spoken name, e.g. "Rhythm Guitar input level". The bar itself is
   *  `aria-hidden`; this is what a reader announces. */
  readonly title: string;
}

export function LevelMeter({ source, label, title }: LevelMeterProps) {
  const fillRef = useRef<HTMLDivElement | null>(null);
  const peakRef = useRef<HTMLDivElement | null>(null);
  const dotRef = useRef<HTMLButtonElement | null>(null);
  const readoutRef = useRef<HTMLSpanElement | null>(null);

  // The subscription owns this, not React: it is per-frame state that nothing
  // renders from.
  const heldPeakDb = useRef(METER_MIN_DB);
  const lastFrameMs = useRef(0);
  const clipUntilMs = useRef(0);

  // `source` is an object literal at every call site, so a new identity each
  // render. Depending on it directly would resubscribe on every parent render;
  // the two fields are what actually identify the tap.
  const kind = source.kind;
  const trackId = source.kind === 'master' ? '' : source.trackId;

  useEffect(() => {
    const watched: MeterSource =
      kind === 'master' ? { kind: 'master' } : { kind, trackId };

    return subscribeMeter(watched, (db) => {
      const now = performance.now();
      const elapsedSec = lastFrameMs.current ? (now - lastFrameMs.current) / 1000 : 0;
      lastFrameMs.current = now;

      // Peak: jump straight to a new high, otherwise fall at a fixed rate.
      const fallen = heldPeakDb.current - PEAK_FALL_DB_PER_SEC * elapsedSec;
      const peak = Number.isFinite(db) ? Math.max(db, fallen) : fallen;
      heldPeakDb.current = Math.max(METER_MIN_DB, peak);

      if (Number.isFinite(db) && db >= CLIP_DB) clipUntilMs.current = now + CLIP_HOLD_MS;

      const fill = fillRef.current;
      if (fill) {
        // CLIPPED, not scaled. A transform would scale the gradient with the
        // box and every bar would show the whole green-to-red ramp whatever its
        // level — see the long note on `.meter-fill`. Clipping keeps the
        // gradient painted across the full groove and moves only the window, so
        // a given dB always lands on the same colour.
        fill.style.clipPath = `inset(0 ${(1 - fractionOf(db)) * 100}% 0 0)`;
      }

      const marker = peakRef.current;
      if (marker) {
        const held = heldPeakDb.current;
        marker.style.opacity = held > METER_MIN_DB ? '1' : '0';
        marker.style.left = `${fractionOf(held) * 100}%`;
      }

      const dot = dotRef.current;
      if (dot) {
        const lit = now < clipUntilMs.current;
        // `dataset`, not a class swap: it is one attribute write per frame and
        // the styling stays in the stylesheet where the rest of the palette is.
        if (dot.dataset.lit !== String(lit)) dot.dataset.lit = String(lit);
      }

      const readout = readoutRef.current;
      if (readout) {
        const text = readoutOf(heldPeakDb.current);
        // Guarded: an unchanged string is the common case between plucks, and
        // writing `textContent` unconditionally dirties layout every frame.
        if (readout.textContent !== text) readout.textContent = text;
      }
    });
  }, [kind, trackId]);

  return (
    <div className="flex items-center gap-1" title={title}>
      <span
        aria-hidden
        className="w-[26px] flex-none font-mono text-[8.5px] font-bold leading-none text-ink-mut"
      >
        {label}
      </span>
      {/* The groove is a `.well` for the same reason the beat grid is one: this
          palette separates surfaces by depth, not by lines, and a meter is
          physically a channel cut into the strip. */}
      <div
        aria-hidden
        className="well relative h-[5px] min-w-0 flex-1 overflow-hidden rounded-[2px]"
      >
        <div
          ref={fillRef}
          className="meter-fill absolute inset-0"
          style={{ clipPath: 'inset(0 100% 0 0)' }}
        />
        <div
          ref={peakRef}
          className="meter-peak absolute inset-y-0 w-[1.5px]"
          style={{ left: '0%', opacity: 0 }}
        />
      </div>
      <button
        ref={dotRef}
        type="button"
        data-lit="false"
        className="meter-clip flex-none"
        aria-label={`${title} — clip indicator. Click to clear.`}
        onClick={() => {
          clipUntilMs.current = 0;
          if (dotRef.current) dotRef.current.dataset.lit = 'false';
        }}
      />
      <span
        ref={readoutRef}
        aria-hidden
        className="w-[30px] flex-none text-right font-mono text-[8.5px] tabular-nums text-ink-mut"
      >
        -∞
      </span>
    </div>
  );
}
