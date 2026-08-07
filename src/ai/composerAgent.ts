/**
 * The "composer" agent — AG-03's proof that the loop turns.
 *
 * ⚠ **This is a stub and is meant to be replaced.** It exists to answer one
 * question that nothing before it could: does a model running in this tab reach
 * a tool, does that tool reach a seam, and does the app change? One tool and
 * three notes is the whole budget. AG-04 already built the thirty-seven REAL
 * tools in `./tools`, and registering them is AG-05/AG-06's job — a stub proves
 * the path without spending prompt budget or making this ticket's failure modes
 * ambiguous.
 *
 * It names no harness type, for the same reason `./tools/types` does not: the
 * runner is `./agentService`'s business. What is here is a prompt and a
 * capability, which is what an agent IS.
 *
 * ── The one thing it is not allowed to get wrong ────────────────────────────
 *
 * The tool goes through `patternService` and nothing else. Not the lib's store,
 * not `composition-ops`, not a helper that "just" reads the store — that is the
 * single failure this ticket exists to rule out, because a rule the UI obeys and
 * the agent walks past is worse than no rule. The tripwire in
 * `tests/AgentTools.test.ts` enforces it on every file in this directory.
 */
import {
  PPQ,
  beginEditGesture,
  endEditGesture,
  openBlankPattern,
  stampNote,
} from '../patterns/patternService';
import {
  defineTool,
  fail,
  name as nameSchema,
  obj,
  ok,
  type AgentTool,
  type JsonValue,
} from './tools/types';
import type { AgentSpec } from './agentService';

/**
 * Three notes on the LOWEST string. `stringIndex: 0` is the low E on a guitar —
 * the bottom string physically and the TOP row on screen, because display order
 * is the reverse of index order. Written out here rather than derived so a
 * by-hand check has something exact to look at: open string, third fret, fifth
 * fret, one quarter note each.
 */
const RIFF: readonly { readonly stringIndex: number; readonly fret: number }[] = [
  { stringIndex: 0, fret: 0 },
  { stringIndex: 0, fret: 3 },
  { stringIndex: 0, fret: 5 },
];

/**
 * Create a pattern with a fixed three-note riff in it.
 *
 * **One tool call is one undo step.** Both seams count bracket depth, so the
 * bracket is taken here from the start rather than retrofitted: without it the
 * four writes below (one create, three stamps) are four steps and the user has
 * to press undo four times to get back to where the agent found them.
 *
 * `openBlankPattern` clears the history of the pattern it leaves behind and
 * re-arms this bracket on the new one, which is what makes a single undo land on
 * the fresh, empty pattern rather than somewhere in the middle of the riff.
 *
 * `changed` is false until something is actually written, so a create that the
 * library refuses does not leave an undo step restoring a state nothing left.
 */
export const SKETCH_STUB_RIFF: AgentTool = defineTool<{ name?: string }>({
  name: 'sketch_stub_riff',
  description:
    'Create a new pattern containing a fixed three-note riff on the lowest string. Takes no musical direction — it always writes the same three notes — and is here to prove the tool path works end to end.',
  parameters: obj({
    // `nameSchema`, not `str`: `minLength: 1`. The lib's `createEmptyPattern`
    // names a pattern by DEFAULT PARAMETER, so `''` is not replaced — it is
    // stored verbatim and shows in the library as a row with no label. The same
    // helper is what `pattern_open_blank` uses, for the same reason.
    name: nameSchema('Name for the new pattern. Omitted, the library names it.'),
  }),
  run: ({ name }) => {
    beginEditGesture();
    let changed = false;
    try {
      const opened = openBlankPattern(name);
      if (!opened.ok) return fail(opened.reason);
      changed = true;

      const notes: JsonValue[] = [];
      for (const [index, note] of RIFF.entries()) {
        const stamped = stampNote({
          stringIndex: note.stringIndex,
          fret: note.fret,
          tick: index * PPQ,
          durationTicks: PPQ,
          // Never omitted: without it `stampAt` falls back to the pattern page's
          // grid setting, which is "whatever the user last clicked" — not a
          // thing an agent can mean.
        });
        if (!stamped.ok) return fail(stamped.reason);
        notes.push({
          id: stamped.value.id,
          stringIndex: stamped.value.stringIndex,
          fret: stamped.value.fret,
          startTick: stamped.value.startTick,
          durationTicks: stamped.value.durationTicks,
        });
      }

      return ok({ patternId: opened.value.id, name: opened.value.name, notes });
    } catch (error) {
      // The same answer `oneUndoStep` gives in `./tools/patternTools`, and for
      // the same reason: a throw part-way through has already written something
      // — `openBlankPattern` can create and open a pattern and then fail to read
      // it back — and dropping the step would make the next undo skip STRAIGHT
      // PAST that partial edit into whatever came before. (`defineTool` catches
      // this and turns it into a refusal; the bracket still has to close first.)
      changed = true;
      throw error;
    } finally {
      endEditGesture(changed);
    }
  },
});

export const COMPOSER_AGENT: AgentSpec = {
  name: 'composer',
  systemPrompt: [
    'You are the composer inside a guitar pattern editor. You act by calling tools; the user cannot see anything you only describe.',
    'When asked for a riff, call sketch_stub_riff exactly once, then reply with one short sentence saying what you made.',
    'A tool result of the form {"ok":false,"reason":"…"} is a refusal, not a crash. Read the reason and say what happened — do not retry the identical call.',
  ].join('\n'),
  tools: [SKETCH_STUB_RIFF],
};

/** What the provisional trigger sends. Hardcoded on purpose — the command
 *  catalog (AG-05) is what turns a user's intent into an input string, and this
 *  ticket is explicitly not that. */
export const COMPOSER_SMOKE_INPUT = 'Sketch a riff for me.';
