import '@testing-library/jest-dom';

// jsdom has no ResizeObserver, and components that size themselves to their
// container (the timeline's lanes) construct one on mount. jsdom also reports
// every element as 0x0, so a real implementation would tell us nothing —
// this stub just lets those components mount.
// jsdom implements no scrolling at all — `scrollTo` simply isn't there, and the
// timeline calls it to follow the playhead. Stubbed rather than guarded in the
// component, since the guard would exist purely for the test environment.
// Note this also means follow-scroll behaviour can't be asserted here: jsdom has
// no layout, so clientWidth and scrollLeft are always 0.
if (!Element.prototype.scrollTo) {
  Element.prototype.scrollTo = () => {};
}

if (!('ResizeObserver' in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
