/**
 * The seam between the app and `@fretwork/lib`'s pattern store.
 *
 * Components call this, never `usePatternsStore` directly. That keeps four
 * things contained to one file:
 *   - the store is a module singleton that persists to sessionStorage, so tests
 *     and any future multi-pattern UI need one place to control it;
 *   - it carries a lot we don't use (collections, placements, chord buffering,
 *     pre-roll), which shouldn't leak into components;
 *   - its shape can change between lib versions;
 *   - the agent's tools will need exactly this surface, and must reach the same
 *     code path as the UI rather than a parallel one.
 *
 * Everything below delegates to the lib's ops, which already enforce the rules
 * we care about — no same-string overlap, duration clamped against the next
 * note, and pattern length auto-fitted to content on every edit.
 */
import { useSyncExternalStore } from 'react';
import {
  CHROMATIC_KEYS,
  DEFAULT_INSTRUMENT_ID,
  DEFAULT_SCALE_ID,
  DYNAMIC_VELOCITY,
  GROOVE_PRESETS,
  INSTRUMENTS,
  PPQ,
  SCALES,
  getInstrument,
  getTuning,
  noteAt,
  parseChordSymbol,
  pitchClass,
  presetMatching,
  usePatternsStore,
  selectEditingPattern,
  voiceChordPreferred,
  type DynamicMark,
  type EventDragSnapshot,
  type FretInstrumentId,
  type GroovePreset,
  type GroovePresetId,
  type Pattern,
  type PatternEvent,
  type Tick,
} from '@fretwork/lib';
// A real subpath export, and the only way in: the import pipeline is not on the
// lib's root barrel. It is reached from HERE and nowhere else for this file's
// stated reason, and because `src/ai/**` may not import the lib at all — the
// agent-facing wrapper has to come through this seam.
import {
  ImportValidationError,
  LIMITS,
  mapImportToLibrary,
  validateImportIR,
  type ImportIR,
  type MapTopology,
  type ValidationResult,
} from '@fretwork/lib/import';
import { createHistory } from './history';
import { toPitchPatch, type NotePitch } from './articulations';

/**
 * Ticks per quarter note — the unit every `Tick` in this seam is counted in.
 *
 * Re-exported rather than imported from the lib at each call site for the same
 * reason `listInstruments` reads the lib's catalog: a caller that has to reach
 * past the seam for the meaning of the numbers the seam takes is a caller with
 * two dependencies instead of one. It matters most for the agent's tools, whose
 * schema descriptions have to state what a tick IS.
 */
export { PPQ };

/**
 * The document {@link importIR} takes, re-exported for {@link PPQ}'s reason: a
 * caller that has to reach past the seam for the TYPE of the thing the seam takes
 * has two dependencies instead of one — and the agent-facing wrapper, which may
 * not import the lib at all, could not name it any other way.
 */
export type { ImportIR, MapTopology };

type SelectionMode = 'replace' | 'add' | 'toggle';

/**
 * Every write that can be refused reports it rather than throwing or silently
 * doing nothing.
 *
 * Declared HERE and re-exported by `compositionService` so the two seams return
 * ONE type rather than two structurally identical ones that drift; the module
 * dependency already runs this way (`compositionService` imports this file,
 * nothing imports back).
 *
 * AG-04 is why it exists on this side at all. The lib's pattern ops return the
 * pattern UNCHANGED when they decline — a stamp onto an occupied string, a move
 * that would overlap, an unknown event id — and the store then writes nothing.
 * A pointer-driven caller can see that on screen; the agent cannot, and "it did
 * nothing" is the one refusal that cannot be recovered from.
 */
export type Result<T = void> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const refuse = (reason: string): Result<never> => ({ ok: false, reason });

/** The lib exports `EventDragSnapshot` but not its resize counterpart, so the
 *  shape is mirrored here. Structural typing makes it interchangeable. */
interface EventResizeSnapshot {
  readonly id: string;
  readonly durationTicks: Tick;
}

const store = () => usePatternsStore.getState();

// ---------------------------------------------------------------- reading ---

/** React hook: the pattern currently being edited, or null. */
export function useEditingPattern(): Pattern | null {
  return usePatternsStore(selectEditingPattern);
}

/** React hook: ids of the currently selected events. */
export function useSelectedIds(): string[] {
  return usePatternsStore((s) => s.selectedEventIds);
}

/** Non-reactive read — for event handlers and tests. */
export function getEditingPattern(): Pattern | null {
  return selectEditingPattern(usePatternsStore.getState());
}

export function getSelectedIds(): string[] {
  return store().selectedEventIds;
}

export function findEvent(id: string): PatternEvent | undefined {
  return getEditingPattern()?.events.find((e) => e.id === id);
}

/**
 * Every pattern in the library — the source the composition page's rail places
 * from (CP-05).
 *
 * It lives HERE and not in `compositionService` even though only the arranger
 * reads it: `library.patterns` is the pattern store, and a second module
 * reaching into it is how a seam stops being one. The arranger asks the pattern
 * seam for patterns and the composition seam for placements, which is also the
 * split the agent's tools will want.
 *
 * Returned as the store's own array, so the reference is stable until the
 * library actually changes and a subscriber only re-renders when it does.
 *
 * `BUILTIN_PATTERNS` is deliberately not merged in. The rail is a view of what
 * the user has written; the built-ins are a catalog, and listing a catalog
 * needs the folder tree that `library.collections` is for — explicitly deferred
 * by CP-05's "out of scope".
 */
export function useLibraryPatterns(): readonly Pattern[] {
  return usePatternsStore((s) => s.library.patterns);
}

export function getLibraryPatterns(): readonly Pattern[] {
  return store().library.patterns;
}

export function findLibraryPattern(id: string): Pattern | undefined {
  return getLibraryPatterns().find((pattern) => pattern.id === id);
}

/**
 * `Pattern.instrumentId` is a free-form string; everything downstream of it —
 * the voice builder, the tuning list, the fretboard's `InstrumentDef` — is not.
 *
 * One resolver for the whole app on purpose: the audio engine and any view that
 * draws a neck have to agree on how many strings the pattern has, or notes on
 * the strings the other one doesn't believe in vanish without a trace.
 *
 * Membership is asked of the lib's catalog rather than listed here. The list would
 * match today, but `FretInstrumentId` and `INSTRUMENTS` are grown together on the
 * lib side ("add an entry here … the renderer + UI pick up the new instrument
 * automatically"), so a fourth instrument would otherwise be silently coerced to
 * guitar — which then reads as the pattern being on the wrong neck.
 */
export function patternInstrumentId(pattern: Pattern): FretInstrumentId {
  return getInstrument(pattern.instrumentId) !== undefined
    ? (pattern.instrumentId as FretInstrumentId)
    : DEFAULT_INSTRUMENT_ID;
}

/**
 * The instruments a pattern can be on, for a picker.
 *
 * Read from the lib's catalog rather than listed here for the same reason
 * `patternInstrumentId` asks the catalog about membership: `INSTRUMENTS` and
 * `FretInstrumentId` are grown together on the lib side, and a hardcoded list would
 * silently omit a fourth instrument the moment one lands.
 */
export function listInstruments(): readonly { id: FretInstrumentId; name: string }[] {
  return INSTRUMENTS.map((instrument) => ({
    id: instrument.id as FretInstrumentId,
    name: instrument.name,
  }));
}

/**
 * A feel a pattern or composition can be set to, by id.
 *
 * The lib's `GROOVE_PRESETS` is the list, and `GrooveSpec` — a `swing` in
 * [0.5, 0.75] plus which subdivision it applies to — is the value. Only the
 * NAMED presets are offered: `presetMatching` calls anything else `'custom'`,
 * and a caller inventing swing numbers is exactly the free-text-instead-of-lib-
 * type mistake the agent's schemas exist to prevent. A control that genuinely
 * needs an arbitrary swing can take `GrooveSpec` when one appears.
 */
export type GrooveId = GroovePreset['id'];

export function listGrooves(): readonly { id: GrooveId; name: string }[] {
  return GROOVE_PRESETS.map((preset) => ({ id: preset.id, name: preset.label }));
}

/**
 * The vocabulary of `Pattern.key` and `Pattern.scaleType` — the two fields the
 * lib documents as "a note name like 'A', 'C#'" and "a scale id (e.g. 'major',
 * 'minor-pentatonic')".
 *
 * Here for exactly `listInstruments`' and `listGrooves`' reason and no other:
 * these are lib catalogs that grow on the lib side, and a caller that wrote the
 * twelve note names or the twelve scale ids out by hand would silently omit
 * whatever is added next while still type-checking. Nothing in this app EDITS
 * key or scale yet (`FretboardView` says so) — AG-05's command catalog is the
 * first caller, and it needs the offered values to come from the lib rather than
 * from a literal beside the slot, which is the one thing its tripwire checks.
 *
 * Reads no store, so it is safe to call before a pattern exists.
 */
export function listKeys(): readonly string[] {
  return CHROMATIC_KEYS;
}

export function listScales(): readonly { id: string; name: string }[] {
  return SCALES.map((scale) => ({ id: scale.id, name: scale.name }));
}

