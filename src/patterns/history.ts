/**
 * Undo/redo stacks.
 *
 * ⚠ TEMPORARY — this belongs in `@fretwork/lib`, not here. See docs/FOLLOW-UPS.md.
 *
 * The lib has no history support and creates its store internally, so we can't
 * wrap it with a temporal middleware from outside. Until the lib grows undo (or
 * at least a `replacePattern` action), we keep our own stacks here.
 *
 * Deliberately generic and storage-agnostic: it holds opaque snapshots and knows
 * nothing about `Pattern`, the store, or React. That keeps it a drop-in to delete
 * once the lib takes over — the seam is `patternService`, which is the only
 * module that calls this.
 */

export interface History<T> {
  capture(snapshot: T): void;
  /** Swap `current` for the previous snapshot. Returns null if there is none. */
  undo(current: T): T | null;
  redo(current: T): T | null;
  canUndo(): boolean;
  canRedo(): boolean;
  /**
   * Begin a multi-step edit (a drag). Only `snapshot` is recorded, and captures
   * during the gesture are ignored, so the whole gesture undoes as one step.
   */
  beginGesture(snapshot: T): void;
  endGesture(opts?: { changed?: boolean }): void;
  clear(): void;
  subscribe(listener: () => void): () => void;
}

const DEFAULT_LIMIT = 100;

export function createHistory<T>({ limit = DEFAULT_LIMIT } = {}): History<T> {
  let past: T[] = [];
  let future: T[] = [];
  let gesture: { snapshot: T } | null = null;
  const listeners = new Set<() => void>();

  const notify = () => listeners.forEach((l) => l());

  const push = (snapshot: T) => {
    past = [...past, snapshot].slice(-limit);
    future = [];
  };

  return {
    capture(snapshot) {
      // Inside a gesture the pre-gesture snapshot already covers us.
      if (gesture) return;
      push(snapshot);
      notify();
    },

    beginGesture(snapshot) {
      gesture = { snapshot };
    },

    endGesture({ changed = true } = {}) {
      const pending = gesture;
      gesture = null;
      if (!pending || !changed) return;
      push(pending.snapshot);
      notify();
    },

    undo(current) {
      const previous = past.at(-1);
      if (previous === undefined) return null;
      past = past.slice(0, -1);
      future = [current, ...future];
      notify();
      return previous;
    },

    redo(current) {
      const next = future[0];
      if (next === undefined) return null;
      future = future.slice(1);
      past = [...past, current];
      notify();
      return next;
    },

    canUndo: () => past.length > 0,
    canRedo: () => future.length > 0,

    clear() {
      past = [];
      future = [];
      gesture = null;
      notify();
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
