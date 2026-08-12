/**
 * What the agent is OFFERED — the product surface, as a table.
 *
 * This file is the answer to "what can the AI do?", and it is data. Adding a
 * capability is a row; it is not a better system prompt, and it is not a new
 * component. That is the same decision `voice/paramSchema.ts` made on
 * 2026-07-30 and the same payoff: a table can be walked by a test, so
 * `tests/CommandCatalog.test.ts` can insist that every slot resolves, every
 * lib-derived slot's values came from the lib, and every tool named below
 * actually exists — none of which is checkable about a paragraph of prose.
 *
 * ── What belongs here, and what does not ────────────────────────────────────
 *
 * A row earns its place when the work is GENERATIVE or SWEEPING: something a
 * person would not want to do by hand thirty times, or something that needs
 * musical judgement. Everything else is already a gesture, and a command that
 * duplicates a gesture is worse than no command — it is a slower, less reliable
 * way to press a button that is right there.
 *
 * So, deliberately absent, and each of these was considered:
 *
 *   - **Change the pattern's instrument / rename a track / mute a track.** One
 *     click each. The TOOLS exist (the agent needs them mid-job); the commands
 *     do not.
 *   - **Save / rename / delete a voice.** Library management, not generation.
 *     `composition-track-tone` reaches `voice_set_for_track` because CHOOSING a
 *     tone is judgement; bookkeeping is not.
 *   - **Anything that starts playback.** No transport tool exists, on purpose —
 *     see `tools/index.ts`. A command that made a sound in a tab nobody is
 *     looking at is a bad command whatever the tools allow.
 *   - **Set the time signature.** A structural decision the whole arrangement
 *     already depends on; asking a model to change it under existing blocks is
 *     an invitation to a mess.
 *
 * The CONTENT below is a judgement call and is meant to be argued with — a row
 * is cheap to change, which is the point of making it data. Where a choice was
 * close, the comment says which way it went.
 *
 * ── Why the templates read the way they do ─────────────────────────────────
 *
 * They are long, and they state constraints that look obvious. That is on
 * purpose: each one encodes something that is TRUE OF THIS APP and that a model
 * reasoning from general musical knowledge gets wrong —
 *
 *   - pattern length auto-fits to content, so there is nothing to resize;
 *   - a tie swallows the note after it, so an articulation pass that adds ties
 *     silently deletes its own work;
 *   - a placed block is a deep copy, so fixing the pattern afterwards fixes
 *     nothing;
 *   - transposition drops notes that fall off the neck.
 *
 * ── Two axes, not one ──────────────────────────────────────────────────────
 *
 * A row carries a `page` AND, on the composition page, a `mode`. They are not
 * the same knob: `page` picks the agent, the tool set and the history a run
 * brackets against; `mode` only picks which rows are OFFERED. The full argument
 * is on `Command.mode` in `commandTypes`, and it is the reason edit mode adds
 * no rows here.
 *
 * A slot's VALUE goes into the template, never its label — see `commandTypes`.
 * Numbers that belong to the lib (the tick grid, the track cap) are never
 * written out in prose here; they arrive through a slot or through the tool's
 * own description, so this file cannot drift from the lib by being edited.
 */
import type { Command, CommandMode, CommandPage } from './commandTypes';

// ---------------------------------------------------------- pattern page ---