/** The scale a picker opens on when nothing has been chosen — the lib's own. */
export { DEFAULT_SCALE_ID };

/**
 * What to say about a neck this app has not got, written ONCE.
 *
 * The seam authors refusal text and a tool passes it verbatim (`fromResult` in
 * `src/ai/tools/types.ts` argues why). `read_chord_voicings` checks membership
 * up front — once for the whole call rather than once per symbol — so without
 * this the same sentence would be authored on both sides of the seam and drift
 * the first time either is reworded.
 */
export function unknownInstrumentRefusal(instrumentId: string): string {
  return `"${instrumentId}" is not an instrument this app has a neck for — ${listInstruments()
    .map((known) => known.id)
    .join(', ')}.`;
}

/**
 * Where a named chord sits on a NAMED instrument's neck — a read, and only a
 * read.
 *
 * Beside `listKeys`/`listScales` for their reason: it re-exports a lib catalog
 * (here `parseChordSymbol` + `voiceChordPreferred`) so a caller does not have to
 * reach past the seam for it. AG-09 is why it exists at all — a caller working
 * by value has to compute every fret of a twelve-bar progression by hand, and
 * that arithmetic is what a run gets wrong long before its musical judgement
 * does.
 *
 * It hands back the VOICING and not the tuning, deliberately. The tuning list
 * would let a caller voice chords itself, which is the lib's job done twice and
 * differently; and the agent's tools cannot reach the lib at all
 * (`tests/AgentTools.test.ts`'s seam tripwire), so a grip is the only shape this
 * answer can take on that side of the wall.
 *
 * ⚠ THE INSTRUMENT IS AN ARGUMENT, not the open pattern's. It used to be read
 * off whatever pattern happened to be open, and that is the defect the
 * 2026-08-11 run died of: three patterns opened up front, the same symbols asked
 * three times expecting one answer per neck, and every answer for the ukulele
 * because only the last-opened pattern is the open one. Identical arguments and
 * a different answer is a shape no caller — and no loop detector, which reads
 * arguments alone — can tell apart. Naming the neck in the call also means a
 * caller can ask what a chord looks like on a bass BEFORE it has created
 * anything, which is what a planning step wants.
 *
 * ⚠ The tuning is the instrument's DECLARED DEFAULT, resolved through
 * `getTuning` — the same convention `reference/tabLayout.ts`'s `openStrings`
 * uses, and for its reason: this grip has to agree with the string labels and
 * note names already on screen. `getTuningsForInstrument(id)[0]` agrees with
 * that only because of the order `TUNINGS` happens to be written in. Nothing in
 * this app owns instrument/tuning/capo yet (docs/FOLLOW-UPS.md §3), so a chord
 * asked for here is a chord on the instrument's default tuning and there is no
 * other answer to give.
 *
 * `stringIndex` is `PatternEvent.stringIndex` — 0 is the physically lowest
 * string — because `TuningDef.strings`, which the voicer indexes, is in that
 * same bottom-to-top order. No remapping, and no cell on a string this
 * instrument has not got.
 */
export function chordGrip(
  symbol: string,
  instrumentId: string,
): Result<{
  symbol: string;
  root: string;
  type: string;
  notes: readonly string[];
  cells: readonly { stringIndex: number; fret: number }[];
}> {
  // The INSTRUMENT first, because it is the call-wide fact and the symbol is the
  // per-item one: a caller that named a neck this app has not got should hear
  // about the neck, not about the first chord in its progression.
  //
  // Membership is asked of the lib's catalog, `patternInstrumentId`'s reason: a
  // list written here would go on refusing whatever the lib added last. Unlike
  // `patternInstrumentId` there is no falling back to guitar — a caller that
  // named the wrong neck wants to hear so, not to be handed a guitar's frets
  // under a bass's name.
  const instrument = getInstrument(instrumentId);
  if (instrument === undefined) return refuse(unknownInstrumentRefusal(instrumentId));

  const chord = parseChordSymbol(symbol);
  if (chord === null) {
    return refuse(
      `"${symbol}" is not a chord symbol this app can read. Write it as a root and a quality — "A7", "Cmaj7", "F#m", "G/B".`,
    );
  }

  // The TUNING is the half that can still go missing, when a lib version adds an
  // instrument before its tunings.
  const tuning = getTuning(instrument.defaultTuningId);
  if (tuning === undefined) {
    return refuse(
      `${instrumentId} has no tuning in the catalog, so there is nothing to voice ${chord.symbol} against.`,
    );
  }

  const grip = voiceChordPreferred(chord, tuning);
  if (grip === null) {
    return refuse(
      `${chord.symbol} cannot be voiced on ${instrumentId} in ${tuning.name} — no shape reaches all of ${chord.notes.join(', ')} within one hand span. Try a simpler quality, or write the notes yourself.`,
    );
  }

  // Belt and braces. Every tuning in the catalog is as wide as its instrument
  // today, so this drops nothing and neither branch below is reachable — but a
  // mismatch would put a note on a string that is drawn by nothing and played by
  // nothing, which is exactly the failure `checkString` exists to make
  // impossible from the write side. What the trim must NOT do is hand back an
  // empty shape as an answer: `ok` with no cells is the reply a caller cannot
  // act on, so a grip that survives none of it is a refusal.
  const strings = instrument.stringCount;
  const cells = grip.cells
    .filter((cell) => cell.stringIndex < strings)
    .map((cell) => ({ stringIndex: cell.stringIndex, fret: cell.fret }));
  if (cells.length === 0) {
    return refuse(
      `${chord.symbol} voices onto strings ${instrumentId} has not got, so there is no shape to give you.`,
    );
  }

  return ok({
    symbol: chord.symbol,
    root: chord.root,
    type: chord.type,
    notes: [...chord.notes],
    cells,
  });
}

// ------------------------------------------------------------------ undo ---
// LIB-GAP(1): the lib has no history support and no way to write a whole
// pattern back. Everything undo-related is confined to this section plus
// ./history so it can be deleted in one go. See docs/FOLLOW-UPS.md.

const history = createHistory<Pattern>();

/**
 * The one place we reach past the lib's public actions.
 *
 * The store exposes granular ops and a metadata patch, but no way to write a
 * whole pattern back — which is exactly what restoring a snapshot needs. Until
 * the lib grows `replacePattern(id, pattern)`, we swap the entry in `library`
 * ourselves. Keeping it in a single function means the lib migration touches
 * one call site.
 *
 * ⚠ IT HAS TO ROUTE THE WAY THE LIB'S OWN WRITES DO. `editingPattern` is
 * `currentEditTarget()?.pattern`, which is a PLACEMENT's snapshot whenever
 * `openPlacementForEditing` has pointed the store at one — and a placement's
 * snapshot keeps the id of the library pattern it was cut from. So a
 * library-only write-back would undo a placement-local note edit by stamping
 * that placement's snapshot over the LIBRARY PATTERN while leaving the placement
 * untouched: the undo appears to do nothing and quietly rewrites a document the
 * user was not editing. This mirrors the lib's private `updateTarget`, which is
 * the same two-branch routing for every ordinary edit.
 *
 * LIB-GAP(17): the write to a placement is hand-rolled because `composition-ops`
 * DOES export `setPlacementSnapshot(comp, placementId, next)` — it is just not on
 * the lib's root barrel and has no store action, so a consumer cannot reach it.
 * `fitPatternDuration` is not re-applied here on purpose: the snapshot being
 * restored was already fitted when it was captured. See docs/FOLLOW-UPS.md.
 */
function writePatternBack(pattern: Pattern): void {
  usePatternsStore.setState((state) => {
    const { editingPlacementId, editingCompositionId } = state;
    if (editingPlacementId !== null && editingCompositionId !== null) {
      return {
        library: {
          ...state.library,
          compositions: state.library.compositions.map((composition) =>
            composition.id !== editingCompositionId
              ? composition
              : {
                  ...composition,
                  tracks: composition.tracks.map((track) => ({
                    ...track,
                    placements: track.placements.map((placement) =>
                      placement.id === editingPlacementId
                        ? { ...placement, patternSnapshot: pattern }
                        : placement,
                    ),
                  })),
                  updatedAt: Date.now(),
                },
          ),
        },
      };
    }
    return {
      library: {
        ...state.library,
        patterns: state.library.patterns.map((p) => (p.id === pattern.id ? pattern : p)),
      },
    };
  });
}

/** Snapshot the current pattern before a mutation. */
function capture(): void {
  const pattern = getEditingPattern();
  if (pattern) history.capture(pattern);
}

/**
 * How many brackets are open.
 *
 * `history` keeps ONE gesture slot, so a nested `beginGesture` overwrites the
 * outer snapshot and the inner `endGesture` closes the outer bracket — after
 * which the outer gesture's remaining writes each push their own step. Counting
 * here is what keeps "one gesture, one step" true regardless of the order
 * callers reach the seam in.
 *
 * AG-04 is what forced it. `compositionService` has counted depth since CP-06
 * (a keyboard shortcut fired during a held drag nests one bracket inside
 * another); this side never did, because every UI gesture here is a pointer
 * drag and pointer drags do not overlap. The agent's tools nest by
 * construction — a tool that stamps a riff brackets itself, and a tool that
 * calls another one wraps that bracket — so without this a batching tool
 * collapses to one undo step only when it happens to be the outermost caller.
 */
