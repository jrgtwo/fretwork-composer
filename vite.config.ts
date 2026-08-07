// `vitest/config`'s defineConfig is a superset of Vite's that types the `test` key natively.
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { statSync } from 'node:fs';
import path from 'node:path';

/**
 * Make the harness's build date part of Vite's dep-cache identity — AG-03.
 *
 * `agent-harness` is a `file:` sibling pinned at 0.0.0, so nothing about it ever
 * changes from Vite's point of view: it pre-bundles the dep once, serves it
 * under an IMMUTABLE `?v=<hash>` URL, and the browser then caches that build for
 * the life of the cache directory. Rebuild the harness and the app goes on
 * running the old one — and you debug the wrong repo, which is the failure
 * `docs/PLAN.md` recorded in advance.
 *
 * The fix, lifted from `../fantasy-football/vite.config.ts`: Vite's
 * `getConfigHash` hashes `plugins.map(p => p.name)` (verified in
 * `vite/dist/node/chunks/node.js`), and that hash feeds the optimizer's
 * `browserHash`. So stamping a no-op plugin's NAME with the built file's mtime
 * makes a harness rebuild change the config hash, which re-runs the optimizer
 * and moves the `?v=`. No URL rewriting, no extra query, no `optimizeDeps
 * .exclude` — which would be worse here, because the harness's own `ajv` is CJS
 * and needs pre-bundling to load in a browser at all.
 *
 * ⚠ pnpm installs a `file:` directory dep as a HARDLINKED COPY, not a symlink,
 * and the harness's tsup config runs `clean: true` — so a rebuild replaces
 * `dist/` with new inodes and the copy under `node_modules` keeps pointing at
 * the old ones. And the stamp below is read ONCE, when this config is loaded, so
 * a dev server already running never sees a new one: `pnpm install --force`
 * changes neither this file's mtime nor the lockfile's contents, which are the
 * two things Vite watches to re-read a config.
 *
 * The whole loop, and it is in `docs/HANDOFF.md` as well because a comment in a
 * config file is not where anyone looks for it:
 *
 *     pnpm build   # in ../agent-harness
 *     pnpm install --force
 *     # restart pnpm dev
 *
 * Same loop fantasy-football uses.
 */
function harnessBuildStamp(): string {
  try {
    const built = path.resolve(__dirname, 'node_modules/agent-harness/dist/browser.js');
    return String(Math.floor(statSync(built).mtimeMs));
  } catch {
    // Not installed yet. A constant is right: the app builds without it (nothing
    // imports the harness at module scope in a way that runs), and once it IS
    // installed the stamp changes and the cache turns over on its own.
    return 'unbuilt';
  }
}

export default defineConfig({
  plugins: [{ name: `harness-build-stamp:${harnessBuildStamp()}` }, react(), tailwindcss()],
  resolve: {
    // `alias` is the array form on purpose: string keys are PREFIX matches, so a plain
    // `react` entry would also swallow `react-dom`. Exact-and-subpath regexes keep them
    // apart.
    //
    // Why this is here at all: `@fretwork/lib` is consumed as a local link during the
    // migration (see the override in package.json). It declares react/react-dom as peers,
    // so the published tarball resolves to our single copy — but a symlink resolves the
    // lib's own imports relative to the LIB's folder, and the lib keeps React 18.3.1 as a
    // devDependency for its own tests. We are on 19.2.8. Two Reacts in one renderer is
    // "Invalid hook call" on every component with a hook, which is 170 of our tests.
    //
    // `dedupe: ['react', 'react-dom']` is the usual answer and does NOT work here — the
    // lib is inlined via `test.server.deps.inline`, and its imports get resolved from the
    // lib's directory before dedupe can collapse them. Forcing the path does work.
    //
    // Harmless once the link goes: these paths are where React already resolves from.
    //
    // `tone` and `zustand` are here for the same reason and are now genuine PEERS of the
    // lib — the consumer supplies them, so forcing our copy is what production does
    // anyway. Under the link they'd otherwise resolve to the lib's own devDependency
    // copies. Two Tones is the expensive one: it owns a global AudioContext and
    // transport, so a second instance means notes scheduled on a transport nobody is
    // listening to — indistinguishable from the LIB-GAP(3a/3b/3c) symptoms.
    //
    // NB `tone` vs `tonal`: a string alias would prefix-match both. Another reason these
    // are exact-and-subpath regexes.
    alias: [
      { find: '@', replacement: path.resolve(__dirname, './src') },
      { find: /^react$/, replacement: path.resolve(__dirname, 'node_modules/react') },
      { find: /^react-dom$/, replacement: path.resolve(__dirname, 'node_modules/react-dom') },
      { find: /^react\//, replacement: path.resolve(__dirname, 'node_modules/react') + '/' },
      {
        find: /^react-dom\//,
        replacement: path.resolve(__dirname, 'node_modules/react-dom') + '/',
      },
      { find: /^tone$/, replacement: path.resolve(__dirname, 'node_modules/tone') },
      { find: /^tone\//, replacement: path.resolve(__dirname, 'node_modules/tone') + '/' },
      { find: /^zustand$/, replacement: path.resolve(__dirname, 'node_modules/zustand') },
      { find: /^zustand\//, replacement: path.resolve(__dirname, 'node_modules/zustand') + '/' },
    ],
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    // @fretwork/lib's git-dep dist barrel uses directory imports
    // (`export * from './foo'`) that Node's ESM loader rejects — inline it so Vite resolves it.
    //
    // `zustand` has to be inlined too, and only because of the local link. It is a
    // dependency *of the lib*, so under a symlink Node resolves it inside
    // ../fretwork-lib/node_modules — where `react` resolves to the lib's own React 18
    // devDependency. Left external it is never touched by Vite, so neither the `react`
    // aliases above nor `dedupe` can reach it, and every component that reads a lib store
    // calls hooks from React 18 inside a React 19 tree. That is 170 failing tests and the
    // error only ever says "Invalid hook call".
    server: { deps: { inline: [/@fretwork\/lib/, 'zustand'] } },
  },
});