const PATTERN_COMMANDS: readonly Command[] = [
  {
    id: 'pattern-fix-timing',
    page: 'pattern',
    label: 'Fix the timing',
    summary: 'Pull every note onto a clean grid without changing which note is where.',
    slots: [
      {
        kind: 'choice',
        id: 'grid',
        source: 'subdivision',
        label: 'Grid',
        help: 'The smallest note value the tidied part should use.',
      },
    ],
    tools: ['read_pattern', 'pattern_move_notes', 'pattern_resize_notes'],
    template: `Tidy the timing of the pattern that is open.

Read the pattern first. Then for every note: move its start to the nearest multiple of {grid} ticks, and round its duration to the nearest whole multiple of {grid} ticks, never shorter than {grid}.

Send ALL the moves in one call and ALL the lengths in one call. The tools take a whole batch, a batch is one undo step, and a pattern corrected one note per call runs out of turns before it is finished.

Keep every note on the string it is already on, keep the notes in the order they are already in, and do not add, delete or re-fret anything. Where rounding would put two notes on the same string on top of each other, leave the later one where it is rather than stacking them.

Finish by saying how many notes you moved and how many you re-lengthened.`,
  },

  {
    id: 'pattern-generate',
    page: 'pattern',
    label: 'Generate a pattern',
    summary: 'Write a new pattern from nothing, in a key and scale you choose.',
    slots: [
      {
        kind: 'choice',
        id: 'instrument',
        source: 'instrument',
        label: 'Instrument',
        defaultFrom: 'editing-pattern-instrument',
      },
      { kind: 'choice', id: 'key', source: 'key', label: 'Key', defaultFrom: 'pattern-key' },
      { kind: 'choice', id: 'scale', source: 'scale', label: 'Scale', defaultFrom: 'pattern-scale' },
      {
        // "Character" is an authored enum because the lib models no such thing.
        // Compare `scale` directly above, which does not get one.
        kind: 'enum',
        id: 'character',
        label: 'Character',
        options: [
          { value: 'riff', label: 'Riff' },
          { value: 'arpeggiated figure', label: 'Arpeggio' },
          { value: 'chord progression', label: 'Chords' },
          { value: 'single-note melody', label: 'Melody' },
          { value: 'scale run', label: 'Run' },
        ],
        fallback: 'riff',
      },
      {
        kind: 'number',
        id: 'bars',
        label: 'Length',
        // A number of bars is INTENT, not a field: `fitPatternDuration` sets the
        // length from the content on every edit, and there is no length control
        // to build. The template says so in as many words.
        help: 'Roughly how much music to write. Pattern length follows the notes.',
        min: 1,
        max: 16,
        step: 1,
        unit: 'bars',
        fallback: 2,
      },
    ],
    tools: [
      'read_pattern',
      // Chords are one of the five characters this row offers, and an arpeggio
      // is a chord played one note at a time — both are fret arithmetic on a
      // neck the model has to hold in its head, and getting it from the app is
      // the difference between a wrong voicing and a right one.
      'read_chord_voicings',
      'pattern_open_blank',
      'pattern_set_instrument',
      'pattern_stamp_notes',
    ],
    template: `Write a new {character} for {instrument}, about {bars} bars long, in {key} {scale}.

Open a blank pattern, set its instrument, then stamp the notes. Read the pattern once before you choose fret numbers: it tells you the ticks per quarter note, the time signature, how many strings the instrument has and how far up the neck you can go. Frets past the end of the neck are refused.

Where the part is built on chords, ask read_chord_voicings for them with instrumentId "{instrument}" rather than working the frets out yourself — then choose which notes of each shape to play and when. Nothing has to be open to ask.

The pattern's length is not something you set — it auto-fits whatever you stamp. "About {bars} bars" means stamp that much music, not resize anything afterwards.

Stay inside {key} {scale}. Keep it playable by one pair of hands: never two notes on the same string at the same time, and no reach wider than about five frets. Finish by describing what you wrote.`,
  },

  {
    id: 'pattern-density',
    page: 'pattern',
    label: 'Make this busier or sparser',
    summary: 'Rewrite the rhythm at a different density, keeping the idea.',
    slots: [
      {
        // The ticket's own example of a legitimate authored enum: a direction of
        // travel is not a value the lib has a type for.
        kind: 'enum',
        id: 'direction',
        label: 'Direction',
        options: [
          { value: 'busier', label: 'Busier' },
          { value: 'sparser', label: 'Sparser' },
        ],
        fallback: 'busier',
      },
    ],
    tools: [
      'read_pattern',
      'pattern_stamp_notes',
      'pattern_delete_notes',
      'pattern_resize_notes',
    ],
    template: `Make the pattern that is open {direction}, and change nothing else about it.

Read the pattern first. Keep its key, its length, the strings it uses and its character recognisably the same — this is a rewrite of the rhythm, not a new idea. Busier means subdividing what is there and adding passing notes between the notes that already exist. Sparser means removing notes and letting the ones that remain ring longer.

Send everything you add in ONE stamp call, everything you remove in ONE delete call, and every new length in ONE resize call. The tools take whole batches, a batch is one undo step, and a rewrite done one note per call runs out of turns before it is finished.

Aim for about a third more or a third fewer notes, not double or half. Say what you added or removed.`,
  },

  {
    id: 'pattern-fit-key',
    page: 'pattern',
    label: 'Transpose to fit a key',
    summary: 'Move stray notes onto the nearest degree of a key, leaving the rhythm alone.',
    slots: [
      { kind: 'choice', id: 'key', source: 'key', label: 'Key', defaultFrom: 'pattern-key' },
      { kind: 'choice', id: 'scale', source: 'scale', label: 'Scale', defaultFrom: 'pattern-scale' },
    ],
    tools: ['read_pattern', 'pattern_set_note_frets'],
    template: `Move the notes of the pattern that is open so every one of them belongs to {key} {scale}.

Read the pattern first — it gives you each note's string and fret, and how far the neck goes. Shift each out-of-key note by the smallest number of frets that lands it on a degree of {key} {scale}; when up and down are equally close, go down. Send every re-fretting in ONE call: the tool takes a whole batch, and a pattern corrected one note per call runs out of turns before it is finished.

Keep every note on the string it is already on, keep every start tick and duration exactly as they are, and do not add or delete notes. Report which notes you moved and by how much.`,
  },

  {
    id: 'pattern-articulations',
    page: 'pattern',
    label: 'Add an articulation pass',
    summary: 'Mark how the existing notes are played — nothing moves.',
    slots: [
      {
        kind: 'enum',
        id: 'style',
        label: 'Style',
        options: [
          { value: 'smooth and legato', label: 'Legato' },
          { value: 'tight and palm-muted', label: 'Muted' },
          { value: 'aggressive and picked hard', label: 'Aggressive' },
          { value: 'loose and expressive', label: 'Expressive' },
        ],
        fallback: 'smooth and legato',
      },
    ],
    tools: [
      'read_pattern',
      'pattern_set_articulations',
      'pattern_set_pitches',
      'pattern_set_dynamics',
    ],
    template: `Add articulations to the pattern that is open so it plays back {style}. Do not move, add, delete or re-fret a single note — this pass only marks how the notes that are already there get played.

Read the pattern first, then mark every note in one call per tool — each of these takes a whole batch, and marking one note per call runs out of turns before the pass is finished. Hammer-ons and pull-offs only between notes that are next to each other on the same string. Palm mutes only on the lower strings. Slides only where both notes sit on the same string.

Do NOT set tieToNext. A tie swallows the note after it, and every articulation on the swallowed note stops sounding — a tie added here quietly deletes your own work.

Shape the dynamics as well, then say what you marked.`,
  },

  {
    id: 'pattern-feel',
    page: 'pattern',
    label: 'Set the feel',
    summary: 'Put the pattern on a tempo and a swing, and check it still reads at that speed.',
    slots: [
      {
        kind: 'choice',
        id: 'groove',
        source: 'groove',
        label: 'Groove',
        defaultFrom: 'pattern-groove',
      },
      {
        kind: 'number',
        id: 'bpm',
        label: 'Tempo',
        min: 20,
        // The transport's own extent, not the tools' 20–400. A command should
        // never be able to ask for a tempo a person could not type in the app.
        max: 300,
        step: 1,
        unit: 'bpm',
        fallback: 100,
        defaultFrom: 'pattern-bpm',
      },
    ],
    tools: ['read_pattern', 'pattern_set_playback'],
    template: `Set the open pattern's preferred tempo to {bpm} bpm and its groove preset to {groove}.

Then read the pattern back and say in one sentence whether the note lengths still make musical sense at that tempo — a sixteenth-note figure at 200 bpm is a different part from the same figure at 70. Do not change any notes; just tell me if it needs it.`,
  },
];