let gestureDepth = 0;

/**
 * Bracket a multi-step edit — a drag fires dozens of mutations but must undo as
 * one step. Safe to call without a pattern open, and safe to nest.
 */
export function beginEditGesture(): void {
  // Nested: the outermost bracket's snapshot already covers everything inside
  // it, so this one records nothing and only deepens the count.
  if (gestureDepth++ > 0) return;
  const pattern = getEditingPattern();
  if (pattern) history.beginGesture(pattern);
}

/** `changed` is honoured only on the OUTERMOST close, because only that one
 *  decides whether a step is pushed. */
export function endEditGesture(changed = true): void {
  if (gestureDepth === 0) return;
  if (--gestureDepth > 0) return;
  history.endGesture({ changed });
}

export function undo(): void {
  const current = getEditingPattern();
  if (!current) return;
  const previous = history.undo(current);
  if (previous) writePatternBack(previous);
}

export function redo(): void {
  const current = getEditingPattern();
  if (!current) return;
  const next = history.redo(current);
  if (next) writePatternBack(next);
}

/**
 * Drop the stacks — done on every switch of edit target, because history is
 * per-pattern.
 *
 * ⚠ The bracket DEPTH deliberately survives. `history.clear()` drops the gesture
 * slot, so an open bracket would otherwise be silently orphaned: the writes
 * after the clear would each push their own step and the outer close would find
 * nothing, which is the one-command-three-undos failure the count exists to
 * prevent — and `openBlankPattern` and the placement-switch path both clear from
 * inside a caller's bracket. The bracket is re-armed on whatever is open now
 * instead, so it goes on covering the edits made through it.
 */
export function clearHistory(): void {
  history.clear();
  const pattern = getEditingPattern();
  if (gestureDepth > 0 && pattern) history.beginGesture(pattern);
}

/** React hook: whether undo/redo are currently available. */
export function useHistoryState(): { canUndo: boolean; canRedo: boolean } {
  const canUndo = useSyncExternalStore(history.subscribe, history.canUndo, history.canUndo);
  const canRedo = useSyncExternalStore(history.subscribe, history.canRedo, history.canRedo);
  return { canUndo, canRedo };
}

// ---------------------------------------------------------------- writing ---

/**
 * What the lib calls a pattern nobody has named — mirrored rather than imported
 * because `createEmptyPattern`'s default is a parameter default and is not
 * exported. Only used to build a name that does NOT collide with it.
 */
const BLANK_PATTERN_NAME = 'Untitled pattern';

/**
 * `base`, or `base 2`, `base 3` … — whichever the library has not got.
 *
 * The name is the ONLY handle a caller has on a pattern it did not create: the
 * library rails address rows by it, a screen reader reads it as the row's whole
 * identity, and the agent picks by it. Two rows called "Untitled pattern" are
 * therefore two rows that cannot be told apart or referred to, which is what a
 * second press of New used to produce.
 *
 * It de-duplicates the DEFAULTS only. A user who deliberately renames two
 * patterns the same way has said what they meant, and silently editing their
 * text would be worse than the ambiguity.
 *
 * Bounded by the number of names taken, so it terminates whatever is in there.
 */
function uniqueLibraryName(base: string, exceptId?: string): string {
  const taken = new Set(
    getLibraryPatterns()
      .filter((pattern) => pattern.id !== exceptId)
      .map((pattern) => pattern.name),
  );
  if (!taken.has(base)) return base;
  for (let n = 2; n <= taken.size + 1; n++) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return base;
}

/**
 * Create a fresh pattern and open it for editing.
 *
 * Returns the pattern it opened rather than `void`: the id is the only handle a
 * caller has on it afterwards, and a caller with no pointer (the agent) would
 * otherwise have to guess which of the library's patterns it just made. The
 * lib's `createPattern` returns `''` when the tier gate declines, which is the
 * only signal it gives — the same shape `openBlankComposition` handles.
 *
 * An unnamed pattern gets a name that is unique in the library rather than the
 * lib's flat "Untitled pattern" — see {@link uniqueLibraryName}. A name the
 * caller passed is used verbatim: it said what it wanted.
 */
export function openBlankPattern(name?: string): Result<Pattern> {
  const id = store().createPattern(name ?? uniqueLibraryName(BLANK_PATTERN_NAME));
  if (id === '') return refuse("Couldn't create a pattern — the library refused.");
  store().openPatternForEditing(id);
  store().selectEvents([], 'replace');
  // History is per-pattern; carrying it across a switch would undo into a
  // pattern that is no longer open.
  clearHistory();
  const pattern = getEditingPattern();
  if (!pattern || pattern.id !== id) return refuse("Couldn't open the new pattern.");
  return ok(pattern);
}

/** Open whatever pattern was last edited, seeding a draft if there is none. */
export function ensurePattern(): void {
  store().ensureEditingPattern();
}

/**
 * Open an existing library pattern for editing — the read-a-list-and-pick-one
 * half of {@link useLibraryPatterns}, and the one thing the seam could not do.
 *
 * The id is checked against the library first because the lib does not:
 * `openPatternForEditing` writes whatever id it is handed, after which
 * `selectEditingPattern` resolves to null and the editor is pointed at a pattern
 * that does not exist. Same class of adapter work as {@link checkString} — the
 * lib takes the value at face value, and a caller working by id rather than by
 * pointer is the one that can get it wrong.
 *
 * Re-opening what is ALREADY open is a no-op rather than a reopen:
 * `openPatternForEditing` resets `cursorTick`, `selectedEventIds` and
 * `pendingChordStamp`, and clicking the row you are already editing must not
 * throw your place away. The guard reads `editingPatternId` rather than
 * comparing `getEditingPattern()?.id`, because a PLACEMENT's snapshot carries
 * the id of the library pattern it was cut from (see `writePatternBack`) — so
 * the id can match while what is open is not this pattern at all.
 *
 * ⚠ HISTORY IS PER-PATTERN, and this is the reason `clearHistory` exists.
 * `writePatternBack` addresses whatever is open NOW, so an undo carried across a
 * switch would restore a snapshot of the previous pattern over — or rather,
 * silently back into — a document the user is no longer looking at. Cleared for
 * exactly the reason `openBlankPattern` clears it, and `clearHistory`
 * deliberately keeps an open gesture bracket alive (see its body).
 *
 * NOTHING ELSE IS LOST BY SWITCHING: every timeline edit is written straight to
 * the store as it is made, so there is no unsaved pattern state anywhere. The
 * app's one unsaved thing is the voice pane's working copy, which lives in `App`
 * and is keyed by pattern id — `App` confirms before stranding it, because this
 * function cannot see it and must not pretend to.
 */
export function openPattern(id: string): Result<Pattern> {
  const target = findLibraryPattern(id);
  if (!target) return refuse(`No such pattern: ${id}.`);
  const s = store();
  if (s.editingPatternId === id && s.editingPlacementId === null) {
    const already = getEditingPattern();
    if (already) return ok(already);
  }
  s.openPatternForEditing(id);
  clearHistory();
  const opened = getEditingPattern();
  if (!opened || opened.id !== id) return refuse(`Couldn't open ${target.name}.`);
  return ok(opened);
}

/**
 * Rename a library pattern, by id — it need not be the one that is open.
 *
 * The trim and the emptiness check are ours: the lib's `setPatternName` writes
 * whatever string it is given, and a pattern named `''` disappears from the
 * header, from this rail and from the composition page's rail at once, with no
 * way left to point at it. Not a lib defect to mask, just a rule the lib has no
 * opinion about.
 *
 * Not captured for undo, matching loop, tempo, voice and instrument above: it is
 * a change to the document's identity rather than to its notes. It is still
 * *restored* by one, since `writePatternBack` swaps in a whole `Pattern` — the
 * same side effect documented on {@link setEditingPatternVoiceRef}.
 */
export function renamePattern(id: string, name: string): Result<Pattern> {
  const target = findLibraryPattern(id);
  if (!target) return refuse(`No such pattern: ${id}.`);
  const trimmed = name.trim();
  if (trimmed === '') return refuse('A pattern needs a name.');
  store().renamePattern(id, trimmed);
  const renamed = findLibraryPattern(id);
  if (!renamed || renamed.name !== trimmed) return refuse(`Couldn't rename ${target.name}.`);
  return ok(renamed);
}

/**
 * Copy a library pattern, notes and all. The copy is NOT opened.
 *
 * Deliberate, and the opposite of {@link openBlankPattern}: a blank pattern is
 * only useful once you are in it, while a duplicate is usually made to keep the
 * original safe before changing it — switching the editor away from what you
 * were doing is the wrong default. A caller that wants the copy open follows
 * with `openPattern(result.value.id)`, which is one line and says so.
 *
 * No diffing here, unlike {@link stampNote}: `duplicatePattern` is one of the few
 * store actions that DOES hand back what it made, so LIB-GAP(20) doesn't bite.
 * Its `''` means the tier gate declined — the missing-source case is refused
 * above it, so the two cannot be confused.
 *
 * The lib names every copy `X (copy)` with no uniquifying, so copying the same
 * row twice hands back two patterns with one name between them; the rename
 * afterwards is {@link uniqueLibraryName}'s job for the same reason it is on
 * {@link openBlankPattern}.
 */
