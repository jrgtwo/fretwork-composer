/**
 * The chrome the two voice surfaces share — the half of it that is not a
 * component (those are `DirtyPill.tsx` and `NameForm.tsx`, beside this).
 *
 * ⚠ THE EDITOR IS ONE COMPONENT NOW — `VoiceEditor`, rendered by `VoicePane` for
 * the editing PATTERN and by `TrackVoiceRack` for one TRACK. What is left in here
 * is what the two WRAPPERS still decide between them: the refusal wording that
 * names their own holder, the knob sizes their width allows, and the furniture
 * both sides of the merge brought — the unsaved pill, the name form with its
 * focus-return, and the window a `<select>`'s writes are collected in.
 *
 * The BUTTON SKIN is the one piece the editor no longer takes: it draws its own
 * denser class, because `voiceButtonClass` was sized for the 300 px rail the
 * saving buttons came from. It stays here for `NameForm` and for `VoicePane`'s
 * own chrome, which are that size.
 *
 * `VoiceRail` is only a list: saving moved into the editor's header, where the
 * knobs that made the edit are, so the rail takes `SHARED_VOICE_REFUSAL_TEXT`
 * alone.
 *
 * Kept here rather than copied because the copies were byte-identical, and the
 * failure mode of two copies is not drift in the classes — it is one of them
 * quietly losing the focus-return in {@link useNameForm}, which nothing looking at
 * a screenshot would ever notice.
 */
import { useRef, useState, type MouseEvent } from 'react';
import type { VoiceRefusal } from './voiceService';

/**
 * How long a `<select>`'s voice pick waits before it is written.
 *
 * A native `<select>` fires `change` once per arrow key while closed, so a keyboard
 * user stepping the eleven guitar voices passes through all of them. Ten of those
 * slots are sampler-sourced, and once the page has played, every one of those
 * writes reaches `MultiTrackPlayback.setTrackVoice` — a whole new `Voice`, one
 * `Tone.Sampler` and an HTTP load per bank, with the outgoing one held alive on a
 * 4 s release tail. One arrow-key walk is a fetch storm.
 *
 * PERMANENT ADAPTER, not a masked lib gap: the lib cannot know it is behind a
 * `<select>`. It lives in the GESTURE and not in the seam — `voiceService.selectVoice`
 * writes on the call, so the agent is never debounced and one command stays one undo
 * step. A list of BUTTONS needs no such window, which is why `VoiceRail` has none:
 * arrowing through buttons moves focus and commits nothing.
 *
 * THREE `<select>`s share it — the editor header's picker, `TrackControls`' compact
 * one, and whatever comes next. It was a private const in `TrackControls` until the
 * second one appeared; one exported const is what stops two windows drifting into
 * two different answers to the same gesture. Rowed as permanent adapter work in
 * `docs/FOLLOW-UPS.md`.
 */
export const VOICE_COMMIT_MS = 120;

/**
 * Knob diameters, in px — the two sizes `VoiceEditor` draws its stages at.
 *
 * ⚠ NAMED FOR WHAT DECIDES THEM — the WIDTH the editor has been given — and not
 * for the page it is on. A rack lane has to fit eight amp knobs plus a cabinet
 * and a level stage across one track's row; the Instrument & Amp pane has a
 * whole pane's column, which is what `Knob`'s and `ParamEncoder`'s own 56 px
 * default was drawn for. ONE RULE, passed in as a prop: a renderer that asked
 * which page it was on would be the branch the merged editor exists to delete,
 * and two per-page constants inside it would be that branch spelled differently.
 */
export interface KnobScale {
  /** The amp plate's knobs, which are the largest thing on any stage. */
  readonly amp: number;
  /** Everything else — cabinet, pedals, source, level, and every encoder. */
  readonly small: number;
}

/** One track's row of the arrangement, where up to eight racks are stacked. */
export const LANE_KNOB_SCALE: KnobScale = { amp: 42, small: 38 };

/** A whole pane column, with one holder on the page. */
export const PANE_KNOB_SCALE: KnobScale = { amp: 56, small: 56 };

export const voiceButtonClass =
  'pressable control flex-none rounded-lg px-2 py-1 font-mono text-[9px] font-bold tracking-[0.06em] uppercase disabled:cursor-not-allowed disabled:opacity-40';

export const voiceLabelClass = 'font-mono text-[9px] tracking-[0.1em] text-ink-mut uppercase';

/**
 * The three refusals that say the same thing wherever they are raised.
 *
 * `no-holder`, `no-voice` and `built-in` are deliberately NOT here, and for two
 * reasons rather than one. `no-holder` and `no-voice` name the holder in their
 * sentence ("no pattern is open" / "this track follows its instrument's voice"),
 * and only the surface knows which holder it is; `no-holder` was the fourth member
 * until the refusal union merged `no-pattern` and `no-track`, and one code for both
 * kinds means one shared sentence would have to say "no holder", which is not
 * something to show anyone. `built-in` names no holder — it is here for the other
 * reason: the two surfaces word it differently, the pane keeping Sound Lab's
 * shipped sentence verbatim, and unifying them would silently reword shipped copy.
 *
 * Each WRAPPER declares a complete `Record` of the union on top of this and hands
 * it to `VoiceEditor`, which is what makes a new refusal a compile error in both
 * places rather than a missing sentence in one. `VoiceRail` declares none: the only refusal a list of
 * buttons can raise is `unknown-variant`, which is here.
 */
export const SHARED_VOICE_REFUSAL_TEXT: Readonly<
  Pick<Record<VoiceRefusal, string>, 'unknown-variant' | 'empty-name' | 'capped'>
> = {
  'unknown-variant': 'That voice is no longer in your library.',
  'empty-name': 'Give the variant a name.',
  capped: 'Your plan’s variant limit has been reached.',
};

export interface NameFormState {
  readonly mode: 'save-as' | 'rename';
  readonly value: string;
}

/**
 * The open/close half of the name form, with the focus-return that is the whole
 * reason it is worth extracting.
 *
 * The form takes focus when it opens (`autoFocus`) and then deletes itself, so
 * without the remembered opener a keyboard user who presses Create or Cancel lands
 * on `<body>`. Focus goes back to whichever button opened it — the same place a
 * dialog would return it.
 *
 * `close` is only for the form's OWN buttons: a switch that happens to close the
 * form has already moved focus somewhere the user chose, so those call `setForm`
 * instead.
 */
export function useNameForm() {
  const [form, setForm] = useState<NameFormState | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);

  const open =
    (mode: NameFormState['mode'], value: string) => (event: MouseEvent<HTMLButtonElement>) => {
      opener.current = event.currentTarget;
      setForm({ mode, value });
    };

  const close = () => {
    setForm(null);
    opener.current?.focus();
  };

  return { form, setForm, open, close } as const;
}
