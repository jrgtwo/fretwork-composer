// FIRST, and load-bearing — see the module. Pins the AudioContext's sample rate
// before anything can build on Tone's default one.
import './audio/sampleRate';
import { unregisterSampleCache } from './audio/sampleCache';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/index.css';

// Sample caching lives in the lib now (`playback/voices/sample-store.ts`), which
// reads Cache Storage before the network. This only clears the service worker
// that used to front those loads: deleting `public/sw.js` does not unregister
// it, and a surviving worker keeps intercepting and masks the store's misses
// behind `(ServiceWorker)`. It takes effect from the NEXT load — an active
// worker keeps controlling this page until it unloads — so the first boot after
// the change still shows the worker in the path. Async, non-blocking, and it
// never throws — see the module.
unregisterSampleCache();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