// ------------------------------------------------------ composition page ---

const COMPOSITION_COMMANDS: readonly Command[] = [
  {
    id: 'composition-backing-track',
    page: 'composition',
    mode: 'pattern',
    label: 'Create a backing track',
    summary: 'Build a whole arrangement — patterns, tracks and blocks — from a genre and a key.',
    slots: [
      {
        kind: 'enum',
        id: 'genre',
        label: 'Genre',
        // Authored, and the one enum here most likely to be edited. There is no
        // lib vocabulary for genre and there should not be — it is a hint to a
        // language model, not a value anything downstream consumes.
        options: [
          { value: 'blues', label: 'Blues' },
          { value: 'rock', label: 'Rock' },
          { value: 'funk', label: 'Funk' },
          { value: 'folk', label: 'Folk' },
          { value: 'country', label: 'Country' },
          { value: 'metal', label: 'Metal' },
          { value: 'jazz', label: 'Jazz' },
          { value: 'reggae', label: 'Reggae' },
          { value: 'latin', label: 'Latin' },
          { value: 'pop', label: 'Pop' },
        ],
        fallback: 'blues',
      },
      { kind: 'choice', id: 'key', source: 'key', label: 'Key', defaultFrom: 'composition-key' },
      {
        kind: 'choice',
        id: 'scale',
        source: 'scale',
        label: 'Scale',
        defaultFrom: 'composition-scale',
      },
      {
        kind: 'number',
        id: 'bpm',
        label: 'Tempo',
        min: 20,
        max: 300,
        step: 1,
        unit: 'bpm',
        fallback: 100,
        defaultFrom: 'composition-bpm',
      },
      {
        kind: 'choice',
        id: 'groove',
        source: 'groove',
        label: 'Groove',
        // The four presets, from the lib. "Heavy swing" is not a value; whoever
        // wants one picks Shuffle, which is what the lib calls it.
        defaultFrom: 'composition-groove',
      },
      {
        kind: 'number',
        id: 'bars',
        label: 'Length',
        min: 4,
        max: 64,
        step: 1,
        unit: 'bars',
        fallback: 12,
      },
    ],
    tools: [
      'read_composition',
      'read_pattern_library',
      // The row this ticket was written for. A {bars}-bar track over a
      // progression is a few dozen fret numbers per part, on whatever neck the
      // part is on, and every backing-track run that failed on 2026-08-09 failed
      // at that arithmetic rather than at the music.
      'read_chord_voicings',
      'composition_set_settings',
      'composition_add_track',
      'composition_set_track_instrument',
      'pattern_open_blank',
      'pattern_set_instrument',
      'pattern_stamp_notes',
      'composition_place_pattern',
    ],
    template: `Build a {genre} backing track in the open composition: {bars} bars in {key} {scale} at {bpm} bpm, with the groove preset {groove}.

Read the composition first. Set its tempo and groove, then work in this order for each part — write it as a pattern in the library (open a blank pattern, set its instrument, stamp the notes), then add the track it belongs on, then place the pattern along that track.

Decide the chord progression before you write anything, then ask read_chord_voicings for the whole progression — one call per instrument, naming that instrument, before you open anything. Play a part OUT of those shapes rather than stamping them whole on the downbeat.

Get each pattern right BEFORE you place it. A block on a track is a deep copy taken at placement time: editing the pattern afterwards does not reach blocks you have already placed.

There is a hard cap on tracks and composition_add_track will refuse past it — its description names the number. Plan the parts before you start adding them; two or three well-written parts beat eight thin ones. Repeat and vary a short pattern rather than writing {bars} bars of fresh material for every track.

Tell me what each track is when you are done.`,
  },

  {
    id: 'composition-bass-line',
    page: 'composition',
    mode: 'pattern',
    label: 'Create a bass line',
    summary: 'Write a bass part that follows what the arrangement is already doing.',
    slots: [
      {
        kind: 'enum',
        id: 'feel',
        label: 'Feel',
        options: [
          { value: 'root notes on the changes', label: 'Root notes' },
          { value: 'a walking line', label: 'Walking' },
          { value: 'driving eighth notes', label: 'Driving 8ths' },
          { value: 'a syncopated, funky line', label: 'Syncopated' },
        ],
        fallback: 'root notes on the changes',
      },
    ],
    tools: [
      'read_composition',
      // Every feel this row offers is built on the changes, and the bass's frets
      // for a chord are not the guitar's — a four-string neck in bass-standard
      // is exactly where a voicing carried over from a guitar goes wrong.
      'read_chord_voicings',
      'composition_add_track',
      'composition_set_track_instrument',
      'pattern_open_blank',
      'pattern_set_instrument',
      'pattern_stamp_notes',
      'composition_place_pattern',
    ],
    // Worth knowing but NOT worth saying in the prompt: LIB-GAP(15) — a track
    // carries no tuning, only the composition does, so a bass track voiced
    // against a guitar composition sounds an octave high. The template
    // therefore promises a bass PART, and never promises how it sounds; that
    // gap is the lib's to close and no wording here can.
    template: `Write a bass line for the open composition — {feel}.

Read the composition first and work out the harmony from the blocks that are already on it. Then write the line as one or more patterns on the bass instrument, add a bass track if there is not one already, and place the patterns so the line covers the same span as the rest of the arrangement.

Name the changes to read_chord_voicings with instrumentId "bass" and take the line's notes from what comes back — a bass neck's frets for a chord are not a guitar's, so ask for the bass and never carry a guitar shape over. Ask before you write anything; nothing has to be open.

Follow the existing parts rather than competing with them: land where they land, and stay out of the upper register.

Say which bars you covered and what the line is following.`,
  },

  {
    id: 'composition-harmony-track',
    page: 'composition',
    mode: 'pattern',
    label: 'Add a harmony track',
    summary: 'Double an existing track at an interval, on a track of its own.',
    slots: [
      {
        kind: 'choice',
        id: 'track',
        source: 'track',
        label: 'Track to double',
        defaultFrom: 'selected-track',
      },
      {
        // Semitones, authored. The lib models intervals only as raw numbers
        // (`IntervalSet`) with no catalog of named ones, so there is nothing to
        // bind to — and the VALUE is a semitone count, which is what
        // `composition_transpose_placement` actually takes.
        kind: 'enum',
        id: 'interval',
        label: 'Interval',
        options: [
          { value: '3', label: 'Minor 3rd', hint: '3 semitones' },
          { value: '4', label: 'Major 3rd', hint: '4 semitones' },
          { value: '5', label: 'Perfect 4th', hint: '5 semitones' },
          { value: '7', label: 'Perfect 5th', hint: '7 semitones' },
          { value: '12', label: 'Octave', hint: '12 semitones' },
        ],
        fallback: '3',
      },
    ],
    tools: [
      'read_composition',
      'composition_add_track',
      'composition_set_track_instrument',
      // The copy is `composition_duplicate_placements`, NOT a re-place from the
      // library. A block is a deep copy and `read_composition`'s `fromPatternId`
      // is provenance rather than a link — the pattern may have been edited or
      // never saved — so "place the same pattern again" is a route that only
      // sometimes exists. Duplicating the blocks themselves always does, and is
      // one undo step.
      'composition_duplicate_placements',
      'composition_transpose_placement',
    ],
    template: `Add a harmony track that doubles the track with id {track}, {interval} semitones above it.

Read the composition first. Add a new track on the same instrument as that one, duplicate every block from track {track} onto the new track with an offset of 0 ticks, and transpose each of the NEW blocks by {interval} semitones. Do not touch the original track.

Duplicate the blocks rather than placing patterns from the library: a block is a copy taken when it was placed, so the library pattern it came from may no longer match it, or may not be there at all.

Transposition is applied at playback and silently drops any note that lands off the end of the neck. Check what each transpose call returns and tell me if notes were dropped — a harmony missing its top notes is worse than one taken down an octave instead.`,
  },

  {
    id: 'composition-extend',
    page: 'composition',
    mode: 'pattern',
    label: 'Extend the arrangement',
    summary: 'Carry the arrangement on past where it currently stops.',
    slots: [
      {
        kind: 'number',
        id: 'bars',
        label: 'Extend by',
        min: 1,
        max: 64,
        step: 1,
        unit: 'bars',
        fallback: 8,
        // Defaults to how long the arrangement already is: "extend by" wants a
        // number of the same order as what is there, not a constant.
        defaultFrom: 'composition-bars',
      },
    ],
    tools: [
      'read_composition',
      'read_pattern_library',
      'composition_place_pattern',
      'composition_duplicate_placements',
      // Close call, and it went in: most of this row's work is repetition, which
      // needs no chords at all. But the part it writes FRESH is a new section
      // over a harmony that has to agree with what precedes it, and that is the
      // same fret arithmetic `composition-backing-track` gets this for.
      // `composition-harmony-track` is the row that does NOT get it — it
      // transposes existing blocks and never chooses a fret.
      'read_chord_voicings',
      'pattern_open_blank',
      // A new pattern written for a bass or ukulele track lands on the default
      // instrument unless this is called, and `read_composition` then reports it
      // as written for another instrument. `composition-bass-line` gets this
      // right; a row that writes patterns needs it whether or not the instrument
      // is the point of the command.
      'pattern_set_instrument',
      'pattern_stamp_notes',
    ],
    template: `Extend the open composition by {bars} more bars past where it currently ends.

Read the composition first to find where that is. Carry every track that is currently playing into the new section — a track that was busy going silent reads as a mistake, not as an arrangement choice. Reuse the patterns that are already in the library where the section should repeat; write new ones only where it should actually change, and set each new pattern's instrument to match the track it is going on. Where a new pattern moves to different chords, ask read_chord_voicings for them naming the instrument that pattern is for.

Do not move, shorten or delete anything that is already there. Say what the new section does.`,
  },

  {
    id: 'composition-lay-down-pattern',
    page: 'composition',
    mode: 'pattern',
    label: 'Lay a pattern down the timeline',
    summary: 'Repeat one library pattern along a track, back to back.',
    slots: [
      { kind: 'choice', id: 'pattern', source: 'pattern', label: 'Pattern' },
      {
        kind: 'choice',
        id: 'track',
        source: 'track',
        label: 'Track',
        defaultFrom: 'selected-track',
      },
      {
        kind: 'number',
        id: 'repeats',
        label: 'Copies',
        min: 1,
        max: 32,
        step: 1,
        fallback: 4,
      },
    ],
    tools: ['read_pattern_library', 'read_composition', 'composition_place_pattern'],
    template: `Place the pattern with id {pattern} onto the track with id {track}, {repeats} times back to back, starting at the first free tick after whatever that track already holds.

Read the library and the composition first so you know the pattern's length and where the track currently ends. Place all the copies in ONE call, so the whole thing is a single undo step.

Nothing moves blocks out of each other's way, so "back to back" is yours to space: each copy starts one pattern-length after the one before it. Get that right in the first call — a copy that would land on another, or on a block already there, refuses the whole call before anything is written. The reply gives every block's \`endTick\` to space the next one from.`,
  },

  {
    id: 'composition-balance-mix',
    page: 'composition',
    // Voice mode, and the one placement here that is a judgement rather than a
    // reading of the row. A mix is not a voice: this sets track levels and the
    // master, and touches no voice at all. It sits here because voice mode is
    // the mode that puts the racks and the mixer side by side, so "balance the
    // mix" is offered where a person is already thinking about how it sounds.
    // If the mixer ever gets a mode of its own, this row moves with it.
    mode: 'voice',
    label: 'Balance the mix',
    summary: 'Set the track levels so one part leads and nothing is buried.',
    slots: [
      {
        kind: 'choice',
        id: 'lead',
        source: 'track',
        label: 'Track to feature',
        defaultFrom: 'selected-track',
      },
    ],
    tools: ['read_composition', 'composition_set_track_mix', 'composition_set_master_volume'],
    template: `Balance the levels of the open composition so the track with id {lead} sits clearly in front and nothing else is buried.

Read the composition first — it gives you every track's volume, whether it is muted or soloed, and whether it is audible at all. Work in dB: a couple of dB is a real move and six is a big one.

Leave the mutes and solos exactly as you found them. A mix balanced with something soloed is not a mix. Touch the master only if the whole thing is too loud or too quiet. Say what you changed and why.`,
  },

  {
    id: 'composition-track-tone',
    page: 'composition',
    mode: 'voice',
    label: 'Dial in a tone',
    summary: 'Pick the voice for a track that suits the part it is playing.',
    slots: [
      {
        kind: 'choice',
        id: 'track',
        source: 'track',
        label: 'Track',
        defaultFrom: 'selected-track',
      },
      {
        kind: 'enum',
        id: 'tone',
        label: 'Tone',
        options: [
          { value: 'clean', label: 'Clean' },
          { value: 'warm and rounded', label: 'Warm' },
          { value: 'bright and cutting', label: 'Bright' },
          { value: 'crunchy, edge-of-breakup', label: 'Crunch' },
          { value: 'high-gain', label: 'High gain' },
        ],
        fallback: 'clean',
      },
    ],
    tools: ['read_composition', 'voice_list_for_track', 'voice_set_for_track'],
    template: `Give the track with id {track} a {tone} tone.

List the voices available for that track first and pick the one that already comes closest — a stock voice that fits beats a tweaked one that nearly does. Set it on the track, then say which you chose and what it changes about the sound.`,
  },
];

