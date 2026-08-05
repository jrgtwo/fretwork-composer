/** Brass marks unsaved, the way it marks every other live state in the app.
 *  Announced rather than only coloured — an edit that exists only as a colour is
 *  one a user cannot confirm they made. Shared by `VoicePane` and `VoiceRail`. */
export function DirtyPill({ dirty }: { dirty: boolean }) {
  return (
    <span
      className={`flex items-center gap-1 font-mono text-[9px] tracking-[0.1em] uppercase ${
        dirty ? 'text-brass-hi' : 'text-ink-mut'
      }`}
    >
      <i
        aria-hidden
        className={`h-1.5 w-1.5 rounded-full ${dirty ? 'bg-brass-hi' : 'bg-line-hi'}`}
      />
      {dirty ? 'Unsaved' : 'Saved'}
    </span>
  );
}
