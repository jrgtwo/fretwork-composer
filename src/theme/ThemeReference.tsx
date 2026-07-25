/**
 * The living theme reference.
 *
 * Everything the design system can do, on one page, using only the tokens and
 * component classes from src/styles/index.css. If a restyle looks right here,
 * it looks right everywhere — so change tokens, reload this, and judge.
 */

const SECTIONS = [
  { n: '01', title: 'Surface & depth' },
  { n: '02', title: 'The tray' },
  { n: '03', title: 'Controls' },
  { n: '04', title: 'Type' },
  { n: '05', title: 'Palette' },
] as const;

function SectionHeading({ n, title }: { n: string; title: string }) {
  return (
    <div className="mb-5 flex items-baseline gap-3 border-b border-line pb-3">
      <span className="font-mono text-[10px] font-semibold tracking-[0.22em] text-brass">{n}</span>
      <h2 className="font-mono text-[10px] font-semibold tracking-[0.22em] text-ink-mut uppercase">
        {title}
      </h2>
    </div>
  );
}

/** A note block sitting in a lane — the atom of the beat grid. */
function Block({
  left,
  width,
  label,
  root = false,
}: {
  left: string;
  width: string;
  label: string;
  root?: boolean;
}) {
  return (
    <button
      type="button"
      style={{ left, width }}
      className={`pressable absolute top-[7px] flex h-[26px] items-center gap-2 rounded-[7px] px-2.5 font-mono text-[11px] font-bold ${
        root ? 'control-accent' : 'control'
      }`}
    >
      <span
        className={`h-[15px] w-[3px] rounded-sm ${root ? 'bg-brass-ink/40' : 'bg-ink-mut/50'}`}
      />
      {label}
    </button>
  );
}

/** One string's worth of steps. Grid lines are drawn, not elements. */
function Lane({ string, children }: { string: string; children?: React.ReactNode }) {
  return (
    <div className="relative ml-7 mr-3 h-10">
      <span className="absolute top-1/2 -left-2 -translate-x-full -translate-y-1/2 font-mono text-[11px] font-bold text-ink-mut">
        {string}
      </span>
      <div
        className="absolute inset-0"
        style={{
          backgroundImage: `repeating-linear-gradient(90deg, transparent 0 calc(6.25% - 1px), var(--color-well-line) calc(6.25% - 1px) 6.25%),
             repeating-linear-gradient(90deg, transparent 0 calc(25% - 1px), var(--color-beat-line) calc(25% - 1px) 25%)`,
        }}
      />
      {children}
    </div>
  );
}

function Button({
  children,
  accent = false,
}: {
  children: React.ReactNode;
  accent?: boolean;
}) {
  return (
    <button
      type="button"
      className={`pressable flex h-10 items-center gap-2 rounded-[10px] px-4 font-mono text-[11px] font-bold tracking-[0.1em] uppercase ${
        accent ? 'control-accent' : 'control'
      }`}
    >
      {children}
    </button>
  );
}

function Swatch({ name, varName, note }: { name: string; varName: string; note: string }) {
  return (
    <div className="flex items-center gap-3">
      <span
        className="h-9 w-9 flex-none rounded-lg border border-rim-dark"
        style={{ background: `var(${varName})`, boxShadow: 'var(--shadow-raised)' }}
      />
      <span className="min-w-0">
        <span className="block text-[13px] text-ink-hi">{name}</span>
        <span className="block font-mono text-[10.5px] text-ink-mut">{note}</span>
      </span>
    </div>
  );
}

