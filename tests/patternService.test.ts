import { describe, it, expect, beforeEach } from 'vitest';
import { INSTRUMENTS, PPQ, type Pattern } from '@fretwork/lib';
import {
  beginEditGesture,
  patternInstrumentId,
  deleteNotes,
  endEditGesture,
  getEditingPattern,
  getSelectedIds,
  moveNote,
  moveNotesBy,
  nudgeSelectedFret,
  resizeNotesBy,
  snapshotForDrag,
  snapshotForResize,
  openBlankPattern,
  redo,
  resizeNote,
  selectNotes,
  setNoteFret,
  setSelectedFret,
  stampNote,
  undo,
} from '../src/patterns/patternService';

const noteAt = (index = 0) => getEditingPattern()!.events[index];

beforeEach(() => {
  openBlankPattern('Test pattern');
});

describe('patternInstrumentId', () => {
  const on = (instrumentId: string) => patternInstrumentId({ instrumentId } as Pattern);

  it('passes through every instrument the lib has a neck for', () => {
    // Read off the lib's catalog rather than listed here: `FretInstrumentId` and
    // `INSTRUMENTS` grow together on the lib side, and a hardcoded list would keep
    // resolving a newly-added instrument to guitar — which then surfaces as the pattern
    // being drawn on the wrong neck rather than as an unknown id.
    for (const instrument of INSTRUMENTS) expect(on(instrument.id)).toBe(instrument.id);
    expect(INSTRUMENTS.length).toBeGreaterThan(1);
  });

  it('falls back to guitar for an id the catalog does not know', () => {
    // A pattern from an import or a future lib version can name anything, and every
    // consumer downstream (voice builder, tuning list, `InstrumentDef`) needs a real id.
    expect(on('theremin')).toBe('guitar');
    expect(on('')).toBe('guitar');
  });
});

describe('patternService', () => {
  it('opens a blank pattern to edit', () => {
    const pattern = getEditingPattern();
    expect(pattern?.name).toBe('Test pattern');
    expect(pattern?.events).toHaveLength(0);
  });

  it('stamps a note at an explicit tick', () => {
    stampNote({ stringIndex: 4, fret: 5, tick: PPQ * 2, durationTicks: PPQ / 2 });

    const event = noteAt();
    expect(event.stringIndex).toBe(4);
    expect(event.fret).toBe(5);
    expect(event.startTick).toBe(PPQ * 2);
  });

  it('moves a note in time and between strings', () => {
    stampNote({ stringIndex: 4, fret: 5, tick: 0, durationTicks: PPQ / 2 });

    moveNote(noteAt().id, PPQ, 2);

    expect(noteAt().startTick).toBe(PPQ);
    expect(noteAt().stringIndex).toBe(2);
  });

  it('resizes a note', () => {
    stampNote({ stringIndex: 4, fret: 5, tick: 0, durationTicks: PPQ / 2 });

    resizeNote(noteAt().id, PPQ);

    expect(noteAt().durationTicks).toBe(PPQ);
  });

  it('changes a note fret', () => {
    stampNote({ stringIndex: 4, fret: 5, tick: 0, durationTicks: PPQ / 2 });

    setNoteFret(noteAt().id, 12);

    expect(noteAt().fret).toBe(12);
  });

  it('deletes notes', () => {
    stampNote({ stringIndex: 4, fret: 5, tick: 0, durationTicks: PPQ / 2 });
    const id = noteAt().id;

    deleteNotes([id]);

    expect(getEditingPattern()!.events).toHaveLength(0);
  });

  it('tracks selection', () => {
    stampNote({ stringIndex: 4, fret: 5, tick: 0, durationTicks: PPQ / 2 });
    const id = noteAt().id;

    selectNotes([id]);
    expect(getSelectedIds()).toEqual([id]);

    selectNotes([]);
    expect(getSelectedIds()).toEqual([]);
  });

  // These are the lib guarantees the seam exists to give us for free.
  describe('invariants inherited from the lib', () => {
    it('refuses to stamp on top of an existing note on the same string', () => {
      stampNote({ stringIndex: 4, fret: 5, tick: 0, durationTicks: PPQ });
      stampNote({ stringIndex: 4, fret: 7, tick: PPQ / 2, durationTicks: PPQ });

      expect(getEditingPattern()!.events).toHaveLength(1);
    });

    it('allows the same tick on a different string', () => {
      stampNote({ stringIndex: 4, fret: 5, tick: 0, durationTicks: PPQ });
      stampNote({ stringIndex: 2, fret: 7, tick: 0, durationTicks: PPQ });

      expect(getEditingPattern()!.events).toHaveLength(2);
    });

    it('clamps a resize so it cannot swallow the next note on that string', () => {
      stampNote({ stringIndex: 4, fret: 5, tick: 0, durationTicks: PPQ / 2 });
      stampNote({ stringIndex: 4, fret: 7, tick: PPQ, durationTicks: PPQ / 2 });

      const first = getEditingPattern()!.events.find((e) => e.startTick === 0)!;
      resizeNote(first.id, PPQ * 4);

      const resized = getEditingPattern()!.events.find((e) => e.id === first.id)!;
      expect(resized.startTick + resized.durationTicks).toBeLessThanOrEqual(PPQ);
    });

    it('rejects a move that would overlap another note on that string', () => {
      stampNote({ stringIndex: 4, fret: 5, tick: 0, durationTicks: PPQ });
      stampNote({ stringIndex: 4, fret: 7, tick: PPQ * 2, durationTicks: PPQ });

      const second = getEditingPattern()!.events.find((e) => e.startTick === PPQ * 2)!;
      moveNote(second.id, 0);

      // unchanged — the op returns the pattern untouched rather than corrupting it
      expect(getEditingPattern()!.events.find((e) => e.id === second.id)!.startTick).toBe(PPQ * 2);
    });

    it('grows the pattern to fit a note placed beyond the end', () => {
      const before = getEditingPattern()!.durationTicks;

      stampNote({ stringIndex: 4, fret: 5, tick: before + PPQ * 4, durationTicks: PPQ });

      expect(getEditingPattern()!.durationTicks).toBeGreaterThan(before);
    });

    it('shrinks the pattern back when that note is removed', () => {
      const before = getEditingPattern()!.durationTicks;
      stampNote({ stringIndex: 4, fret: 5, tick: before + PPQ * 4, durationTicks: PPQ });
      const grown = getEditingPattern()!.durationTicks;
      expect(grown).toBeGreaterThan(before);

      deleteNotes([noteAt().id]);

      expect(getEditingPattern()!.durationTicks).toBeLessThan(grown);
    });
  });
});

