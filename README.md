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

- `docs/PLAN.md` — the design & phased plan
- `docs/HANDOFF.md` — current state + how to resume

## Status

Scaffold only. See `docs/HANDOFF.md` for the next steps.