export function duplicatePattern(id: string): Result<Pattern> {
  const target = findLibraryPattern(id);
  if (!target) return refuse(`No such pattern: ${id}.`);
  const copyId = store().duplicatePattern(id);
  if (copyId === '') return refuse(`Couldn't copy ${target.name} — the library refused.`);
  const named = findLibraryPattern(copyId);
  if (!named) return refuse(`Couldn't copy ${target.name}.`);
  const unique = uniqueLibraryName(named.name, copyId);
  if (unique !== named.name) store().renamePattern(copyId, unique);
  const copy = findLibraryPattern(copyId);
  if (!copy) return refuse(`Couldn't copy ${target.name}.`);
  return ok(copy);
}

/**
 * Remove a library pattern, and leave something open.
 *
 * The lib's `deletePattern` nulls `editingPatternId` when it deletes the pattern
 * that id points at, and stops there — leaving the editor pointed at nothing.
 * {@link ensurePattern} is the existing answer to "nothing is open" and is used
 * here rather than a second rule: it adopts the most recently updated pattern,
 * or seeds a blank one when the library is now empty.
 *
 * ⚠ THAT SEEDED PATTERN IS THE LIB'S BLANK "Untitled pattern", NOT `App`'s demo.
 * `App` seeds "A major arpeggio" only into an EMPTY library, and because this
 * leaves one open the library is not empty after a delete — so the demo stays
 * what it is, a first-run affordance. Deleting everything and watching a pattern
 * you did not write reappear reads as the delete having failed.
 *
 * The one exception is degenerate and unreachable: `ensureEditingPattern` skips
 * its auto-seed silently when a SINGLE pattern would exceed the tier cap, which
 * needs a cap of zero and no such tier exists (the lib's own comment says so).
 * Should one ever ship, this returns with nothing open and `App` re-seeds the
 * demo. Called out rather than guarded because a guard on that path could not be
 * reached to test, and the refusal it would return has no better answer.
 *
 * Order matters: `ensurePattern` first, so `clearHistory` re-arms an open gesture
 * bracket on the pattern that is open NOW (see its body). History is dropped only
 * when the pattern that went was the one being edited — deleting some other row
 * leaves the open pattern's undo stack exactly where it was.
 *
 * The selection and the cursor are cleared with it, which `ensureEditingPattern`
 * does NOT do (unlike `openPatternForEditing`): it adopts a pattern by setting
 * one field, so without this the newly opened document arrives holding the
 * deleted one's selected event ids and its cursor tick. Nothing renders wrong —
 * every consumer filters against `pattern.events` — but `getSelectedIds` would
 * report notes that do not exist, and the seam exists so that an agent reading
 * it is not lied to.
 */
export function deletePattern(id: string): Result<Pattern> {
  const target = findLibraryPattern(id);
  if (!target) return refuse(`No such pattern: ${id}.`);
  const wasOpen = store().editingPatternId === id;
  store().deletePattern(id);
  if (wasOpen) {
    ensurePattern();
    store().selectEvents([], 'replace');
    store().setCursorTick(0);
    clearHistory();
  }
  return ok(target);
}

// ---------------------------------------------------------------- import ---

/**
 * What an import put in the library.
 *
 * Ids rather than documents: they are what a caller with no pointer needs to
 * open, rename or delete what it just made, and the documents themselves are one
 * `findLibraryPattern` away. `compositionId` is null when the mapper produced no
 * composition — see {@link importIR} on when that happens.
 */
export interface ImportedDocuments {
  readonly patternIds: readonly string[];
  readonly compositionId: string | null;
  readonly topology: MapTopology;
  /**
   * The third channel. Neither success nor refusal: the validator's DROPS, the
   * mapper's inventory of what it approximated, and this seam's own note when
   * notes landed on strings the resolved instrument hasn't got. All of them, in
   * that order — a caller that only saw the mapper's would never hear that a
   * track was dropped before the mapper ever ran.
   *
   * ⚠ CLAMPS ARE SILENT. The validator clamps fret, string index, tick, bpm,
   * capo and meter without saying a word — only its 64-track and
   * 100 000-events-per-track CAPS produce a warning. A caller must range-check
   * what it emits rather than expecting the pipeline to complain; fret 99
   * becomes fret 36 with nothing said. Pinned in tests/ImportIR.test.ts.
   */
  readonly warnings: readonly string[];
}

export interface ImportOptions {
  /** Which track is "primary" — it sorts first among the composition's tracks
   *  and its instrument becomes the composition's. Defaults to the first track
   *  that has any NOTES; naming one that has none is refused, because the mapper
   *  answers it with an empty document rather than with an error. */
  readonly selectedTrackId?: string;
  /** Force a topology. Omitted, the mapper picks: 'composition' when the
   *  document has more than one non-empty track, OR any section marker, OR a
   *  meter change; 'single-pattern' otherwise. */
  readonly topology?: MapTopology;
  /** Composition mode only: import just these tracks. The rest survive on the
   *  composition's `sourceIR` and are not materialized.
   *
   *  ⚠ The SELECTED track is always force-added to this list by the mapper, so
   *  filtering without also setting {@link selectedTrackId} imports one lane more
   *  than was asked for — the default selection is the first track with notes. */
  readonly includedTrackIds?: readonly string[];
  /** Library collection to file the new rows under. */
  readonly collectionId?: string | null;
  /** Instrument for a track whose `instrumentHint` is missing or unknown. The
   *  mapper's own default is a guitar, which puts a ukulele or bass user's
   *  import on the wrong neck; a UI caller should pass whatever it is showing.
   *  A hint that IS present always wins — including `drums` and `vocals`, which
   *  map to a guitar (see {@link importIR}). */
  readonly fallbackInstrumentId?: string;
}

/**
 * Notes in an IR, counted the way the validator counts them.
 *
 * The caps are applied here too because the surplus past them is dropped AND
 * already warned about: including it would make "N notes were discarded" name a
 * number the caller cannot act on. Defensive property access because this also
 * runs over the RAW document, whose events the validator has not vetted yet.
 */
function countIRNotes(tracks: ImportIR['tracks']): number {
  let total = 0;
  for (const track of tracks.slice(0, LIMITS.maxTracks)) {
    for (const event of (track?.events ?? []).slice(0, LIMITS.maxEventsPerTrack)) {
      total += Math.min(event?.notes?.length ?? 0, LIMITS.maxNotesPerEvent);
    }
  }
  return total;
}

/**
 * Notes on strings the pattern's own instrument hasn't got.
 *
 * The two bounds never meet in the pipeline: the validator clamps `string`
 * against the TRACK'S TUNING (or 6, when the track gave none), while the mapper
 * picks the instrument from `instrumentHint`. A bass-hinted track with no tuning
 * therefore stores notes on strings 4 and 5 of a four-string bass — undrawable,
 * unplayable, and only ever surfacing later as {@link checkString} refusing to
 * edit a note that is already there. Reported per instrument rather than per
 * pattern because one bad track is one mistake, not twenty-seven.
 */
function offNeck(patterns: readonly Pattern[]): string[] {
  const counts = new Map<string, number>();
  for (const pattern of patterns) {
    // The RESOLVED id, which is what the editor will read: `patternInstrumentId`
    // substitutes the default for one the catalog does not know, and comparing
    // against an unknown instrument's 0 strings would flag every note.
    const instrumentId = patternInstrumentId(pattern);
    const strings = instrumentStringCount(instrumentId);
    if (strings === 0) continue;
    const off = pattern.events.filter((event) => event.stringIndex >= strings).length;
    if (off > 0) counts.set(instrumentId, (counts.get(instrumentId) ?? 0) + off);
  }
  return [...counts].map(
    ([instrumentId, off]) =>
      `${off} note${off === 1 ? '' : 's'} sit on strings a ${instrumentId} hasn't got ` +
        `(it has ${instrumentStringCount(instrumentId)}). They are stored but nothing ` +
        'draws or plays them — give the track a `tuning` as long as its instrument.',
  );
}

