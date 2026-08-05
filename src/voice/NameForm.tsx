import { voiceButtonClass, voiceLabelClass, type NameFormState } from './voiceChrome';

/**
 * One line: a label, a text field, and the two buttons that end it — the naming
 * step of Save as… and Rename, shared by `VoicePane` and `VoiceRail`.
 *
 * `inputId` is a prop rather than a constant because the two surfaces can be
 * mounted at once — the composition page's rail and a pattern pane behind a route
 * change — and two `<input id="voice-name">` on one document is a label pointing
 * at whichever came first.
 *
 * The focus-return that makes Create and Cancel survivable for a keyboard user
 * lives in `useNameForm`, not here: this component deletes itself on submit, so it
 * is the wrong place to remember where focus should land.
 */
export function NameForm({
  form,
  inputId,
  className = '',
  onChange,
  onSubmit,
  onCancel,
}: {
  form: NameFormState;
  inputId: string;
  /** Where the line sits in its host — the rail insets it, the pane's parent
   *  already does. Spacing only; nothing about the line itself. */
  className?: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
      className={`flex flex-none items-center gap-1.5 ${className}`}
    >
      <label htmlFor={inputId} className={`flex-none ${voiceLabelClass}`}>
        {form.mode === 'save-as' ? 'New name' : 'Rename'}
      </label>
      <input
        id={inputId}
        autoFocus
        value={form.value}
        onChange={(event) => onChange(event.currentTarget.value)}
        className="well min-w-0 flex-1 px-1.5 py-1 font-mono text-[10px] text-ink"
      />
      <button type="submit" className={voiceButtonClass}>
        {form.mode === 'save-as' ? 'Create' : 'Apply'}
      </button>
      <button type="button" onClick={onCancel} className={voiceButtonClass}>
        Cancel
      </button>
    </form>
  );
}
