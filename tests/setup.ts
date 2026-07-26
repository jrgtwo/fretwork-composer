import '@testing-library/jest-dom';

// jsdom has no ResizeObserver, and components that size themselves to their
// container (the timeline's lanes) construct one on mount. jsdom also reports
// every element as 0x0, so a real implementation would tell us nothing —
// this stub just lets those components mount.
if (!('ResizeObserver' in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
