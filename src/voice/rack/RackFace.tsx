/**
 * RackFace — the chassis every stage of the voice chain is mounted in, plus the two
 * pieces of furniture the other rack components bolt onto it.
 *
 * The shape is guitar-tutor's `sound-design/RackUnit`: a thin raised faceplate with the
 * unit's name engraved at the left, its controls in the middle and a power lamp at the
 * right, stacked vertically so the pane reads as an outboard rack. Nothing else is
 * carried across. Its zinc-and-tolex gradients are the warm-wood DAW skin this project
 * rejected, and its six-colour accent stripe (orange/green/blue/purple/red/amber) is
 * spent colour we do not have: brass is the app's one accent, and slate and plum are
 * *reserved* for distinguishing stage TYPES later — which is the job they were held back
 * for, and not one a decorative stripe should spend first. So the stripe is brass, full
 * stop.
 *
 * MATERIAL. `.panel` is the unit's chassis and `.control` the faceplate that stands proud
 * of it; the body below is `shadow-sunken`, so the plate reads as bolted on rather than
 * drawn on. That inverts the timeline, where the content sits down in a well and the
 * frame surrounds it — here the *face* is the raised thing. Deliberate: a rack unit is
 * read by its front panel, and a timeline by what is in its grid.
 *
 * The lamp is `--color-brass-hi` with `--shadow-glow-brass`. guitar-tutor's is red, and
 * red is the one colour that would announce the whole rack as borrowed.
 */
import type { ReactNode } from 'react';

/**
 * The unit's power lamp. Presentational by default — `aria-hidden`, because the state it
 * shows is already carried by whatever control or status text sits beside it, and a lamp
 * announcing itself a second time is noise. `AmpHead` puts one inside a real
 * `role="switch"` button, where the button carries the semantics and this is its bulb.
 */
export function PowerLamp({ lit }: { lit: boolean }) {
  return (
    <i
      aria-hidden
      className={`h-1.5 w-1.5 flex-none rounded-full ${
        lit ? 'bg-brass-hi shadow-glow-brass' : 'bg-line-hi'
      }`}
    />
  );
}

/**
 * Grooves scored into a surface — the amp's lower vent and the cabinet's grille.
 *
 * NOT a texture. Surface texture (guitar-tutor's tweed hatch `<pattern>`) was explored at
 * length on this project and rejected as busy; what the timeline settled on instead is
 * grooves cut into the material with their strength scaling by importance — the bar line
 * versus the beat line, `--color-beat-line` against `--color-well-line`. This is that
 * same device applied to a different object, which is why a speaker grille here is
 * perforation *geometry* and not a fill.
 *
 * Each groove is a dark score with a light catch on its right edge, the same two-part
 * cut `.lanes` uses in `styles/index.css` — that pairing is what makes it read as carved
 * rather than painted.
 *
 * `preserveAspectRatio="none"` stretches the 100×100 box to whatever it is dropped into,
 * so `vector-effect` is what keeps the strokes 1px instead of scaling with the box.
 */
export function ScoredGrille({
  count = 22,
  /** Every nth groove is cut deeper — the bar-line of the set. */
  emphasisEvery = 4,
}: {
  count?: number;
  emphasisEvery?: number;
}) {
  return (
    <svg
      aria-hidden
      focusable="false"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      className="pointer-events-none absolute inset-0 h-full w-full"
    >
      {Array.from({ length: count }, (_, i) => {
        const x = ((i + 0.5) / count) * 100;
        const deep = i % emphasisEvery === 0;
        return (
          <g key={i}>
            <line
              x1={x}
              y1={0}
              x2={x}
              y2={100}
              stroke={deep ? 'var(--color-beat-line)' : 'var(--color-well-line)'}
              strokeWidth={deep ? 1.4 : 1}
              opacity={deep ? 0.85 : 0.55}
              vectorEffect="non-scaling-stroke"
            />
            {/* The light catch on the far edge of the cut. */}
            <line
              x1={x + 0.5}
              y1={0}
              x2={x + 0.5}
              y2={100}
              stroke="#ffffff"
              strokeWidth={1}
              opacity={0.045}
              vectorEffect="non-scaling-stroke"
            />
          </g>
        );
      })}
    </svg>
  );
}

export function RackFace({
  name,
  regionName,
  note,
  lit,
  actions,
  children,
}: {
  /** Engraved at the left. A node rather than a string because the name is also the
   *  disclosure control — `VoiceSection` passes its button. */
  name: ReactNode;
  /**
   * Accessible name for the unit. A `<section>` with no name is exposed as a plain
   * generic, so without this a rack of them is not navigable by landmark.
   *
   * A string rather than an `aria-labelledby` at the engraved name: the landmark wants a
   * word the *chassis* owns ("Cabinet stage"), and pointing it at the disclosure button
   * would make the region and the picker inside it answer to the same one name.
   */
  regionName?: string;
  /** Small status line beside the name: "Bypassed", "Not on this preset". */
  note?: string | null;
  /** Power lamp state. Lit means the stage is really in the chain. */
  lit: boolean;
  /** Right of the faceplate, before the lamp — Add / Remove. */
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section aria-label={regionName} className="panel flex-none overflow-hidden rounded-xl">
      <div className="control flex items-center gap-1.5 px-1.5 py-1">
        {/* The accent stripe, collapsed to the one colour this app spends. */}
        <i aria-hidden className="-my-1 h-6 w-0.5 flex-none rounded-full bg-brass" />
        {name}
        {note ? (
          <span className="min-w-0 flex-1 truncate font-mono text-[9px] tracking-[0.06em] text-ink-mut">
            {note}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        {actions}
        <PowerLamp lit={lit} />
      </div>
      {/* Unpadded on purpose: a unit whose body is empty (a folded section) is then just
          its faceplate, with no orphan strip of recess under it. */}
      <div className="shadow-sunken">{children}</div>
    </section>
  );
}
