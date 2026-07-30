# Fretwork Composer

An AI-assisted guitar **pattern & composition** builder on [`@fretwork/lib`](https://github.com/jrgtwo/fretwork-lib).
The user asks for a riff or composition; an agent creates it. The agent brain
([`agent-harness`](../agent-harness)) runs **in-process in the browser** — no app server.

- **Stack:** React 19 · Vite 8 · TypeScript 6 · Vitest 4
- **Domain:** `@fretwork/lib` (patterns/compositions, playback, timing)
- **Agent:** `agent-harness`, embedded via its in-process runner

## Getting started

```bash
pnpm install
pnpm dev
```

## Docs (local, gitignored)

- `docs/HANDOFF.md` — **start here.** Current state, architecture, and how to resume cold.
- `docs/FOLLOW-UPS.md` — known debt. Opens with "the two buckets": permanent adapter work vs
  lib gaps we're masking (each tagged `LIB-GAP(n)` in the source).
- `docs/PLAN.md` — the original design and phased plan.

## Status

A working **pattern editor**: timeline editing with articulations, undo, playback, and a
fretboard/tablature reference pane. The **agent isn't built yet** — see `docs/HANDOFF.md`.
