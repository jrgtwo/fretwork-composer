/**
 * Pin the AudioContext's sample rate. **Import this FIRST, from the app entry,
 * before any module that can touch Tone** — the import order is the whole
 * mechanism, not a style preference. `forceSampleRate` works by replacing Tone's
 * context with one of its own, which it can only do while nothing has been built
 * on the old one.
 *
 * Left alone, Tone takes the output device's native rate. On a 192kHz device —
 * ordinary on Windows with a decent interface, and what this was found on — that
 * is FOUR TIMES the samples per second through every node in the graph: three
 * sampled tracks, the convolution reverb (whose impulse is generated at the
 * context rate), the bus compressor and the limiter. The render thread stops
 * keeping up, buffers underrun, and output falls progressively further behind the
 * transport. That reads as a playhead running away from the audio by a beat or
 * more — and it is a DRIFT, not an offset, so no amount of latency compensation
 * can correct it. See `getEffectiveLatencySec` and `audibleTransportTicks` for the
 * two fixed offsets, which are real but small next to this.
 *
 * 48kHz because it is what the owner-recorded sample packs were cut at, so they
 * decode without resampling; the browser resamples once at output for everyone
 * else. The call also switches the context to `latencyHint: 'playback'`, which
 * asks for the largest, most glitch-resistant output buffer. That REPORTS a
 * higher `outputLatency` than the default 'interactive' hint — an improvement,
 * not a regression: it is honest about a buffer that already existed, and every
 * visual-sync read takes `AudioContext.outputLatency` live.
 */
import { forceSampleRate } from '@fretwork/lib';

/** The rate the sample packs were recorded at. */
export const AUDIO_SAMPLE_RATE = 48_000;

forceSampleRate(AUDIO_SAMPLE_RATE);