// ---------------------------------------------------------------- lookups ---

/** Every command, both pages. Ordered pattern-page-first, matching the order the
 *  app's own pages are built in. */
export const COMMAND_CATALOG: readonly Command[] = [
  ...PATTERN_COMMANDS,
  ...COMPOSITION_COMMANDS,
];

/**
 * One (page, mode) slice, frozen. `mode: undefined` means the whole page.
 *
 * A row with no `mode` shows in EVERY mode — the pattern page's rows are all
 * like that, and the property is what keeps a new row from being invisible
 * because whoever added it did not know modes existed.
 */
function offered(page: CommandPage, mode?: CommandMode): readonly Command[] {
  return Object.freeze(
    COMMAND_CATALOG.filter(
      (command) =>
        command.page === page &&
        (mode === undefined || command.mode === undefined || command.mode === mode),
    ),
  );
}

/**
 * The commands a page offers.
 *
 * Partitioned once at module load rather than filtered per call: the result is
 * a render-time value in the panel, and a fresh array every call is a new
 * identity every render — a `useMemo` dependency that never matches and a list
 * that rebuilds its children for nothing. Adding the mode axis did not weaken
 * that; it added a dimension to the SAME precomputed table, so every slice is
 * still one stable array.
 *
 * Still derived from the single `COMMAND_CATALOG` rather than declared as
 * separate exported arrays, so there is ONE list to add a row to and no command
 * can be reached from both pages by being listed twice.
 */