/**
 * Turn an `ImportIR` document into stored patterns plus a stored composition.
 *
 * Three lib stages, none of whose arithmetic is ours or a caller's:
 *
 *   `validateImportIR` — rejects a structurally broken document, SILENTLY clamps
 *     every out-of-range number (fret to 0..36, string index into the track's
 *     tuning, bpm to 10..600), strips control characters from names, and drops
 *     items past its caps. Only a CAP produces a warning; see
 *     {@link ImportedDocuments.warnings}. It also drops, silently, any event or
 *     note whose `atTick`, `durationTicks`, `string` or `fret` is not a whole
 *     number — which this function turns back into a refusal when it costs the
 *     document all of its notes, and into a warning otherwise.
 *   `mapImportToLibrary` — cuts the document into `Pattern`s and a
 *     `Composition`, rescaling the IR's `ticksPerQuarter` to the project's 480.
 *   `commitImport` — writes both into the library under the tier gate.
 *
 * ⚠ THIS CREATES A NEW COMPOSITION. It never edits the open one — nothing here
 * touches `compositionService`'s document — so there is no edit to undo: the
 * import is not an undo step, and the way back out is to delete what it made.
 *
 * ⚠ IT ALSO CHANGES WHAT IS OPEN. `commitImport` points the store at what it
 * created (the composition when there is one, otherwise the first pattern) and
 * clears the placement/selection/cursor state — including `editingPatternId`,
 * which it nulls in composition mode. That null is left standing on purpose:
 * `App.tsx` adopts the most recently updated library row when nothing is open,
 * so the pattern page jumps to one of the imported patterns rather than to the
 * junk pattern a re-seed would otherwise append.
 *
 * This function drops the pattern seam's undo history for the same reason —
 * history is per-pattern and `writePatternBack` addresses whatever is open NOW.
 * (An open gesture bracket is NOT re-armed after a composition-mode import,
 * because no pattern is open to re-arm it on; nothing brackets this call today,
 * and a future caller that does would get one undo step per write.)
 *
 * ⚠ IT CANNOT CLEAN UP AFTER THE COMPOSITION SEAM, because `compositionService`
 * imports this module and not the other way round — yet that seam holds four
 * pieces of per-composition state OUTSIDE the store, and all four now name a
 * document nobody is looking at. A caller with both seams in scope must do what
 * `compositionService`'s own switch routine does, after a successful import:
 *   - `closePlacementEditing()` — the open block belongs to the old composition,
 *     and leaving it open sends the pattern pointer back to a pre-import pattern.
 *   - `selectPlacements([], 'replace')` — the module's selection list, which the
 *     store's single `selectedPlacementId` is kept in sync with; `commitImport`
 *     nulls the store's side only, breaking that invariant.
 *   - `selectTrack(null)` — otherwise `getSelectedTrackId()` still names a track
 *     of the previous composition, and a write aimed at it is refused with no
 *     visible cause.
 *   - `clearHistory()` — or an undo stamps a snapshot of the previously-open
 *     composition back over that composition.
 *
 * ⚠ A DOCUMENT WITH NO SECTION MARKERS STILL PRODUCES A COMPOSITION, as long as
 * it has more than one non-empty track (or a meter change, or an explicit
 * `topology`). The mapper's own doc comment says otherwise; the code does not.
 * What sections change is the CUT: with markers, every track is sliced into one
 * pattern per section, so the pattern count is tracks × sections; without them,
 * each track becomes one pattern spanning the whole piece. Pinned in
 * tests/ImportIR.test.ts, because the shape of a document a caller writes
 * follows from it.
 *
 * ⚠ THREE DOCUMENTED IR FIELDS GO NOWHERE, so a caller writing one is writing
 * dead weight (all three do survive on the row's `sourceIR`). The first two are
 * LIB-GAP(21) — docs/FOLLOW-UPS.md row 21 names where it costs something and
 * what closes it:
 *   - `chords` — `validateImportIR` does not copy it onto the IR it returns, so
 *     the mapper's harmony lane is always empty no matter what was written. It is
 *     NOT masked here by passing the raw list through: `chords[].symbol` is the
 *     one user-visible string the validator never sanitizes, and re-attaching it
 *     would re-open the hole `sanitizeString` exists for.
 *   - `keySignatures` — the mapper never reads it; every pattern is built with
 *     `key: null, scaleType: null`.
 *   - `instrumentHint: 'drums' | 'vocals'` — both map to a guitar, and in
 *     composition mode (the usual one) not even with a warning.
 * All three are pinned in tests/ImportIR.test.ts.
 *
 * ⚠ EVENTS MUST BE TICK-ORDERED within a track. The mapper preserves IR order
 * and never sorts, so an out-of-order document produces a pattern whose
 * `startTick`s run backwards — and `resolveSlideTarget` walks FORWARD BY INDEX
 * to find a slide's destination, so it resolves to the wrong fret. Not sorted
 * here on purpose: reordering a caller's document silently would hide the
 * mistake rather than let the caller's own tests catch it.
 *
 * Frets above the instrument's neck can arrive: the validator's ceiling is 36,
 * {@link MAX_FRET} is 24 and a real neck is shorter still. They are stored and
 * editable, drawn by nothing and played by nothing — the tolerance
 * {@link fretCount} documents. ({@link notesAboveNeck} counts them for the OPEN
 * pattern only, and a composition-mode import leaves no pattern open, so it
 * reports 0 for every imported row.)
 */
export function importIR(raw: ImportIR, options: ImportOptions = {}): Result<ImportedDocuments> {
  let validated: ValidationResult;
  try {
    validated = validateImportIR(raw);
  } catch (error) {
    // The validator THROWS rather than returning its refusal, so the seam's own
    // idiom has to be put back on. `issues` is the list of what was structurally
    // wrong and is the only actionable part — a caller that hears "import
    // failed" has nothing to change.
    if (error instanceof ImportValidationError) {
      return refuse(`That document isn't a valid import: ${error.issues.join('; ')}.`);
    }
    // Anything else is the validator walking off the end of a shape it did not
    // check — `tracks: [null]` dereferences `t.tuning`, for instance. The raw JS
    // message alone ("Cannot read properties of null") names nothing a caller can
    // change, so it gets the structural sentence in front of it.
    return refuse(
      `That document couldn't be read — a track, event or note isn't an object: ${
        error instanceof Error ? error.message : String(error)
      }.`,
    );
  }

  const ir = validated.ir;
  // NOTES, not events: the validator drops a note whose `string` or `fret` is
  // fractional but KEEPS its event, so a track can survive validation carrying
  // events that are all empty. Counting events instead lets such a document
  // through and commits a pattern with nothing in it.
  const noteCount = (track: ImportIR['tracks'][number]) =>
    track.events.reduce((sum, event) => sum + event.notes.length, 0);
  const playable = ir.tracks.filter((track) => noteCount(track) > 0);
  const dropped = countIRNotes(raw.tracks) - countIRNotes(ir.tracks);
  if (playable.length === 0) {
    // Fractional ticks and frets are the single likeliest mistake in a
    // hand-written or model-written document, and "no notes" alone would send the
    // caller looking at the wrong thing.
    if (dropped > 0) {
      return refuse(
        `Nothing survived validation — all ${dropped} note${
          dropped === 1 ? '' : 's'
        } were discarded. \`atTick\`, \`durationTicks\`, \`string\` and \`fret\` must be whole numbers.`,
      );
    }
    return refuse(
      `Nothing to import — the document has ${ir.tracks.length} track${
        ir.tracks.length === 1 ? '' : 's'
      } and no notes on any of them.`,
    );
  }

  // The survivable version of the same drop: some notes went and some stayed. The
  // pipeline says nothing at all about it, so this is the only place a caller can
  // hear it.
  const seamWarnings =
    dropped > 0
      ? [
          `Discarded ${dropped} note${dropped === 1 ? '' : 's'} whose \`atTick\`, ` +
            '`durationTicks`, `string` or `fret` was not a whole number.',
        ]
      : [];

  // Two markers on one tick, or a marker at or past `totalTicks`, each produce a
  // section interval of zero length — and the mapper builds a real Pattern with
  // `durationTicks: 0` for it, commits it, and hangs a placement off it. Nothing
  // downstream refuses a zero-length block, and these patterns never pass through
  // `fitPatternDuration`, so the document has to be refused here instead.
  const sectionTicks = ir.sections.map((section) => section.atTick);
  const duplicate = sectionTicks.find((tick, i) => sectionTicks.indexOf(tick) !== i);
  if (duplicate !== undefined) {
    return refuse(
      `Two section markers are both at tick ${duplicate}. Each marker starts a ` +
        'section, so two on one tick makes one of them zero bars long.',
    );
  }
  const pastEnd = sectionTicks.find((tick) => tick >= ir.totalTicks);
  if (pastEnd !== undefined) {
    return refuse(
      `A section marker sits at tick ${pastEnd}, at or past the document's end ` +
        `(\`totalTicks\` is ${ir.totalTicks}). Every marker has to start a section ` +
        'with room in it.',
    );
  }

  // The mapper takes an unknown `selectedTrackId` as a WARNING and hands back
  // zero patterns, and a SILENT track as a legitimate pick — throwing every other
  // track's music away and returning one empty pattern. Both read downstream as
  // an empty document rather than as a caller naming the wrong track, so both are
  // checked here, separately, so the sentence names the mistake.
  const selectedTrackId = options.selectedTrackId ?? playable[0].id;
  if (!playable.some((track) => track.id === selectedTrackId)) {
    const known = ir.tracks.some((track) => track.id === selectedTrackId);
    return refuse(
      known
        ? `Track ${selectedTrackId} has no notes, so it cannot be the primary track. These do: ${playable
            .map((track) => track.id)
            .join(', ')}.`
        : `No such track: ${selectedTrackId}. The document has ${ir.tracks
            .map((track) => track.id)
            .join(', ')}.`,
    );
  }

  const mapped = mapImportToLibrary({
    ir,
    selectedTrackId,
    topology: options.topology,
    includedTrackIds: options.includedTrackIds,
    fallbackInstrumentId: options.fallbackInstrumentId,
  });
  const warnings = [
    ...validated.warnings,
    ...seamWarnings,
    ...mapped.warnings,
    ...offNeck(mapped.patterns),
  ];

  if (mapped.patterns.length === 0) {
    // Defence only: the mapper returns zero patterns for an unknown selected
    // track alone, which the guard above has already refused, so this cannot
    // currently fire. Kept because "zero patterns" must never reach `commitImport`
    // — nobody should go hunting for the test that covers it.
    return refuse(
      `Nothing came out of that document. ${warnings.join(' ') || 'The mapper produced no patterns.'}`,
    );
  }

  const { patterns: heldPatterns, compositions: heldCompositions } = store().library;
  const committed = store().commitImport(mapped, options.collectionId ?? null);
  if (committed === null) {
    // The gate mutates NOTHING and opens the upgrade prompt (or, for a signed-out
    // viewer, the signup modal) on its way out. It gates patterns and compositions
    // INDEPENDENTLY and says which one declined to nobody, so the sentence names
    // what the import needs and what is already held rather than guessing.
    return refuse(
      `Nothing was imported — your plan's library cap is in the way. This import needs room for ${
        mapped.patterns.length
      } more pattern${mapped.patterns.length === 1 ? '' : 's'}${
        mapped.composition ? ' and one more composition' : ''
      }, on top of the ${heldPatterns.length} pattern${
        heldPatterns.length === 1 ? '' : 's'
      } and ${heldCompositions.length} composition${
        heldCompositions.length === 1 ? '' : 's'
      } already in your library.`,
    );
  }

  // History is per-pattern and the store is now pointed somewhere else — see the
  // doc comment. Same reason `openPattern` clears it.
  clearHistory();

  return ok({
    patternIds: mapped.patterns.map((pattern) => pattern.id),
    compositionId: mapped.composition?.id ?? null,
    topology: mapped.topology,
    warnings,
  });
}