describe('undo / redo', () => {
  it('undoes a stamp and redoes it', () => {
    stampNote({ stringIndex: 4, fret: 5, tick: 0, durationTicks: PPQ / 2 });
    expect(getEditingPattern()!.events).toHaveLength(1);

    undo();
    expect(getEditingPattern()!.events).toHaveLength(0);

    redo();
    expect(getEditingPattern()!.events).toHaveLength(1);
  });

  it('undoes a delete', () => {
    stampNote({ stringIndex: 4, fret: 5, tick: 0, durationTicks: PPQ / 2 });
    const id = noteAt().id;
    deleteNotes([id]);
    expect(getEditingPattern()!.events).toHaveLength(0);

    undo();

    expect(getEditingPattern()!.events.map((e) => e.id)).toEqual([id]);
  });

  it('undoes a fret change', () => {
    stampNote({ stringIndex: 4, fret: 5, tick: 0, durationTicks: PPQ / 2 });
    setNoteFret(noteAt().id, 12);
    expect(noteAt().fret).toBe(12);

    undo();

    expect(noteAt().fret).toBe(5);
  });

  it('collapses a whole gesture into one undo step', () => {
    stampNote({ stringIndex: 4, fret: 5, tick: 0, durationTicks: PPQ / 2 });
    const id = noteAt().id;

    // A drag: many moves, one undoable step.
    beginEditGesture();
    moveNote(id, PPQ);
    moveNote(id, PPQ * 2);
    moveNote(id, PPQ * 3);
    endEditGesture();
    expect(noteAt().startTick).toBe(PPQ * 3);

    undo();

    expect(noteAt().startTick).toBe(0);
  });

  it('records nothing for a gesture that moved nothing', () => {
    stampNote({ stringIndex: 4, fret: 5, tick: 0, durationTicks: PPQ / 2 });

    beginEditGesture();
    endEditGesture(false);
    undo();

    // the stamp is what gets undone, not a phantom empty gesture
    expect(getEditingPattern()!.events).toHaveLength(0);
  });

  it('does nothing when there is no history', () => {
    expect(() => undo()).not.toThrow();
    expect(getEditingPattern()!.events).toHaveLength(0);
  });

  it('starts a new pattern with a clean history', () => {
    stampNote({ stringIndex: 4, fret: 5, tick: 0, durationTicks: PPQ / 2 });
    openBlankPattern('Another');

    undo();

    expect(getEditingPattern()!.name).toBe('Another');
    expect(getEditingPattern()!.events).toHaveLength(0);
  });
});

