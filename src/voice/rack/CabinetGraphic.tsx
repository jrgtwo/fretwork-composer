/**
 * CabinetGraphic — the cabinet stage as a cabinet, with the IR chosen by mic placement.
 *
 * Shape from guitar-tutor's `sound-design/Cabinet`: a cab outline, speaker cone, mic dot,
 * picker underneath. Two things are different, and both matter.
 *
 * 1. THE DOT IS THE PICKER. guitar-tutor labels its dot "Cosmetic for now" because its IR
 *    set had no positional meaning. Ours does — `micPositions.ts` places all nine
 *    registered IRs polar about the dust cap, radius encoding brightness — so dragging
 *    the dot snaps to the nearest placed capture and changes the cab for real.
 * 2. NO GRILLE TEXTURE. Its tweed hatch `<pattern>` is exactly the surface texture this
 *    project explored and rejected. The grille is `ScoredGrille` instead: the timeline's
 *    scored-groove device, strength scaling and all, applied to a different object.
 *
 * MATERIAL. `.tray` is the cab, `.well` is the baffle behind the grille — the vocabulary
 * maps onto the object almost without translation.
 *
 * ONE CONE, NOT FOUR. `micPositions.ts` spells out why: the layout is polar about
 * `(0.5, 0.5)`, so a 2×2 grid of cones would put the origin — and therefore every "cap"
 * mic — in the crack between four speakers. It draws the reference cone the coordinates
 * are actually about. (`twin-clean` is a 2×12 combo and the rest are 4×12s, so no single
 * cabinet drawing is right for all nine anyway; a single cone is at least never *wrong*
 * about where the mic is.)
 *
 * ACCESSIBILITY. A drag-only control cannot be the primary way to pick a cabinet, so the
 * nine placements are a `radiogroup` of nine dots: each one is a real button with the
 * IR's label as its name, arrow keys walk the set, and the pointer path is an addition to
 * that rather than a replacement for it. The caller also renders the schema's cabinet
 * `<select>` underneath — the text-level fallback, and the only thing that can say *why*
 * a capture sounds the way it does, since the registry's descriptions live there.
 */
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import { detectCabinetIR, type CabinetIR } from '@fretwork/lib';
import { PLACED_CABINET_IRS, nearestIrAt, type MicPosition } from '../micPositions';
import { PowerLamp, ScoredGrille } from './RackFace';

/**
 * Cone geometry, in the baffle's 100×100 box. The cone is centred because the mic
 * layout is polar about its dust cap.
 *
 * The radii are not free: `micPositions.ts` documents four radius bands and states what
 * they require of the graphic. These are sized so each band lands on the part of the
 * speaker it names — cap ≤ 0.16, cone 0.26–0.38, surround to 0.44, and only `gods-room-87`
 * at 0.45 off the baffle, which is the one capture made in front of the cab.
 */
const CENTRE = 50;
const SURROUND_R = 44;
const CONE_R = 38;
const RIB_RADII = [32, 25] as const;
const CAP_R = 17;

