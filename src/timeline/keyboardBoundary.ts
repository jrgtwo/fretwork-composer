/**
 * Where a global keyboard shortcut stops.
 *
 * Two window key handlers sit over the same surfaces — this folder's
 * `NoteSurface` and the arrangement's `useArrangementGestures` — and both have
 * to ignore a keystroke that a local control is already answering. The test is
 * pure DOM, so it lives here rather than in either component: a second copy of
 * the selector is exactly what shipped the bug it fixes, and a predicate in a
 * component file cannot be shared without a fast-refresh escape hatch.
 */

/**
 * Every element that owns the arrow keys for itself.
 *
 * ⚠ THE TWO CUSTOM ROLES ARE THE POINT. Until milestone 3 this list was the
 * literal `'input, textarea, select, [contenteditable]'`, written out twice —
 * once in each handler — and neither copy covered the voice editor's dials.
 * `Knob` is `role="slider"` and `ParamEncoder` is `role="spinbutton"`
 * (deliberately not a slider: an endless encoder has no min or max, and ARIA
 * 1.2 gives `slider` an implicit 0–100 — see that file's header). Both are
 * `div`s, so neither matched, and ArrowUp over a dial ALSO transposed a
 * placement or nudged a note. Header controls are on screen in every view, so
 * gating on the selected view cannot fix that; only the boundary test can.
 *
 * A `select` counts for the original reason: arrows are how you change one.
 */
const KEYBOARD_CONTROL_SELECTOR =
  'input, textarea, select, [contenteditable], [role="slider"], [role="spinbutton"]';

/**
 * Whether a key event was aimed INSIDE a control that answers arrows itself.
 *
 * `closest`, not `matches`, and that is a widening. The old test only caught an
 * event whose target WAS the control; a composite widget that puts focus on a
 * child — or any keystroke bubbling out of a `[contenteditable]`'s inner
 * markup — walked straight past it. What has to be ignored is everything inside
 * the boundary, not just its root.
 *
 * A null or non-Element target answers false: `window` itself is where a
 * keystroke with nothing focused lands, and that one IS ours.
 */
export function insideKeyboardControl(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(KEYBOARD_CONTROL_SELECTOR) !== null;
}
