/**
 * AmpHead — the amp stage as an amp head, with its knobs on the control plate.
 *
 * Layout is guitar-tutor's `sound-design/AmpPanel`: a control plate across the top
 * carrying the model name, a power lamp and the knob row, over the amp's lower body.
 * Its materials are not — `#2a2a2a` tolex under a `#cfcfcf`→`#8a8a8a` brushed-chrome
 * plate is the warm-wood skin this project rejected, and its power LED is red.
 *
 * The one-to-one mapping onto our vocabulary is the whole reason this reshapes rather
 * than fights: `.tray` is documented as the raised bezel that makes its contents read as
 * sitting inside a physical container, which is exactly an amp head's shell; `.panel` is
 * the raised surface, which is the control plate; `.pressable` is every switch.
 *
 * POLARITY IS INVERTED ON PURPOSE. In the timeline, content sits down in a well and the
 * tray frames it. Here the plate stands *proud* of the shell and the vent below it
 * recesses. Same two materials, opposite arrangement — because that is the difference
 * between a thing you look into and a thing you reach for.
 *
 * Knobs are children: the descriptor table is the source of truth for what parameters
 * exist and what their ranges are, so this file must not know that an amp has a "Bass".
 */
import type { ReactNode } from 'react';
import { PowerLamp, ScoredGrille } from './RackFace';

export function AmpHead({
  model,
  enabled,
  power,
  children,
}: {
  /** Engraved on the plate. The model the chain would really build, not the raw id —
   *  the lib silently falls back to Plexi for an unknown one, and the plate has to say
   *  what will be heard. */
  model: string;
  enabled: boolean;
  /**
   * The power switch. Omitted = no switch, the way `RackUnit` omits one for always-on
   * stages; the lamp still reports `enabled`.
   *
   * One object rather than two props so the type makes the pairing mandatory: with a
   * handler but no label the button falls back to being named by its own content, and
   * "On" / "Off" is a name that changes when the value does.
   */
  power?: {
    /** Accessible name for the switch. Qualified by the caller ("Amp Enabled") because
     *  every stage's bypass is called the same thing and more than one is on screen. */
    readonly label: string;
    readonly onChange: (next: boolean) => void;
  };
  /** The knob row. */
  children?: ReactNode;
}) {
  return (
    // Bypassed is NOT dimmed. The tuning stays editable while a stage is out of the
    // chain — that is the point of bypass as against removal — and dropping opacity on
    // live controls costs contrast on text that is already muted. The lamp, the model
    // name's colour and the switch carry the state instead.
    <div className="tray flex flex-col gap-1.5 p-1.5">
      <div className="panel flex flex-col gap-1 px-2 py-1.5">
        <div className="flex items-center gap-2">
          {/* The serif face is the app's title voice, and a model name on a faceplate is
              the one piece of branding an amp has. */}
          <span
            className={`min-w-0 flex-1 truncate font-display text-[13px] leading-tight ${
              enabled ? 'text-ink-hi' : 'text-ink-mut'
            }`}
          >
            {model}
          </span>
          {power ? (
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              // Stable across the toggle on purpose. The visible word below is the
              // switch's *value*, not its label — `aria-checked` is what carries it to
              // assistive tech — and folding it into the name would make the accessible
              // name change every time the value did.
              aria-label={power.label}
              onClick={() => power.onChange(!enabled)}
              className="pressable control flex flex-none items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[9px] font-bold tracking-[0.1em] uppercase"
            >
              <PowerLamp lit={enabled} />
              {/* A word as well as a lamp: lit-versus-dark is a luminance cue, and the
                  state should not depend on seeing it. Not "Bypassed" — that word is the
                  rack's, for the stage; this one is the amp's, for its power. */}
              <span aria-hidden>{enabled ? 'On' : 'Off'}</span>
            </button>
          ) : (
            <PowerLamp lit={enabled} />
          )}
        </div>
        <div className="flex flex-wrap items-start justify-center gap-x-3 gap-y-1 py-1">
          {children}
        </div>
      </div>
      {/* The lower body: the recess the plate stands out of. */}
      <div className="well relative h-5 overflow-hidden rounded-lg">
        <ScoredGrille count={30} />
      </div>
    </div>
  );
}