export function CabinetGraphic({
  url,
  onChange,
  bypassed = false,
}: {
  /** The preset's cabinet URL once the descriptor has resolved it — `null` for a URL the
   *  registry does not know, which draws no active dot rather than a false one. */
  url: string | null;
  onChange: (url: string) => void;
  bypassed?: boolean;
}) {
  // Gradient ids are document-global, so two cabinets on one page would share whichever
  // `<defs>` mounted first. Sanitised for the same reason `Knob` sanitises: the id is
  // interpolated into unquoted `url(#…)`, which cannot carry a colon.
  const uid = useId().replace(/:/g, '');
  const baffleRef = useRef<HTMLDivElement | null>(null);
  const dotRefs = useRef(new Map<string, HTMLButtonElement>());
  /** Tears down an in-flight drag so unmounting mid-gesture doesn't leak listeners. */
  const abortDrag = useRef<(() => void) | null>(null);
  /**
   * Where the mic is *while the pointer is still down*, before the edit is committed.
   *
   * A cab URL is not part of `sourceFingerprint`, so a change to it takes
   * `playbackService`'s swap path — but `Tone.Convolver` loads its IR in the constructor
   * and cannot swap URLs in place, so the lib rebuilds the whole effects chain and starts
   * a network fetch for every one. A drag across the baffle crosses four to six
   * territories, which would be four to six teardowns with the cab silent through each.
   * So the gesture is local until it ends, exactly as `playbackService`'s
   * `REBUILD_COALESCE_MS` and `paramSchema`'s `rebuildsVoice` hold back the other
   * rebuild-class controls. Click and keyboard are single-shot and commit immediately.
   */
  const [pendingId, setPendingId] = useState<string | null>(null);

  const committedId = url === null ? null : (detectCabinetIR(url)?.id ?? null);
  const selectedId = pendingId ?? committedId;
  const selectedIndex = PLACED_CABINET_IRS.findIndex((placed) => placed.ir.id === selectedId);

  /**
   * Pointer position as a normalized point on the baffle.
   *
   * `null` when the baffle has no size. That is not paranoia: jsdom reports every rect as
   * 0×0 and a collapsed pane really is 0 px wide, and dividing by it hands `nearestIrAt`
   * a `NaN` it is documented to throw on. So the pointer path is only exercisable in a
   * test that stubs the rect — which `AmpRack.test.tsx` does.
   */
  const pointAt = useCallback((clientX: number, clientY: number): MicPosition | null => {
    const rect = baffleRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    return { x: (clientX - rect.left) / rect.width, y: (clientY - rect.top) / rect.height };
  }, []);

  /**
   * Drag transport is `window` listeners filtered on `pointerId`, matching `Knob` and
   * `Timeline` — jsdom implements no pointer capture, so a captured gesture would be
   * untestable here, and without the id filter a second finger anywhere on the page
   * steers this dot.
   *
   * No `preventDefault`: the dots are buttons, and suppressing the compatibility events
   * risks suppressing the `click` that makes each one selectable on its own. There is no
   * selectable text inside the baffle for a drag to smear, and `select-none` covers the
   * labels either way.
   */
  const handlePointerDown = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      // A press that lands on a dot belongs to that dot — its own `click` selects it.
      // Without this the baffle answers too, and near a dot's edge the nearest capture
      // can be a *different* one, so the press would commit B and the click then A.
      if ((e.target as Element).closest('[role="radio"]')) return;
      abortDrag.current?.();

      const pointerId = e.pointerId;
      const startUrl = url;
      let placed: CabinetIR | null = null;

      const place = (clientX: number, clientY: number) => {
        const point = pointAt(clientX, clientY);
        if (!point) return;
        const ir = nearestIrAt(point);
        // A drag crosses one capture's territory many times per second; only the
        // crossings move the dot.
        if (ir.id === placed?.id) return;
        placed = ir;
        setPendingId(ir.id);
      };

      place(e.clientX, e.clientY);

      const onMove = (ev: globalThis.PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        place(ev.clientX, ev.clientY);
      };
      const finish = (ev: globalThis.PointerEvent | undefined, keep: boolean) => {
        if (ev && ev.pointerId !== pointerId) return;
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onCancel);
        abortDrag.current = null;
        setPendingId(null);
        if (!keep || !placed) return;
        // Focus follows a pointer selection as well as a keyboard one, or a click on
        // the baffle would leave the arrow keys with nothing to move.
        dotRefs.current.get(placed.id)?.focus();
        if (placed.url !== startUrl) onChange(placed.url);
      };
      // Declarations, not consts: `finish` has to name them to unsubscribe, and they
      // have to name `finish` to call it.
      function onUp(ev: globalThis.PointerEvent) {
        finish(ev, true);
      }
      // pointercancel discards — a touch taken away with no pointerup is not a choice.
      function onCancel(ev: globalThis.PointerEvent) {
        finish(ev, false);
      }

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancel);
      abortDrag.current = () => finish(undefined, false);
    },
    [onChange, pointAt, url],
  );

  useEffect(() => () => abortDrag.current?.(), []);

  /** Radiogroup keyboard: arrows move the selection *and* the focus, which is what a
   *  radio group does — one tab stop, and stepping through it commits as it goes. */
  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
      const last = PLACED_CABINET_IRS.length - 1;
      let next: number;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = index === last ? 0 : index + 1;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = index === 0 ? last : index - 1;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = last;
      else return;

      e.preventDefault();
      const target = PLACED_CABINET_IRS[next];
      onChange(target.ir.url);
      // Every dot is mounted, so the new one can take focus immediately — this does not
      // wait on the caller applying the change.
      dotRefs.current.get(target.ir.id)?.focus();
    },
    [onChange],
  );

  return (
    // `max-w-full` and not a bare `w-[200px]`: this sits in a wrapping flex row inside a
    // pane whose layout is being reworked, and a fixed width would overflow rather than
    // give way once the column is narrower than the cab.
    <div className="tray w-[200px] max-w-full flex-none p-1.5">
      <div
        ref={baffleRef}
        onPointerDown={handlePointerDown}
        className="well relative aspect-square touch-none cursor-grab select-none overflow-hidden active:cursor-grabbing"
      >
        <ScoredGrille count={18} />

        <svg
          aria-hidden
          focusable="false"
          viewBox="0 0 100 100"
          className="absolute inset-0 h-full w-full"
        >
          <defs>
            {/* Sunken: light at the BOTTOM, dark at the top — the inverse of the knob
                cap, which is what makes the same two colours read as a hole. */}
            <linearGradient id={`${uid}-surround`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-rim-dark)" />
              <stop offset="100%" stopColor="var(--color-rim)" />
            </linearGradient>
            <linearGradient id={`${uid}-cone`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-well-hi)" />
              <stop offset="100%" stopColor="var(--color-block)" />
            </linearGradient>
            {/* The dust cap is convex where the cone is concave, so its gradient runs
                the other way. */}
            <linearGradient id={`${uid}-cap`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-raise-hi)" />
              <stop offset="100%" stopColor="var(--color-raise)" />
            </linearGradient>
            {/* The inner shadow that drops the cone below the baffle: a thick stroke
                just inside the surround, fading out by the equator. */}
            <linearGradient id={`${uid}-inner`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#000000" stopOpacity="0.6" />
              <stop offset="55%" stopColor="#000000" stopOpacity="0" />
            </linearGradient>
          </defs>

          <circle
            cx={CENTRE}
            cy={CENTRE}
            r={SURROUND_R}
            fill={`url(#${uid}-surround)`}
            stroke="var(--color-rim-dark)"
            strokeWidth={1}
          />
          <circle cx={CENTRE} cy={CENTRE} r={CONE_R} fill={`url(#${uid}-cone)`} />
          {RIB_RADII.map((r) => (
            <circle
              key={r}
              cx={CENTRE}
              cy={CENTRE}
              r={r}
              fill="none"
              stroke="var(--color-rim-dark)"
              strokeWidth={0.6}
              opacity={0.55}
            />
          ))}
          <circle
            cx={CENTRE}
            cy={CENTRE}
            r={CAP_R}
            fill={`url(#${uid}-cap)`}
            stroke="var(--color-rim-dark)"
            strokeWidth={0.6}
          />
          <circle
            cx={CENTRE}
            cy={CENTRE}
            r={SURROUND_R - 2}
            fill="none"
            stroke={`url(#${uid}-inner)`}
            strokeWidth={4}
          />
        </svg>

        {/* One dot per placed IR. The group is the control; the baffle underneath is a
            shortcut to it, not a second control. */}
        {/* Named for what it *picks*, not for what it looks like: activating a dot writes
            `effects.cabIR.url`, and `twin-clean` is not a position on this cab at all —
            so "Mic position" alone would announce a group and then read out cabinets. */}
        <div role="radiogroup" aria-label="Cabinet mic position" className="absolute inset-0">
          {PLACED_CABINET_IRS.map(({ ir, position, distant }, index) => {
            const active = ir.id === selectedId;
            return (
              <button
                key={ir.id}
                ref={(el) => {
                  if (el) dotRefs.current.set(ir.id, el);
                  else dotRefs.current.delete(ir.id);
                }}
                type="button"
                role="radio"
                aria-checked={active}
                aria-label={ir.label}
                // Roving tab stop. Nothing selected — an unregistered URL — still leaves
                // one way in, or the group would be unreachable by keyboard.
                tabIndex={active || (selectedIndex === -1 && index === 0) ? 0 : -1}
                onClick={() => onChange(ir.url)}
                onKeyDown={(e) => handleKeyDown(e, index)}
                style={{ left: `${position.x * 100}%`, top: `${position.y * 100}%` }}
                // The drawn dot stays small — it is a mic on a speaker, and nine of them
                // have to read as a scatter — but the *target* is a transparent 20px
                // `::after`. An 8px target is unhittable by touch and needs precise
                // mousing; 20px is as large as it can go before neighbours collide, since
                // the closest pair sit 22px apart on a 200px baffle. Sized absolutely
                // rather than by inset so the checked dot, which is drawn larger, does
                // not also get a larger target and start eating its neighbour's.
                className={`absolute -translate-x-1/2 -translate-y-1/2 rounded-full border after:absolute after:top-1/2 after:left-1/2 after:h-5 after:w-5 after:-translate-x-1/2 after:-translate-y-1/2 after:rounded-full after:content-[''] ${
                  active
                    ? 'h-3 w-3 border-brass-lo bg-brass-hi shadow-glow-brass'
                    : 'h-2 w-2 border-rim-dark bg-line-hi hover:bg-brass'
                } ${
                  // The one capture made in front of the cab rather than on it. Its
                  // radius already encodes distance-from-cap like every other, so drawn
                  // plainly it would read as one more on-cone mic; the halo is the depth
                  // cue `PlacedCabinetIR.distant` asks the graphic for.
                  distant ? 'ring-2 ring-line-hi/70' : ''
                }`}
              />
            );
          })}
        </div>
      </div>

      {/* The cab's own state line. Not decoration and not a duplicate of the section
          header's: this box is a self-contained widget whose mic dot keeps working while
          the stage is out of the chain, and without a cue here a bypassed cabinet is drawn
          identically to a live one. Lamp *and* word, for the reason `AmpHead` gives — lit
          versus dark is a luminance cue and cannot be the only one. */}
      <p className="flex items-center justify-center gap-1 pt-1 font-mono text-[8px] tracking-[0.16em] text-ink-mut uppercase">
        <PowerLamp lit={!bypassed} />
        {bypassed ? 'Bypassed' : 'In chain'}
      </p>
    </div>
  );
}
