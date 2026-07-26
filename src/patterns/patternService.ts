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
import {
  usePatternsStore,
  selectEditingPattern,
  type Pattern,
  type PatternEvent,
  type Tick,
} from '@fretwork/lib';

type SelectionMode = 'replace' | 'add' | 'toggle';

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

// ---------------------------------------------------------------- writing ---

/** Create a fresh pattern and open it for editing. */
export function openBlankPattern(name?: string): void {
  const id = store().createPattern(name);
  store().openPatternForEditing(id);
  store().selectEvents([], 'replace');
}

/** Open whatever pattern was last edited, seeding a draft if there is none. */
export function ensurePattern(): void {
  store().ensureEditingPattern();
}

export interface StampArgs {
  stringIndex: number;
  fret: number;
  tick: Tick;
  durationTicks?: Tick;
}

/**
 * Place a note at an explicit tick.
 *
 * The store's `stampAt` always stamps at its own cursor, so we move the cursor
 * first — that's the intended flow, and it keeps the cursor where the user last
 * acted. A stamp that would overlap an existing note on the same string is
 * rejected by the lib and simply leaves the pattern unchanged.
 */
export function stampNote({ stringIndex, fret, tick, durationTicks }: StampArgs): void {
  const s = store();
  s.setCursorTick(tick);
  if (durationTicks !== undefined) {
    const before = getEditingPattern()?.events.map((e) => e.id) ?? [];
    s.stampAt({ stringIndex, fret }, false);
    const added = getEditingPattern()?.events.find((e) => !before.includes(e.id));
    if (added) s.resizeEvent(added.id, durationTicks);
    return;
  }
  s.stampAt({ stringIndex, fret }, false);
}

export function moveNote(id: string, startTick: Tick, stringIndex?: number): void {
  store().moveEvent(id, startTick, stringIndex);
}

export function resizeNote(id: string, durationTicks: Tick): void {
  store().resizeEvent(id, durationTicks);
}

export function setNoteFret(id: string, fret: number): void {
  store().setEventFret(id, fret);
}

export function deleteNotes(ids: readonly string[]): void {
  store().deleteEvents(ids);
}

export function selectNotes(ids: readonly string[], mode: SelectionMode = 'replace'): void {
  store().selectEvents(ids, mode);
}
