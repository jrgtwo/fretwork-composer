/**
 * One "pick from a registry" voice parameter — the amp model, the cabinet IR and the
 * sample pack all funnel through here.
 *
 * A native `<select>`, for the same reason `ParamSlider` uses a native range: it is
 * keyboard- and screen-reader-complete out of the box, and it collapses a nine-entry
 * registry into one row of a pane that has three other sections to fit.
 *
 * Two things the plain element cannot do, handled here:
 *
 *   - **No match.** Presets store a cabinet *URL* and a note→URL *map*, not registry
 *     ids, so the current value can be something the registry has never heard of (a
 *     variant Sound Lab wrote with a custom IR). `value === null` renders a disabled
 *     placeholder as the selection instead of silently showing whichever option
 *     happened to be first — a select that lies about what is loaded is worse than one
 *     that admits it doesn't know.
 *   - **Description.** The registries carry a sentence per entry that is the whole
 *     reason a picker is more useful than an id, but `<option>` renders no children.
 *     So the selected entry's description goes underneath, the way Sound Lab does it.
 */

export interface EnumChoice {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

export function ParamEnum({
  id,
  label,
  value,
  options,
  onChange,
  badgeOf,
  placeholder = 'Not in the registry',
}: {
  id: string;
  label: string;
  /** `null` when the preset's value matches no option. */
  value: string | null;
  options: readonly EnumChoice[];
  onChange: (value: string) => void;
  /** Extra word after an option's label — the amp model's category. */
  badgeOf?: (value: string) => string | undefined;
  placeholder?: string;
}) {
  // The `?? null` is defensive rather than reachable: both descriptors' `resolve` return
  // either one of their own option values or `null`, so a value that misses is a bug in a
  // future descriptor — and the right answer to that is still the placeholder, not the
  // first option.
  const selected = value === null ? null : (options.find((o) => o.value === value) ?? null);

  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-2">
        <label
          htmlFor={id}
          className="w-[74px] flex-none font-mono text-[9px] tracking-[0.1em] text-ink-mut uppercase"
        >
          {label}
        </label>
        <select
          id={id}
          value={selected ? selected.value : ''}
          onChange={(event) => onChange(event.currentTarget.value)}
          className="control pressable min-w-0 flex-1 rounded-lg px-1.5 py-1 font-mono text-[10px]"
        >
          {selected === null && (
            <option value="" disabled>
              {placeholder}
            </option>
          )}
          {options.map((option) => {
            const badge = badgeOf?.(option.value);
            return (
              <option key={option.value} value={option.value}>
                {badge ? `${option.label} · ${badge}` : option.label}
              </option>
            );
          })}
        </select>
      </div>
      {selected?.description ? (
        // Not `aria-describedby` on the select: the description belongs to the chosen
        // option, not to the control, and it changes under the user as they browse.
        <p className="pl-[82px] font-mono text-[9px] leading-snug text-ink-mut">
          {selected.description}
        </p>
      ) : null}
    </div>
  );
}
