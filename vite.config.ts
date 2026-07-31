// `vitest/config`'s defineConfig is a superset of Vite's that types the `test` key natively.
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
    alias: [
      { find: '@', replacement: path.resolve(__dirname, './src') },
      { find: /^react$/, replacement: path.resolve(__dirname, 'node_modules/react') },
      { find: /^react-dom$/, replacement: path.resolve(__dirname, 'node_modules/react-dom') },
      { find: /^react\//, replacement: path.resolve(__dirname, 'node_modules/react') + '/' },
      {
        find: /^react-dom\//,
        replacement: path.resolve(__dirname, 'node_modules/react-dom') + '/',
      },
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
