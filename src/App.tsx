// The app shell. Kept intentionally bare — phase 1 adds a minimal pattern surface
// (create → render → play via @fretwork/lib) and an isolated `src/ai/` module that
// embeds the harness in-process. See docs/PLAN.md and docs/HANDOFF.md.
export function App() {
  return (
    <main className="app">
      <h1>Fretwork Composer</h1>
      <p className="muted">
        Scaffold ready. Next: wire <code>@fretwork/lib</code> for a minimal pattern (create → play),
        then embed the harness in-process under <code>src/ai/</code>.
      </p>
    </main>
  );
}