describe('group editing', () => {
  /** Three notes a beat apart, ascending strings. */
  function seedThree() {
    stampNote({ stringIndex: 1, fret: 5, tick: 0, durationTicks: PPQ / 2 });
    stampNote({ stringIndex: 2, fret: 5, tick: PPQ, durationTicks: PPQ / 2 });
    stampNote({ stringIndex: 3, fret: 5, tick: PPQ * 2, durationTicks: PPQ / 2 });
    return getEditingPattern()!.events.map((e) => e.id);
  }

  it('moves every selected note by the same delta', () => {
    const ids = seedThree();
    const before = getEditingPattern()!.events.map((e) => e.startTick);

    moveNotesBy(snapshotForDrag(ids), PPQ, 0, 6);

    const after = getEditingPattern()!.events.map((e) => e.startTick);
    expect(after).toEqual(before.map((t) => t + PPQ));
  });

  it('moves a group across strings', () => {
    const ids = seedThree();

    moveNotesBy(snapshotForDrag(ids), 0, 1, 6);

    expect(getEditingPattern()!.events.map((e) => e.stringIndex)).toEqual([2, 3, 4]);
  });

  it('leaves unselected notes alone', () => {
    const ids = seedThree();
    const [first] = ids;
    const others = getEditingPattern()!.events.filter((e) => e.id !== first);

    moveNotesBy(snapshotForDrag([first]), PPQ * 4, 0, 6);

    others.forEach((before) => {
      const now = getEditingPattern()!.events.find((e) => e.id === before.id)!;
      expect(now.startTick).toBe(before.startTick);
    });
  });

  // The lib clamps a group move instead of rejecting it, so a group pushed past
  // the edge slides up against it rather than refusing to budge.
  it('clamps a move that would run off the strings', () => {
    const ids = seedThree();

    moveNotesBy(snapshotForDrag(ids), 0, 99, 6);

    const strings = getEditingPattern()!.events.map((e) => e.stringIndex);
    expect(Math.max(...strings)).toBeLessThanOrEqual(5);
    expect(new Set(strings).size).toBe(3); // still three distinct rows — the shape held
  });

  it('never moves a group to a negative tick', () => {
    const ids = seedThree();

    moveNotesBy(snapshotForDrag(ids), -PPQ * 10, 0, 6);

    expect(Math.min(...getEditingPattern()!.events.map((e) => e.startTick))).toBe(0);
  });

  it('resizes every selected note', () => {
    const ids = seedThree();

    resizeNotesBy(snapshotForResize(ids), PPQ / 4);

    // the last note has nothing after it, so it definitely grew
    const last = getEditingPattern()!.events.find((e) => e.startTick === PPQ * 2)!;
    expect(last.durationTicks).toBe(PPQ / 2 + PPQ / 4);
  });

  // Snapshots are taken at grab time; without them each pointermove would
  // compound on the previous result and the drag would accelerate.
  it('applies deltas against the snapshot, not the live position', () => {
    const ids = seedThree();
    const snapshots = snapshotForDrag(ids);

    moveNotesBy(snapshots, PPQ, 0, 6);
    moveNotesBy(snapshots, PPQ, 0, 6); // same delta, same snapshots

    expect(getEditingPattern()!.events.map((e) => e.startTick)).toEqual([PPQ, PPQ * 2, PPQ * 3]);
  });

  it('undoes a group move as one step', () => {
    const ids = seedThree();
    const before = getEditingPattern()!.events.map((e) => e.startTick);

    beginEditGesture();
    moveNotesBy(snapshotForDrag(ids), PPQ, 0, 6);
    moveNotesBy(snapshotForDrag(ids), PPQ * 2, 0, 6);
    endEditGesture();
    undo();

    expect(getEditingPattern()!.events.map((e) => e.startTick)).toEqual(before);
  });
});

describe('fret entry', () => {
  const seedOne = (fret: number) => {
    stampNote({ stringIndex: 1, fret, tick: 0, durationTicks: PPQ / 2 });
    const { id } = getEditingPattern()!.events[0];
    selectNotes([id]);
    return id;
  };

  it('puts the whole selection on an explicit fret', () => {
    stampNote({ stringIndex: 1, fret: 5, tick: 0, durationTicks: PPQ / 2 });
    stampNote({ stringIndex: 3, fret: 7, tick: PPQ, durationTicks: PPQ / 2 });
    selectNotes(getEditingPattern()!.events.map((e) => e.id));

    setSelectedFret(9);

    expect(getEditingPattern()!.events.map((e) => e.fret)).toEqual([9, 9]);
  });

  it('records nothing when there is no selection to put a fret on', () => {
    seedOne(5);
    selectNotes([]);

    setSelectedFret(9);

    // One step back is the stamp, not a snapshot of a no-op.
    undo();
    expect(getEditingPattern()!.events).toHaveLength(0);
  });

  /**
   * The lib enforces no ceiling of its own, so a pattern can legitimately hold a
   * fret above ours — an import, or a restored session. The clamp has to read as
   * "no room in that direction", not flip the nudge around.
   */
  it('does not drag a note above the ceiling back down when nudged up', () => {
    const id = seedOne(5);
    setNoteFret(id, 30);

    nudgeSelectedFret(1);
    expect(getEditingPattern()!.events[0].fret).toBe(30);

    nudgeSelectedFret(-1);
    expect(getEditingPattern()!.events[0].fret).toBe(29);
  });
});
