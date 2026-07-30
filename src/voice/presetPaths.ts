/**
 * Immutable deep get / set / remove over a `VoicePreset`, addressed by dotted path.
 *
 * The voice editor is a descriptor table (`paramSchema.ts`), so every control needs
 * to read and write one field of a deeply-`readonly` preset without knowing its
 * shape. That is the whole reason these live here rather than as hand-written
 * spreads at each call site.
 *
 * Three properties the callers depend on:
 *
 *   - Absent branches are CREATED on write. Several built-in presets ship with no
 *     `effects` object at all (`ACOUSTIC_GUITAR_PRESET`), so "switch the amp
 *     section on" is a write into a branch that does not exist yet.
 *   - The input is never mutated. The working copy in `App` is React state.
 *   - An unchanged write returns the SAME reference, all the way up. The lib's own
 *     pattern ops behave this way and the editor's dirty check relies on it — a
 *     slider that reports its current value must not mark the preset dirty.
 *
 * Deliberately generic over the root object rather than typed to `VoicePreset`:
 * it is pure structure walking with no musical knowledge, which keeps it unit
 * testable against plain objects and free of any lib import.
 *
 * NOT type-safe in the value: a dotted string cannot be checked against the shape
 * it addresses, so `setAtPath(preset, path, value)` returns `VoicePreset` on trust.
 * The descriptor table is the contract that keeps paths and value kinds in step,
 * and `paramSchema.test.ts` is what enforces it.
 */

type Branch = Record<string, unknown>;

/** Arrays are leaves here — `source.samples` is a value to replace, not a branch
 *  to descend into or spread. */
const isBranch = (value: unknown): value is Branch =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const segmentsOf = (path: string): readonly string[] => path.split('.');

/** Shallow copy minus one key. Written out rather than rest-destructured so the
 *  omitted binding doesn't have to be named and then linted around. */
function omitKey(branch: Branch, key: string): Branch {
  const next: Branch = {};
  for (const k of Object.keys(branch)) {
    if (k !== key) next[k] = branch[k];
  }
  return next;
}

/**
 * Read the value at `path`. Returns `undefined` when any segment is missing, and
 * also when a segment resolves to a non-branch (so `level.pan.nope` is undefined
 * rather than a throw) — absent and un-navigable are the same thing to a control
 * that has to render a fallback either way.
 */
export function getAtPath(root: unknown, path: string): unknown {
  let node: unknown = root;
  for (const segment of segmentsOf(path)) {
    if (!isBranch(node)) return undefined;
    node = node[segment];
  }
  return node;
}

/**
 * True when `path`'s own key exists, even if its value is `undefined`.
 *
 * KEY presence only — this is NOT the section-presence test. `hasBranchAtPath` is
 * that, because the lib's own presets emit `effects: CAB ? {...} : undefined` and
 * `cabIR: getCabinetIR(id) ? {...} : undefined`, so a key can exist with an
 * `undefined` value and the section is nonetheless absent. Use this one only when
 * the question really is "was this key written", e.g. distinguishing an optional
 * field the author omitted from one they set to `undefined`.
 */
export function hasPath(root: unknown, path: string): boolean {
  const segments = segmentsOf(path);
  let node: unknown = root;
  for (const segment of segments.slice(0, -1)) {
    if (!isBranch(node)) return false;
    node = node[segment];
  }
  const last = segments[segments.length - 1];
  return isBranch(node) && Object.prototype.hasOwnProperty.call(node, last);
}

/**
 * True when the value at `path` is a navigable branch — a non-null object, arrays
 * included. This is what "the section is present" means: `ParamSection.presenceProbe`
 * is evaluated with this, not with `hasPath`. See `hasPath`'s note for why the two
 * differ on the presets the lib actually ships.
 */
export function hasBranchAtPath(root: unknown, path: string): boolean {
  const value = getAtPath(root, path);
  return typeof value === 'object' && value !== null;
}

/** `Object.is(-0, 0)` is false, so a control that lands on `-0` (a pan fader
 *  crossing centre) would otherwise report an edit and mark the preset dirty with
 *  nothing changed. Normalising on both sides of the comparison — and on the way in,
 *  since `-0` in a preset is noise — keeps "unchanged" meaning unchanged. */
const normalizeZero = (value: unknown): unknown => (Object.is(value, -0) ? 0 : value);

function setIn(node: Branch | undefined, segments: readonly string[], value: unknown): Branch {
  const [head, ...rest] = segments;
  const base = node ?? {};

  if (rest.length === 0) {
    const next = normalizeZero(value);
    const unchanged =
      node !== undefined &&
      Object.prototype.hasOwnProperty.call(node, head) &&
      Object.is(normalizeZero(node[head]), next);
    return unchanged ? node : { ...base, [head]: next };
  }

  // Arrays are leaves. Spreading one into an object silently turns `[bank0, bank1]`
  // into `{0: …}` and drops every bank the write didn't name, which for
  // `source.samples` is inaudible data loss. A path that descends into an array
  // contradicts the schema, so it fails loudly rather than corrupting the preset.
  if (Array.isArray(base[head])) {
    throw new Error(`setAtPath: "${head}" is an array leaf and cannot be descended into`);
  }

  // A non-array non-branch standing where we need to descend is overwritten — that
  // only happens if a path contradicts the schema, and silently widening a scalar
  // into an object is less surprising than throwing mid-edit.
  const child = isBranch(base[head]) ? base[head] : undefined;
  const nextChild = setIn(child, rest, value);
  if (node !== undefined && nextChild === child) return node;
  return { ...base, [head]: nextChild };
}

/**
 * Return a copy of `root` with `path` set to `value`, creating any missing
 * intermediate branches. Returns `root` itself when the value is already there.
 */
export function setAtPath<T extends object>(root: T, path: string, value: unknown): T {
  return setIn(root as Branch, segmentsOf(path), value) as T;
}

function removeIn(node: Branch, segments: readonly string[]): Branch {
  const [head, ...rest] = segments;
  if (!Object.prototype.hasOwnProperty.call(node, head)) return node;

  if (rest.length === 0) return omitKey(node, head);

  const child = node[head];
  if (!isBranch(child)) return node;

  const nextChild = removeIn(child, rest);
  if (nextChild === child) return node;
  // Prune a branch that just went empty, so removing the only effect leaves a
  // preset genuinely without `effects` rather than a hollow `effects: {}`. The
  // editor treats absent as "offer to add", and `{}` would read as absent to the
  // audio chain but as a change to a deep-equal dirty check.
  return Object.keys(nextChild).length === 0 ? omitKey(node, head) : { ...node, [head]: nextChild };
}

/**
 * Return a copy of `root` with `path` (and any ancestor left empty by the
 * removal) deleted. Returns `root` itself when `path` was already absent. This is
 * how a section goes back to ABSENT, as opposed to `enabled: false`, which keeps
 * the user's tuning around for when they switch it back on.
 */
export function removeAtPath<T extends object>(root: T, path: string): T {
  return removeIn(root as Branch, segmentsOf(path)) as T;
}