export function ThemeReference() {
  return (
    <main className="mx-auto max-w-[860px] px-5 pt-10 pb-24">
      <p className="font-mono text-[11px] font-semibold tracking-[0.26em] text-ink-mut uppercase">
        Fretwork Composer
      </p>
      <h1 className="mt-2 font-display text-[38px] leading-none font-normal text-ink-hi">
        Theme <em className="text-brass">reference</em>
      </h1>
      <p className="mt-3 max-w-[62ch] text-ink-mut">
        Every token and primitive in the design system. Edit{' '}
        <code className="rounded bg-well px-1.5 py-0.5 text-[13px] text-ink">
          src/styles/index.css
        </code>{' '}
        and this page reflects it — that's the whole point.
      </p>

      {/* 01 — surface & depth ------------------------------------------------ */}
      <section className="mt-12">
        <SectionHeading {...SECTIONS[0]} />
        <div className="flex flex-wrap items-end gap-5">
          <div className="panel min-w-[230px] px-5 py-4">
            <div className="mb-1.5 text-[13px] font-semibold text-ink-hi">Raised panel</div>
            <div className="font-mono text-[11px] text-ink-mut">
              .panel · soft shadow + top highlight
            </div>
          </div>
          <div className="well min-w-[230px] px-5 py-4">
            <div className="mb-1.5 text-[13px] font-semibold text-ink-hi">Sunken well</div>
            <div className="font-mono text-[11px] text-ink-mut">.well · carved into the ground</div>
          </div>
        </div>
        <p className="mt-3 max-w-[60ch] text-[12.5px] text-ink-mut">
          The ground is a mid charcoal, so elevation actually reads — things lift off it or sink
          into it. Nothing is flat.
        </p>
      </section>

      {/* 02 — the tray -------------------------------------------------------- */}
      <section className="mt-12">
        <SectionHeading {...SECTIONS[1]} />
        <div className="tray px-3.5 pt-3.5 pb-3">
          <div className="flex pb-2.5">
            {[1, 2, 3, 4].map((b) => (
              <span key={b} className="flex-1 text-center">
                <b
                  className="inline-block rounded-md px-2.5 py-1 font-mono text-[11px] font-bold text-ink-hi"
                  style={{
                    backgroundImage: 'linear-gradient(180deg, #474b55, #383b43)',
                    boxShadow:
                      '0 1px 0 rgb(255 255 255 / 0.12) inset, 0 2px 4px rgb(0 0 0 / 0.4)',
                  }}
                >
                  {b}
                </b>
              </span>
            ))}
          </div>
          <div className="well relative py-2.5">
            <Lane string="A">
              <Block left="2%" width="12%" label="A" root />
              <Block left="50%" width="6%" label="E" />
            </Lane>
            <Lane string="G">
              <Block left="37%" width="6%" label="E" />
              <Block left="81%" width="6%" label="A" root />
            </Lane>
            <span
              className="absolute -top-1 -bottom-1 z-10 w-0.5 bg-brass"
              style={{ left: '47%', boxShadow: 'var(--shadow-glow-brass)' }}
            />
          </div>
        </div>
        <p className="mt-3 max-w-[60ch] text-[12.5px] text-ink-mut">
          A raised bezel around a sunken well. The exaggerated edge is what makes the grid read as
          one physical object rather than a drawing of one.
        </p>
      </section>

      {/* 03 — controls -------------------------------------------------------- */}
      <section className="mt-12">
        <SectionHeading {...SECTIONS[2]} />
        <div className="flex flex-wrap items-center gap-3">
          <Button accent>▶ Play</Button>
          <Button>Loop</Button>
          <Button>Count-in</Button>
          <div className="flex items-center gap-0.5">
            <Button>–</Button>
            <span className="px-3 font-mono text-[12px] font-bold text-ink-hi">80 BPM</span>
            <Button>+</Button>
          </div>
        </div>
        <p className="mt-3 max-w-[60ch] text-[12.5px] text-ink-mut">
          Press any of them — <code className="text-ink">.pressable</code> depresses on click. Same
          class drives note blocks, so the whole interface feels like one machine.
        </p>
      </section>

      {/* 04 — type ------------------------------------------------------------ */}
      <section className="mt-12">
        <SectionHeading {...SECTIONS[3]} />
        <div className="panel px-6 py-6">
          <div className="font-mono text-[10px] font-semibold tracking-[0.24em] text-ink-mut uppercase">
            Pattern · A Major
          </div>
          <div className="mt-2.5 font-display text-[34px] leading-none text-ink-hi">
            A major <em className="text-brass">arpeggio</em>
          </div>
          <div className="mt-3.5 font-mono text-[11px] font-semibold tracking-[0.06em] text-ink-mut">
            POS 5–12 · <b className="text-ink">7</b> NOTES · ♩=<b className="text-ink">80</b>
          </div>
          <p className="mt-4 max-w-[58ch] text-[13px] text-ink-mut">
            Fraunces for titles, monospace for anything numeric or label-like, system sans for prose.
            Body text is off-white, never pure white.
          </p>
        </div>
      </section>

      {/* 05 — palette --------------------------------------------------------- */}
      <section className="mt-12">
        <SectionHeading {...SECTIONS[4]} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Swatch name="Brass" varName="--color-brass" note="accent · roots, playhead, actions" />
          <Swatch name="Brass (light)" varName="--color-brass-hi" note="highlight / gradient top" />
          <Swatch name="Slate" varName="--color-slate" note="reserved · differentiator" />
          <Swatch name="Plum" varName="--color-plum" note="reserved · differentiator" />
          <Swatch name="Ground" varName="--color-ground" note="the base surface" />
          <Swatch name="Well" varName="--color-well" note="recessed grid interior" />
        </div>
        <p className="mt-4 max-w-[60ch] text-[12.5px] text-ink-mut">
          One accent does the work. Slate and plum are held back for when we need to tell things
          apart — tracks, categories, states.
        </p>
      </section>
    </main>
  );
}
