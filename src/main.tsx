// FIRST, and load-bearing — see the module. Pins the AudioContext's sample rate
// before anything can build on Tone's default one.
import './audio/sampleRate';
import { registerSampleCache } from './audio/sampleCache';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/index.css';

// Before the first render, so a voice built during mount already goes through
// the cache. Registration is async and non-blocking — the first load races it
// and simply misses, which costs one uncached fetch of each file, once ever.
registerSampleCache();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
