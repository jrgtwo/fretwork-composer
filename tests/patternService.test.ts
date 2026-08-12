import { describe, it, expect, beforeEach } from 'vitest';
import {
  DEFAULT_PATTERNS_STATE,
  INSTRUMENTS,
  PPQ,
  getTuning,
  noteAt as pitchAtFret,
  parseChordSymbol,
  pitchClass,
  usePatternsStore,
  type Pattern,
} from '@fretwork/lib';
import {
  beginEditGesture,
  chordGrip,
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
    // Written through the STORE, because the seam now refuses a fret above
    // `MAX_FRET` on the way in (AG-04: a rule only the popup's stepper applied
    // was a rule the agent walked straight past). This is the state an import or
    // a restored session produces, which is the state the clamp is for.
    usePatternsStore.getState().setEventFret(id, 30);

    nudgeSelectedFret(1);
    expect(getEditingPattern()!.events[0].fret).toBe(30);

    nudgeSelectedFret(-1);
    expect(getEditingPattern()!.events[0].fret).toBe(29);
  });
});

/**
 * AG-09 — the seam answers "where is this chord on this neck?".
 *
 * The claim under test is not that the lib can voice a chord (it can; that is
 * `voiceChordPreferred`'s test, not ours) but that the answer comes back for the
 * neck the CALLER NAMED, from the voicer that gives idiomatic shapes.
 *
 * ⚠ The instrument is an argument and no pattern need be open. It used to be
 * read off the open pattern, and the answer then depended on state the call did
 * not mention — which is what killed a run on 2026-08-11 (three necks asked for,
 * three identical calls, three ukulele answers). The "with nothing open" test
 * below is the one that pins the precondition's removal.
 *
 * ⚠ These assert EXACT grips, and that is deliberate. Bounds are not enough to
 * state either claim: `getTuningsForInstrument(id)[0]` happens to equal every
 * instrument's `defaultTuningId` in today's catalog — which is exactly WHY that
 * shortcut is a trap and why no test can catch it — but a wrong tuning of the
 * right WIDTH (`drop-d`, `ukulele-low-g`), or the algorithmic `voiceChord` in
 * place of `voiceChordPreferred`, all produce plausible-looking cells that pass
 * every bound. A pinned shape is what actually fails when the source moves. The
 * pitch-class check below is the same claim stated tuning-first, so it survives
 * the lib changing its preferred shapes.
 */