/**
 * How many strings a NAMED instrument has — 0 for one the catalog does not know.
 *
 * Split out of `stringCount` for `chordGrip`, which answers about an instrument
 * given to it rather than about the open pattern: the two must agree, and a
 * second `getInstrument(...)?.stringCount ?? 0` is exactly the duplicate that
 * would let them disagree.
 */
export function instrumentStringCount(instrumentId: string): number {
  return getInstrument(instrumentId)?.stringCount ?? 0;
}

/**
 * How many strings the open pattern's instrument has.
 *
 * ⚠ `stringIndex` 0 is the LOW E — the physically bottom string. Display order
 * is the reverse of index order (see `ROW_ORDER` in Timeline.tsx), and a caller
 * that has them backwards puts every note on the wrong string while producing
 * something that still looks like a pattern.
 */
export function stringCount(): number {
  const pattern = getEditingPattern();
  if (!pattern) return 0;
  return instrumentStringCount(patternInstrumentId(pattern));
}

/**
 * Reject a string the instrument hasn't got.
 *
 * The lib does NOT: `stampEvent` and `moveEvent` take the index at face value,
 * so a note on string 9 of a guitar is stored, drawn by nothing, played by
 * nothing and reported by nobody. A pointer can only ever hit a lane that
 * exists; a caller working by value can't, and this is the exact failure the
 * seam exists to turn into a sentence.
 */
function checkString(stringIndex: number): Result {
  const count = stringCount();
  if (!Number.isInteger(stringIndex) || stringIndex < 0 || stringIndex >= count) {
    return refuse(
      `String ${stringIndex} does not exist — this instrument has strings 0 to ${count - 1}, where 0 is the lowest (low E on a guitar).`,
    );
  }
  return ok(undefined);
}

/**
 * How many frets a NAMED instrument's neck has — 0 for one the catalog does not
 * know.
 *
 * {@link instrumentStringCount}'s sibling and split out for the same reason: a
 * caller that is authoring notes for an instrument it has been handed, rather
 * than for the open pattern, must be able to ask about that instrument, and a
 * second `getInstrument(...)?.fretCount ?? 0` is exactly the duplicate that
 * would let the two answers disagree.
 */
export function instrumentFretCount(instrumentId: string): number {
  return getInstrument(instrumentId)?.fretCount ?? 0;
}

/** What an instrument's open strings sound, and which of them is which. */
export interface InstrumentOpenStrings {
  /**
   * Open-string pitches in scientific notation, `stringIndex` order — index 0
   * is the physically BOTTOM string. Empty for an instrument or a tuning the
   * catalog does not have.
   */
  readonly names: readonly string[];
  /** Index of the lowest-SOUNDING string; -1 when there is no order to give. */
  readonly lowestIndex: number;
  /** Index of the highest-SOUNDING string; -1 when there is no order to give. */
  readonly highestIndex: number;
  /** Whether the pitches rise with the index — false on a reentrant tuning, and
   *  false when there is no order to give. */
  readonly ascending: boolean;
}

const NO_OPEN_STRINGS: InstrumentOpenStrings = {
  names: [],
  lowestIndex: -1,
  highestIndex: -1,
  ascending: false,
};

/**
 * Where an open-string pitch sits absolutely, in semitones, for ORDERING only —
 * `null` for a name nothing here can read.
 *
 * ⚠ NORMALISED FIRST, and that is not tidiness. An octave digit multiplied out
 * and added to a chroma is only a height while the two agree about which octave
 * the note is in, and on a name that crosses the C boundary they do not: `Cb4`
 * sounds B3 and `B#3` sounds C4, so the printed digit is a semitone's worth of
 * an octave wrong in each direction. `noteAt(name, 0)` is the lib's own MIDI
 * round-trip — it returns a sharp spelling whose octave digit is exact — after
 * which the digits and `pitchClass` describe the same note. No catalog tuning is
 * spelled that way today; the brief prints this ordering to the model as fact,
 * which is not a place to leave a latent octave error.
 *
 * Both lib calls THROW on a name they cannot parse, and this runs over catalog
 * data a lib version can change under us, so an unreadable pitch becomes "no
 * order" rather than an exception thrown out of a seam accessor.
 */
function openStringHeight(note: string): number | null {
  try {
    const canonical = noteAt(note, 0);
    const octave = /(-?\d+)$/.exec(canonical);
    if (octave === null) return null;
    return Number(octave[1]) * 12 + pitchClass(canonical);
  } catch {
    return null;
  }
}

/**
 * What a NAMED instrument's strings SOUND when played open, in `stringIndex`
 * order.
 *
 * {@link instrumentStringCount}'s and {@link instrumentFretCount}'s sibling and
 * split out for their reason: a caller authoring notes for an instrument it has
 * been handed, rather than for the open pattern, must be able to ask about that
 * instrument, and a second `getTuning(...)` elsewhere is exactly the duplicate
 * that would let two answers disagree.
 *
 * ⚠ WHY THE COUNT WAS NOT ENOUGH. A run on 2026-08-16 put all 48 notes of a bass
 * part on `string` 3 — the G, the HIGHEST string of the four — because the
 * player's numbering runs the other way (the lowest string carries the highest
 * number). Every one of those notes was in range, so nothing downstream caught
 * it and nothing could have. A string index is only an anchor once something
 * says what it sounds.
 *
 * ⚠ The tuning is the instrument's DECLARED DEFAULT, resolved through
 * `getTuning`, matching {@link chordGrip} and `reference/tabLayout.ts`'s
 * `openStrings` — NOT `getTuningsForInstrument(id)[0]`, which agrees with that
 * only because of the order `TUNINGS` happens to be written in (see
 * `tabLayout`'s header). Nothing in this app owns instrument/tuning/capo yet
 * (docs/FOLLOW-UPS.md §3), so the default is the only answer there is to give.
 *
 * ⚠ INDEX ORDER IS NOT PITCH ORDER. Index 0 is the bottom string PHYSICALLY,
 * which on a guitar and a bass is also the lowest-sounding one and on a standard
 * ukulele (G4 C4 E4 A4) is not — the high-G drone sits at the bottom of the
 * neck. {@link InstrumentOpenStrings.lowestIndex} is the answer to "which sounds
 * lowest" and is never assumed to be 0.
 *
 * Empty names and no order at all for an instrument the catalog does not know —
 * its siblings' `0`, in the shape this answer has.
 */
export function instrumentOpenStrings(instrumentId: string): InstrumentOpenStrings {
  const instrument = getInstrument(instrumentId);
  if (instrument === undefined) return NO_OPEN_STRINGS;

  // The half that can still go missing when a lib version adds an instrument
  // before its tunings — `chordGrip`'s case, in the shape this answer has.
  const tuning = getTuning(instrument.defaultTuningId);
  if (tuning === undefined) return NO_OPEN_STRINGS;

  // Trimmed to the instrument's own string count for `chordGrip`'s reason: a
  // tuning wider than its neck would name a string nothing draws and nothing
  // plays. Every tuning in the catalog is as wide as its instrument today, so
  // this drops nothing.
  const names = tuning.strings.slice(0, instrument.stringCount);
  if (names.length === 0) return NO_OPEN_STRINGS;

  const heights: number[] = [];
  for (const name of names) {
    const height = openStringHeight(name);
    if (height === null) return { ...NO_OPEN_STRINGS, names };
    heights.push(height);
  }

  let lowestIndex = 0;
  let highestIndex = 0;
  let ascending = true;
  heights.forEach((height, index) => {
    if (height < heights[lowestIndex]) lowestIndex = index;
    if (height > heights[highestIndex]) highestIndex = index;
    if (index > 0 && height <= heights[index - 1]) ascending = false;
  });

  return { names, lowestIndex, highestIndex, ascending };
}