const BY_PAGE: Readonly<Record<CommandPage, readonly Command[]>> = {
  pattern: offered('pattern'),
  composition: offered('composition'),
};

/**
 * The same table with the mode axis added.
 *
 * The type annotation is load-bearing: a fourth `CommandMode` is a compile
 * error here until someone says what that mode offers, rather than a mode that
 * silently shows an empty rail.
 */
const BY_PAGE_AND_MODE: Readonly<
  Record<CommandPage, Readonly<Record<CommandMode, readonly Command[]>>>
> = {
  // Every mode gets the SAME array the mode-less call gets, not an equal copy.
  // Correct because no pattern row carries a `mode` — `CommandCatalog.test.ts`
  // ("leaves the pattern page untouched by modes") is what holds that — and it
  // matters because a caller that normalises to always pass a mode would
  // otherwise get a different identity for an identical list, which is the
  // render churn this table exists to prevent.
  pattern: {
    pattern: BY_PAGE.pattern,
    edit: BY_PAGE.pattern,
    voice: BY_PAGE.pattern,
  },
  composition: {
    pattern: offered('composition', 'pattern'),
    // Empty, and correct. Edit mode is served by the pattern page's six rows —
    // `openPlacementForEditing` aims the lib's pattern-editing pointer at the
    // block and `patternService.writePatternBack` routes to that placement's
    // snapshot — so the panel asks for `commandsForPage('pattern')` there. See
    // the note on `Command.mode`: `page` picks the agent, the tools and the
    // history; `mode` only picks what is offered.
    edit: offered('composition', 'edit'),
    voice: offered('composition', 'voice'),
  },
};

/**
 * `mode` is optional so the pattern page — which has no modes — is unaffected,
 * and so a caller that wants everything a page has can still ask for it.
 */
export function commandsForPage(page: CommandPage, mode?: CommandMode): readonly Command[] {
  return mode === undefined ? BY_PAGE[page] : BY_PAGE_AND_MODE[page][mode];
}

export function findCommand(id: string): Command | undefined {
  return COMMAND_CATALOG.find((command) => command.id === id);
}
