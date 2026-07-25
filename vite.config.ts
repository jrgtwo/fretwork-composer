// `vitest/config`'s defineConfig is a superset of Vite's that types the `test` key natively.
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    // @fretwork/lib's git-dep dist barrel uses directory imports
    // (`export * from './foo'`) that Node's ESM loader rejects — inline it so Vite resolves it.
    server: { deps: { inline: [/@fretwork\/lib/] } },
  },
});