/**
 * How many frets the open pattern's instrument has.
 *
 * ⚠ NOT the same bound as {@link MAX_FRET}, and the difference is the whole
 * reason this exists: `MAX_FRET` is 24 for everything, while a guitar has 22, a
 * bass 21 and a ukulele 15. A note between the two is perfectly legal — the
 * editor keeps it, so that changing instrument stays lossless — but the
 * fretboard cannot draw it (`cellsAboveFret` counts them) and `flattenTrack`
 * drops it from playback at transpose 0 as well as under one. A caller with no
 * screen has to be able to ask.
 */
export function fretCount(): number {
  const pattern = getEditingPattern();
  if (!pattern) return 0;
  return instrumentFretCount(patternInstrumentId(pattern));
}

/** Notes whose fret this instrument's neck hasn't got — stored and editable,
 *  drawn by nothing and played by nothing. See {@link fretCount}. */
export function notesAboveNeck(): number {
  const pattern = getEditingPattern();
  if (!pattern) return 0;
  const frets = fretCount();
  return pattern.events.filter((event) => event.fret > frets).length;
}

/**
 * Reject a fret outside the app's own range.
 *
 * {@link MAX_FRET} is applied by `setSelectedFret` and by the popup's stepper
 * and by nothing else, which made it a rule only a button enforced — precisely
 * what {@link checkString} exists to stop being true of the string axis. The
 * lib floors at 0 and has no ceiling, so an unchecked value is stored verbatim
 * and vanishes at playback. The instrument's own shorter neck is NOT refused
 * here: the editor deliberately tolerates a note above it, and refusing would
 * make the seam stricter than the UI. It is reported instead — see
 * {@link notesAboveNeck}.
 */
function checkFret(fret: number): Result {
  if (!Number.isInteger(fret) || fret < 0 || fret > MAX_FRET) {
    return refuse(`Fret ${fret} does not exist — frets run from 0 (open) to ${MAX_FRET}.`);
  }
  return ok(undefined);
}

export interface StampArgs {
  stringIndex: number;
  fret: number;
  tick: Tick;
  durationTicks?: Tick;
}

/**
 * Place a note at an explicit tick, and report the note that landed.
 *
 * The store's `stampAt` always stamps at its own cursor, so we move the cursor
 * first — that's the intended flow, and it keeps the cursor where the user last
 * acted. A stamp that would overlap an existing note on the same string is
 * rejected by the lib, which returns the pattern unchanged and hands back the
 * note that was in the way; the new note is found by DIFFING the ids for that
 * reason, and its absence is the refusal.
 *
 * ⚠ `durationTicks` is optional here and must not be treated as such by a caller
 * with no UI: `stampAt` falls back to the STORE'S `stepLength`, which is the
 * pattern page's grid setting. Omitting it means "whatever the user last chose",
 * which is not a thing an agent can mean. It is also only a REQUEST — the lib
 * clamps a note so it cannot run into the next one on its string, so the value
 * on the returned event is the one that stuck.
 */
export function stampNote({
  stringIndex,
  fret,
  tick,
  durationTicks,
}: StampArgs): Result<PatternEvent> {
  const pattern = getEditingPattern();
  if (!pattern) return refuse('No pattern is open.');
  const onNeck = checkString(stringIndex);
  if (!onNeck.ok) return onNeck;
  const inRange = checkFret(fret);
  if (!inRange.ok) return inRange;
  capture();
  const s = store();
  s.setCursorTick(tick);
  // LIB-GAP(20): `stampEvent` returns `{ pattern, event }` — including the note
  // that was in the way when it declines — and the store's `stampAt` throws all
  // of it away and returns `void`. Diffing the ids is the only way back to the
  // note that landed. See docs/FOLLOW-UPS.md.
  const before = new Set(pattern.events.map((e) => e.id));
  s.stampAt({ stringIndex, fret }, false);
  const added = getEditingPattern()?.events.find((e) => !before.has(e.id));
  if (!added) {
    return refuse(
      `String ${stringIndex} is already sounding at tick ${tick} — one string can only ring one note at a time.`,
    );
  }
  if (durationTicks !== undefined) s.resizeEvent(added.id, durationTicks);
  return ok(findEvent(added.id) ?? added);
}

/**
 * The note, or the sentence saying why there is not one.
 *
 * With no pattern open every id lookup fails, and answering "No such note." to
 * each one tells an agent that sent a batch of twenty that twenty notes
 * vanished — when the recoverable truth is that there is nothing open to edit.
 * {@link stampNote} has always distinguished the two; the id-addressed writes
 * below have to as well, because they are the ones that arrive twenty at a time.
 */
function requireEvent(id: string): Result<PatternEvent> {
  if (!getEditingPattern()) return refuse('No pattern is open.');
  const event = findEvent(id);
  if (!event) return refuse('No such note.');
  return ok(event);
}

/**
 * Move a note, reporting where it actually ended up.
 *
 * The lib REJECTS a move that would overlap another note on the target string
 * (unlike the group move, which clamps), leaving the note exactly where it was
 * and the pattern reference unchanged — so the refusal is detected by reading
 * the note back. Compared against the lib's own floor of 0 rather than against
 * the request, because a negative tick is CLAMPED and clamping is not a refusal.
 */
export function moveNote(
  id: string,
  startTick: Tick,
  stringIndex?: number,
): Result<{ startTick: Tick; stringIndex: number }> {
  const found = requireEvent(id);
  if (!found.ok) return found;
  const before = found.value;
  if (stringIndex !== undefined) {
    const onNeck = checkString(stringIndex);
    if (!onNeck.ok) return onNeck;
  }
  capture();
  store().moveEvent(id, startTick, stringIndex);
  // LIB-GAP(20) again: `moveEvent` (the op) returns the pattern unchanged when
  // it rejects an overlap, and the store action returns `void`, so the decline
  // is only visible by reading the note back.
  const after = findEvent(id);
  if (!after) return refuse('No such note.');
  const wantedTick = Math.max(0, startTick);
  const wantedString = stringIndex ?? before.stringIndex;
  if (after.startTick !== wantedTick || after.stringIndex !== wantedString) {
    return refuse(
      `That move would overlap another note on string ${wantedString}; the note is still at tick ${after.startTick} on string ${after.stringIndex}.`,
    );
  }
  return ok({ startTick: after.startTick, stringIndex: after.stringIndex });
}

/** Resize a note, reporting the duration that stuck — the lib clamps it against
 *  the next note on the same string, so a request can be honoured in part. */
export function resizeNote(id: string, durationTicks: Tick): Result<Tick> {
  const found = requireEvent(id);
  if (!found.ok) return found;
  capture();
  store().resizeEvent(id, durationTicks);
  return ok(findEvent(id)?.durationTicks ?? durationTicks);
}

/** Set a note's fret, reporting the value that stuck — the lib floors it at 0
 *  and has no ceiling, so {@link checkFret} applies the app's own. */
export function setNoteFret(id: string, fret: number): Result<number> {
  const found = requireEvent(id);
  if (!found.ok) return found;
  const inRange = checkFret(fret);
  if (!inRange.ok) return inRange;
  capture();
  store().setEventFret(id, fret);
  return ok(findEvent(id)?.fret ?? fret);
}

/**
 * The top of the neck. The lib floors a fret at 0 but has no ceiling of its own
 * (`setEventFret` only does `Math.max(0, …)`), so the upper bound is the app's
 * rule and has to be applied on the way in — by {@link checkFret} on the
 * id-addressed writes and by the clamps below on the selection ones. Exported so
 * the popup's stepper and keyboard entry can't drift apart from either.
 */
export const MAX_FRET = 24;

/**
 * Put every selected note on an explicit fret — keyboard fret entry.
 *
 * One store write per note: the lib has a bulk *relative* action
 * (`nudgeSelectedFret`) but no absolute one, so the loop is unavoidable. Undo is
 * unaffected — the single `capture()` covers the whole selection.
 */
export function setSelectedFret(fret: number): void {
  const ids = getSelectedIds();
  // Capture only once there is something to change, so an empty selection can't
  // push a no-op undo step — matching `nudgeSelectedFret` below.
  if (ids.length === 0) return;
  capture();
  const clamped = Math.max(0, Math.min(MAX_FRET, Math.floor(fret)));
  const s = store();
  for (const id of ids) s.setEventFret(id, clamped);
}

/**
 * Nudge the whole selection by `delta` frets, in one store write.
 *
 * The delta is clamped against the extremes of the selection rather than note
 * by note: the lib floors each event at 0 independently, so a chord nudged past
 * the nut would flatten onto it instead of stopping there. Clamping the shared
 * delta keeps the selection's shape when it hits either end — the same
 * reasoning as the group-resize clamp in Timeline.
 */