describe('chordGrip', () => {
  // NO default neck. The whole point of the change is that the instrument is
  // named in the call, and a helper that quietly supplies one is a suite that
  // reads as if it were not.
  const grip = (symbol: string, instrumentId: string) => {
    const result = chordGrip(symbol, instrumentId);
    if (!result.ok) throw new Error(`refused: ${result.reason}`);
    return result.value;
  };

  const refusal = (symbol: string, instrumentId: string) => {
    const result = chordGrip(symbol, instrumentId);
    if (result.ok) throw new Error('expected a refusal');
    return result.reason;
  };

  /** Every cell sounds a note OF the chord, on the strings this tuning actually
   *  has. Derived from the tuning rather than from a remembered shape, so it
   *  states "these frets are this chord on this neck" without also pinning which
   *  voicing the lib prefers. */
  const soundsTheChord = (symbol: string, instrumentId: string, tuningId: string) => {
    const voicing = grip(symbol, instrumentId);
    const strings = getTuning(tuningId)!.strings;
    const wanted = parseChordSymbol(symbol)!.pitchClasses;
    expect(voicing.cells.length).toBeGreaterThan(0);
    for (const cell of voicing.cells) {
      expect(cell.stringIndex).toBeLessThan(strings.length);
      expect(wanted).toContain(pitchClass(pitchAtFret(strings[cell.stringIndex], cell.fret)));
    }
  };

  it('names the symbol it could not read', () => {
    // The symbol is IN the sentence: a caller sending a whole progression can
    // only respell the one that failed if it is told which one that was.
    expect(refusal('H7', 'guitar')).toContain('H7');
    expect(refusal('', 'guitar')).toContain('chord symbol');
  });

  it('names the instrument it does not have a neck for', () => {
    // Not a fallback to guitar, which `patternInstrumentId` does for a stored
    // pattern: a caller that asked for the wrong neck by name wants to hear so
    // rather than be handed six strings under a bass's label.
    expect(refusal('A7', 'theremin')).toContain('theremin');
    expect(refusal('A7', '')).toContain('guitar');
    // THE NECK IS CHECKED FIRST, because it is the call-wide fact and the symbol
    // is the per-item one: a caller that got both wrong hears about the neck it
    // asked for, not about the first chord of a progression it will have to send
    // again anyway.
    expect(refusal('H7', 'theremin')).toContain('theremin');
    expect(refusal('H7', 'theremin')).not.toContain('chord symbol');
  });

  it('answers with NOTHING open, so a plan can ask before it builds', () => {
    // The precondition's removal, pinned. Asking what a chord looks like on a
    // bass before any pattern exists is what a planning step wants to do, and
    // forcing a pattern open first is what produced the open-three-then-ask-
    // three shape the 2026-08-11 run died of.
    usePatternsStore.setState({
      ...DEFAULT_PATTERNS_STATE,
      library: { patterns: [], compositions: [], collections: [] },
    });
    expect(getEditingPattern()).toBeNull();

    expect(grip('A7', 'bass').cells).toEqual([
      { stringIndex: 0, fret: 5 },
      { stringIndex: 1, fret: 4 },
      { stringIndex: 2, fret: 5 },
      { stringIndex: 3, fret: 6 },
    ]);
  });

  it('answers on the guitar with the open shape a guitarist would play', () => {
    const voicing = grip('A7', 'guitar');

    expect(voicing.symbol).toBe('A7');
    expect(voicing.root).toBe('A');
    // Tonal's vocabulary, passed through rather than re-spelled here — the model
    // reads it, and inventing a second name for a quality the lib already names
    // is how the two drift.
    expect(voicing.type).toBe('dominant seventh');
    expect(voicing.notes).toEqual(['A', 'C#', 'E', 'G']);
    // x02020 — the open A7. The ALGORITHMIC voicer answers this chord with a
    // six-string barre at the fifth fret, so this is also what pins
    // `voiceChordPreferred` as the voicer in use.
    expect(voicing.cells).toEqual([
      { stringIndex: 1, fret: 0 },
      { stringIndex: 2, fret: 2 },
      { stringIndex: 3, fret: 0 },
      { stringIndex: 4, fret: 2 },
      { stringIndex: 5, fret: 0 },
    ]);
    soundsTheChord('A7', 'guitar', 'standard');
  });

  it('gives the open G shape rather than the algorithmic one', () => {
    // The two differ only on strings 3 and 4 (open/open against fret 4/3), which
    // is the whole point: both are playable G chords and only one is the shape a
    // player means by "G".
    expect(grip('G', 'guitar').cells).toEqual([
      { stringIndex: 0, fret: 3 },
      { stringIndex: 1, fret: 2 },
      { stringIndex: 2, fret: 0 },
      { stringIndex: 3, fret: 0 },
      { stringIndex: 4, fret: 0 },
      { stringIndex: 5, fret: 3 },
    ]);
  });

  it('answers on a bass with a four-string grip, never a six-string one', () => {
    // Acceptance criterion 2. A guitar grip filtered down to four strings is
    // still four plausible-looking cells with plausible frets, so the SHAPE has
    // to be pinned: `standard` filtered would give [1,0][2,2][3,0], which passes
    // every bound this test could otherwise state.
    expect(grip('A7', 'bass').cells).toEqual([
      { stringIndex: 0, fret: 5 },
      { stringIndex: 1, fret: 4 },
      { stringIndex: 2, fret: 5 },
      { stringIndex: 3, fret: 6 },
    ]);
    soundsTheChord('A7', 'bass', 'bass-standard');
  });

  it('answers on a ukulele too, on the four strings a ukulele has', () => {
    // Reentrant (G4 C4 E4 A4), and the lib's voicer anchors "the bass" by string
    // INDEX rather than by pitch — so the anchor lands on the high-G string and
    // cell 0 here is C5, the TOP note of the chord. Noted rather than worked
    // around: the grip is still four real cells on four real strings, which is
    // what this seam promises. `read_chord_voicings` says so in its reply.
    expect(grip('C', 'ukulele').cells).toEqual([
      { stringIndex: 0, fret: 5 },
      { stringIndex: 1, fret: 4 },
      { stringIndex: 2, fret: 3 },
      { stringIndex: 3, fret: 3 },
    ]);
    soundsTheChord('C', 'ukulele', 'ukulele-standard');
  });

  it('answers the SAME symbol differently for two instruments, in the same breath', () => {
    // The property the whole change exists for: the answer follows the argument
    // and nothing else. The open pattern is left on guitar throughout, so a seam
    // still reading it would give the guitar's cells for both.
    expect(patternInstrumentId(getEditingPattern()!)).toBe('guitar');

    const onGuitar = grip('G', 'guitar').cells;
    const onBass = grip('G', 'bass').cells;

    expect(onGuitar).toHaveLength(6);
    expect(onBass).toEqual([
      { stringIndex: 0, fret: 3 },
      { stringIndex: 1, fret: 2 },
      { stringIndex: 2, fret: 0 },
      { stringIndex: 3, fret: 4 },
    ]);
    // NOT the guitar's first four cells: a shared low E, A and D make [0..2]
    // identical, and string 3 is where a trimmed guitar grip gives itself away.
    expect(onBass[3]).not.toEqual(onGuitar[3]);
  });

  it('changes nothing about the pattern', () => {
    stampNote({ stringIndex: 4, fret: 5, tick: 0, durationTicks: PPQ });
    const before = JSON.stringify(getEditingPattern());

    grip('A7', 'guitar');
    grip('D9', 'bass');

    expect(JSON.stringify(getEditingPattern())).toBe(before);
  });
});
