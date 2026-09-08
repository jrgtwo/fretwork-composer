# Fretwork Composer

An AI-assisted guitar **pattern & composition** builder on [`@fretwork/lib`](https://github.com/jrgtwo/fretwork-lib).
The user asks for a riff or composition; an agent creates it. The agent brain
([`agent-harness`](../agent-harness)) runs **in-process in the browser** — no app server.

- **Stack:** React 19 · Vite 8 · TypeScript 6 · Vitest 4 · Tone 15
- **Domain:** `@fretwork/lib` (patterns/compositions, playback, timing)
- **Agent:** `agent-harness`, embedded via its in-process runner

## Getting started

```bash
pnpm install
pnpm dev            # add ?theme=1 for the design-system reference
pnpm test
pnpm lint && pnpm exec tsc -b && pnpm build
```

`npm install` will not work — this app is pnpm, and npm's resolver crashes on the pnpm layout.

## Docs (local, gitignored)

- `CLAUDE.md` — **start here.** Whole-repo rules, the five seams, the file map, hard-won facts.
- `.claude/docs/HANDOFF.md` — what is being worked on, and the open lists.
- There is no separate architecture doc. Anything true about one module lives in that module's
  header comment — the voice editor as data in `src/voice/paramSchema.ts`, how a rack edit reaches
  the engine in `src/audio/playbackService.ts`, where the meters tap in `src/audio/levelMeters.ts`.
- `docs/FOLLOW-UPS.md` — known debt. Opens with "the two buckets": permanent adapter work vs lib
  gaps we're masking, each tagged `LIB-GAP(n)` in the source.
- `docs/PLAN-voice.md` — the current direction: the voice chain, redone section by section.

## Status

A working **pattern editor** — timeline editing with articulations, undo, playback, and a
fretboard/tablature reference pane — and a complete **composition page**: arrange placements
across up to eight tracks, edit every track's notes in its lane, and tune a voice rack per track.

The **agent runs in the browser** and both pages carry a command panel. Pattern commands and six
of the seven composition commands drive 43 tools through a single tool-using run; building a
backing track instead takes a tool-free route that returns validated JSON, assembles an
`ImportIR` in code and commits it through the lib's own import pipeline.
