/**
 * The chrome the two voice surfaces share — the half of it that is not a
 * component (those are `DirtyPill.tsx` and `NameForm.tsx`, beside this).
 *
 * `VoicePane` (the pattern page) and `VoiceRail` (the composition page) are two
 * different pickers over the same library: one addresses the editing PATTERN, the
 * other one TRACK, and that half of them is deliberately separate — the seams
 * differ, the refusals differ, and the wording that explains them differs. What
 * does NOT differ is the furniture: the button skin, the unsaved pill, and the
 * name form with its focus-return.
 *
 * Kept here rather than copied because the copies were byte-identical, and the
 * failure mode of two copies is not drift in the classes — it is one of them
 * quietly losing the focus-return in {@link useNameForm}, which nothing looking at
 * a screenshot would ever notice.
 */
import { useRef, useState, type MouseEvent } from 'react';
import type { VoiceRefusal } from './voiceService';

export const voiceButtonClass =
  'pressable control flex-none rounded-lg px-2 py-1 font-mono text-[9px] font-bold tracking-[0.06em] uppercase disabled:cursor-not-allowed disabled:opacity-40';

export const voiceLabelClass = 'font-mono text-[9px] tracking-[0.1em] text-ink-mut uppercase';

/**
 * The four refusals that say the same thing wherever they are raised.
 *
 * `no-voice` and `built-in` are deliberately NOT here: both name the holder in
 * their sentence ("this pattern" / "this track follows its instrument's voice"),
 * so a shared wording could only be vaguer than either. Each surface declares a
 * complete `Record` of its own union on top of this, which is what makes a new
 * refusal a compile error in both places rather than a missing sentence in one.
 */
export const SHARED_VOICE_REFUSAL_TEXT: Readonly<
  Pick<Record<VoiceRefusal, string>, 'no-pattern' | 'unknown-variant' | 'empty-name' | 'capped'>
> = {
  'no-pattern': 'No pattern is open.',
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
