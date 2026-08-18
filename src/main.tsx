// FIRST, and load-bearing — see the module. Pins the AudioContext's sample rate
// before anything can build on Tone's default one.
import './audio/sampleRate';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
