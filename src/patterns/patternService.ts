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
  usePatternsStore,
  selectEditingPattern,
  type Pattern,
  type PatternEvent,
  type Tick,
} from '@fretwork/lib';
import { createHistory } from './history';

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

// ------------------------------------------------------------------ undo ---
// ⚠ Belongs in the lib — see docs/FOLLOW-UPS.md. Everything undo-related is
// confined to this section plus ./history so it can be deleted in one go.

const history = createHistory<Pattern>();

/**
 * The one place we reach past the lib's public actions.
 *
 * The store exposes granular ops and a metadata patch, but no way to write a
 * whole pattern back — which is exactly what restoring a snapshot needs. Until
 * the lib grows `replacePattern(id, pattern)`, we swap the entry in `library`
 * ourselves. Keeping it in a single function means the lib migration touches
 * one call site.
 */
function writePatternBack(pattern: Pattern): void {
  usePatternsStore.setState((state) => ({
    library: {
      ...state.library,
      patterns: state.library.patterns.map((p) => (p.id === pattern.id ? pattern : p)),
    },
  }));
}

/** Snapshot the current pattern before a mutation. */
function capture(): void {
  const pattern = getEditingPattern();
  if (pattern) history.capture(pattern);
}

/**
 * Bracket a multi-step edit — a drag fires dozens of mutations but must undo as
 * one step. Safe to call without a pattern open.
 */
export function beginEditGesture(): void {
  const pattern = getEditingPattern();
  if (pattern) history.beginGesture(pattern);
}

export function endEditGesture(changed = true): void {
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

export function clearHistory(): void {
  history.clear();
}

/** React hook: whether undo/redo are currently available. */
export function useHistoryState(): { canUndo: boolean; canRedo: boolean } {
  const canUndo = useSyncExternalStore(history.subscribe, history.canUndo, history.canUndo);
  const canRedo = useSyncExternalStore(history.subscribe, history.canRedo, history.canRedo);
  return { canUndo, canRedo };
}

// ---------------------------------------------------------------- writing ---

/** Create a fresh pattern and open it for editing. */
export function openBlankPattern(name?: string): void {
  const id = store().createPattern(name);
  store().openPatternForEditing(id);
  store().selectEvents([], 'replace');
  // History is per-pattern; carrying it across a switch would undo into a
  // pattern that is no longer open.
  history.clear();
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
  capture();
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
  capture();
  store().moveEvent(id, startTick, stringIndex);
}

export function resizeNote(id: string, durationTicks: Tick): void {
  capture();
  store().resizeEvent(id, durationTicks);
}

export function setNoteFret(id: string, fret: number): void {
  capture();
  store().setEventFret(id, fret);
}

export function deleteNotes(ids: readonly string[]): void {
  capture();
  store().deleteEvents(ids);
}

export function selectNotes(ids: readonly string[], mode: SelectionMode = 'replace'): void {
  store().selectEvents(ids, mode);
}