export function nudgeSelectedFret(delta: number): void {
  const pattern = getEditingPattern();
  if (!pattern) return;
  const ids = getSelectedIds();
  const frets = pattern.events.filter((e) => ids.includes(e.id)).map((e) => e.fret);
  if (frets.length === 0) return;
  // Room measured only in the direction being asked for. `MAX_FRET` is our rule,
  // not the lib's — a pattern imported or restored with a note above it has
  // negative headroom, and folding both bounds into one min/max chain would turn
  // that into a nudge *down* when the user pressed up.
  const room =
    delta > 0
      ? Math.max(0, MAX_FRET - Math.max(...frets))
      : Math.min(0, -Math.min(...frets));
  const clamped = delta > 0 ? Math.min(room, delta) : Math.max(room, delta);
  if (clamped === 0) return;
  capture();
  store().nudgeSelectedFret(clamped);
}

/**
 * Delete notes by id. ALL OR NOTHING: an id that names no note refuses the whole
 * call rather than deleting the rest, because a caller that cannot see the
 * pattern has no way to tell a partial delete from a complete one, and the lib's
 * `deleteEvents` simply skips what it can't find.
 */
export function deleteNotes(ids: readonly string[]): Result<number> {
  if (ids.length === 0) return ok(0);
  if (!getEditingPattern()) return refuse('No pattern is open.');
  const unique = [...new Set(ids)];
  const missing = unique.filter((id) => !findEvent(id));
  if (missing.length > 0) return refuse(`No such note: ${missing.join(', ')}.`);
  capture();
  store().deleteEvents(unique);
  // The count of notes GONE, not of ids sent: a repeated id deletes one note
  // once, and reporting two would have a caller believing a note it can still
  // see was removed.
  return ok(unique.length);
}

/**
 * Whether editor playback repeats. Stored on the pattern (the lib defaults it to
 * true) rather than held in transport state, so it survives reopening.
 */
export function setPatternLoop(loop: boolean): Result {
  if (!getEditingPattern()) return refuse('No pattern is open.');
  store().setEditingPatternLoop(loop);
  return ok(undefined);
}

/**
 * The pattern's preferred tempo. The lib treats this as the author's intent and
 * loads it into the metronome when the pattern is opened; the metronome holds
 * the live value during playback.
 */
export function setPatternBpm(bpm: number | null): Result {
  if (!getEditingPattern()) return refuse('No pattern is open.');
  store().setEditingPatternSuggestedBpm(bpm);
  return ok(undefined);
}

/**
 * The pattern's feel, by preset id — see {@link listGrooves}.
 *
 * Not captured for undo, matching loop and tempo: it is a preference about how
 * the pattern is played, not an edit to its notes.
 */
export function setPatternGroove(grooveId: GrooveId): Result {
  if (!getEditingPattern()) return refuse('No pattern is open.');
  const preset = GROOVE_PRESETS.find((candidate) => candidate.id === grooveId);
  if (!preset) return refuse(`No such groove: ${grooveId}.`);
  store().setEditingPatternGroove(preset.groove);
  return ok(undefined);
}

/**
 * The open pattern's feel, as an id — the read half of {@link setPatternGroove}.
 *
 * `'custom'` for any `GrooveSpec` that matches no named preset (a document made
 * elsewhere can hold one), and null when nothing is open. A capability that can
 * only be WRITTEN is one a caller can neither confirm nor reason from.
 */
export function patternGrooveId(): GroovePresetId | null {
  const pattern = getEditingPattern();
  if (!pattern) return null;
  return presetMatching(pattern.groove ?? null);
}

/**
 * Which voice the pattern plays through — a `VariantRef` from the lib's voices
 * module, or null to fall back to the instrument's active voice.
 *
 * Typed `unknown` because it is `unknown` on `Pattern`: the lib keeps its pattern
 * model independent of the voices module and documents casting at use.
 * `src/voice/voiceService.ts` owns that cast and its validation — this is only the
 * store write, which has to live on this side of the seam.
 *
 * Not *captured* for undo, matching loop and tempo above: it is a preference about how
 * the pattern sounds, not an edit to its notes, so choosing a voice doesn't push an undo
 * step. It is still *restored* by one — `writePatternBack` swaps in a whole `Pattern`
 * snapshot — so undoing past the point where the voice was chosen reverts it as a side
 * effect. Fix that for all three at once by carrying them forward in `writePatternBack`.
 */
export function setEditingPatternVoiceRef(voiceRef: unknown): Result {
  if (!getEditingPattern()) return refuse('No pattern is open.');
  store().setEditingPatternVoiceRef(voiceRef);
  return ok(undefined);
}

/**
 * Which instrument the pattern is on — how many strings it has, which tunings apply,
 * and which voices the voice pane may offer.
 *
 * The lib's op writes the field and nothing else, so events on strings the new
 * instrument doesn't have (a guitar's index 4–5 on a four-string bass) stay on the
 * pattern and simply stop being drawn. Left that way deliberately: it is lossless and
 * reverses by switching back, where dropping them would not. A guard belongs with the
 * slice that owns instrument switching as an *editing* operation rather than as the
 * voice pane's prerequisite.
 *
 * Not captured for undo, matching loop, tempo and voice above.
 */
export function setEditingPatternInstrument(instrumentId: FretInstrumentId): Result {
  const pattern = getEditingPattern();
  if (!pattern) return refuse('No pattern is open.');
  // Membership checked rather than trusted: the id is a string at every real
  // caller (a `<select>` value, a tool argument) and `getInstrument` returns
  // `undefined` for one the catalog hasn't got, after which the pattern is on an
  // instrument that does not exist and every neck question answers with the
  // fallback. Same rule as the groove ids below.
  if (!getInstrument(instrumentId)) return refuse(`No such instrument: ${instrumentId}.`);
  // The store's action addresses a pattern by id — there is no editing-pattern
  // shorthand for this one, unlike loop/tempo/voiceRef.
  store().setPatternInstrument(pattern.id, instrumentId);
  return ok(undefined);
}

export function selectNotes(ids: readonly string[], mode: SelectionMode = 'replace'): void {
  store().selectEvents(ids, mode);
}

/** Drag-start state for a group move — the lib clamps against these, not against
 *  the live positions, so repeated pointer moves don't compound. */
export function snapshotForDrag(ids: readonly string[]): EventDragSnapshot[] {
  const pattern = getEditingPattern();
  if (!pattern) return [];
  return pattern.events
    .filter((event) => ids.includes(event.id))
    .map(({ id, startTick, stringIndex, durationTicks }) => ({
      id,
      startTick,
      stringIndex,
      durationTicks,
    }));
}

export function snapshotForResize(ids: readonly string[]): EventResizeSnapshot[] {
  const pattern = getEditingPattern();
  if (!pattern) return [];
  return pattern.events
    .filter((event) => ids.includes(event.id))
    .map(({ id, durationTicks }) => ({ id, durationTicks }));
}

/**
 * Move a group. Unlike `moveNote`, the lib *clamps* this rather than rejecting
 * it — the group slides up against obstacles instead of refusing to budge, which
 * is what makes dragging a multi-selection feel right.
 */
export function moveNotesBy(
  snapshots: readonly EventDragSnapshot[],
  deltaTicks: Tick,
  deltaStrings: number,
  stringCount: number,
): void {
  capture();
  store().moveEventsBy(snapshots, deltaTicks, deltaStrings, stringCount);
}

export function resizeNotesBy(
  snapshots: readonly EventResizeSnapshot[],
  deltaTicks: Tick,
): void {
  capture();
  store().resizeEventsBy(snapshots, deltaTicks);
}

/**
 * Patch articulation fields. `undefined` clears a field; the lib keeps
 * hammer-on and pull-off mutually exclusive for us.
 */
export function setArticulations(
  id: string,
  patch: Parameters<ReturnType<typeof store>['updateEventArticulations']>[1],
): Result {
  const found = requireEvent(id);
  if (!found.ok) return found;
  capture();
  store().updateEventArticulations(id, patch);
  return ok(undefined);
}

/** Replace the note's pitch movement — slides and bends. */
export function setNotePitch(id: string, pitch: NotePitch): Result {
  const found = requireEvent(id);
  if (!found.ok) return found;
  capture();
  store().updateEventArticulations(id, toPitchPatch(pitch) as never);
  return ok(undefined);
}

/** Softest → loudest, ordered by the curve itself rather than by how the lib's literal
 *  happens to be written, so a picker can't drift from it. */
export const DYNAMICS = Object.entries(DYNAMIC_VELOCITY)
  .sort(([, a], [, b]) => a - b)
  .map(([mark]) => mark as DynamicMark);

/**
 * Set (or clear, with `undefined`) a note's dynamic.
 *
 * The two fields are always written together: `dynamic` is display-only and
 * `velocity` is the only one playback reads, so letting them drift would give a
 * note labelled *pp* that plays at full force. Clearing has to clear both for
 * the same reason.
 */
export function setNoteDynamic(id: string, dynamic: DynamicMark | undefined): Result {
  const found = requireEvent(id);
  if (!found.ok) return found;
  capture();
  store().updateEventArticulations(id, {
    dynamic,
    velocity: dynamic === undefined ? undefined : DYNAMIC_VELOCITY[dynamic],
  });
  return ok(undefined);
}
