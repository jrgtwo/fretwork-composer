import { describe, it, expect, beforeEach } from 'vitest';
import { createHistory } from '../src/patterns/history';

/** Stand-in for a Pattern — history never inspects the snapshot it holds. */
const snap = (n: number) => ({ id: 'p', events: n });

describe('createHistory', () => {
  let history: ReturnType<typeof createHistory<ReturnType<typeof snap>>>;

  beforeEach(() => {
    history = createHistory();
  });

  it('starts with nothing to undo or redo', () => {
    expect(history.canUndo()).toBe(false);
    expect(history.canRedo()).toBe(false);
  });

  it('undoes back to the captured snapshot', () => {
    history.capture(snap(1));
    expect(history.canUndo()).toBe(true);

    expect(history.undo(snap(2))).toEqual(snap(1));
    expect(history.canUndo()).toBe(false);
    expect(history.canRedo()).toBe(true);
  });

  it('redoes forward again', () => {
    history.capture(snap(1));
    history.undo(snap(2));

    expect(history.redo(snap(1))).toEqual(snap(2));
    expect(history.canRedo()).toBe(false);
    expect(history.canUndo()).toBe(true);
  });

  it('walks back through several steps in order', () => {
    history.capture(snap(1));
    history.capture(snap(2));
    history.capture(snap(3));

    expect(history.undo(snap(4))).toEqual(snap(3));
    expect(history.undo(snap(3))).toEqual(snap(2));
    expect(history.undo(snap(2))).toEqual(snap(1));
    expect(history.canUndo()).toBe(false);
  });

  it('returns null when there is nothing to undo or redo', () => {
    expect(history.undo(snap(1))).toBeNull();
    expect(history.redo(snap(1))).toBeNull();
  });

  it('drops the redo stack once a new edit is captured', () => {
    history.capture(snap(1));
    history.undo(snap(2));
    expect(history.canRedo()).toBe(true);

    history.capture(snap(9));

    expect(history.canRedo()).toBe(false);
  });

  // A drag fires dozens of mutations but has to collapse into ONE undo step.
  describe('gestures', () => {
    it('captures only the state from before the gesture began', () => {
      history.beginGesture(snap(1));
      history.capture(snap(2));
      history.capture(snap(3));
      history.endGesture();

      expect(history.undo(snap(4))).toEqual(snap(1));
      expect(history.canUndo()).toBe(false);
    });

    it('records nothing for a gesture that changed nothing', () => {
      history.beginGesture(snap(1));
      history.endGesture({ changed: false });

      expect(history.canUndo()).toBe(false);
    });

    it('resumes normal capture after the gesture ends', () => {
      history.beginGesture(snap(1));
      history.endGesture();
      history.capture(snap(2));

      expect(history.undo(snap(3))).toEqual(snap(2));
      expect(history.undo(snap(2))).toEqual(snap(1));
    });
  });

  it('caps the stack so long sessions do not grow without bound', () => {
    const limited = createHistory<ReturnType<typeof snap>>({ limit: 3 });
    [1, 2, 3, 4, 5].forEach((n) => limited.capture(snap(n)));

    limited.undo(snap(6));
    limited.undo(snap(5));
    limited.undo(snap(4));

    expect(limited.canUndo()).toBe(false); // only the last 3 were kept
  });

  it('notifies subscribers when the stacks change', () => {
    let calls = 0;
    const unsubscribe = history.subscribe(() => calls++);

    history.capture(snap(1));
    history.undo(snap(2));
    unsubscribe();
    history.capture(snap(3));

    expect(calls).toBe(2);
  });

  it('clears both stacks', () => {
    history.capture(snap(1));
    history.undo(snap(2));

    history.clear();

    expect(history.canUndo()).toBe(false);
    expect(history.canRedo()).toBe(false);
  });
});
