/**
 * WHICH POINT IN THE GRAPH THE IN/OUT BAR WATCHES.
 *
 * This is the one thing about the bar that nothing else can see. `LevelMeter`'s
 * own test proves it forwards whatever `source` it is handed; `levelMeters`' test
 * proves each kind reads the right tap. Between them sits the choice
 * `VoiceEditor.renderLevelBar` makes — track or pattern, IN or OUT — and every
 * way of getting it wrong leaves a meter showing a plausible moving number rather
 * than a blank one. Swapping IN for OUT, pointing both ends at one tap, pointing a
 * rack at the pattern engine's voice or hard-coding one track's id all used to
 * keep the whole suite green.
 *
 * So `levelMeters` is mocked here and nowhere else in this file's reach: what is
 * captured is the `source` argument of every `subscribeMeter` call, which is the
 * assertion. jsdom draws nothing and has no Web Audio, so the reading itself is
 * not in question — only where it is asked for.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { useFretworkStore, useVoiceStore, type Track } from '@fretwork/lib';

/** Every `source` handed to `subscribeMeter`, in mount order. */
const watched = vi.hoisted(() => [] as unknown[]);

vi.mock('../src/audio/levelMeters', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/audio/levelMeters')>()),
  subscribeMeter: (source: unknown) => {
    watched.push(source);
    return () => {};
  },
}));

import { VoicePane } from '../src/voice/VoicePane';
import { TrackVoiceRack } from '../src/composition/TrackVoiceRack';
import {
  addTrack,
  getEditingComposition,
  getTracks,
  openBlankComposition,
} from '../src/composition/compositionService';
import { openBlankPattern } from '../src/patterns/patternService';
import { clearVoiceDrafts } from '../src/voice/voiceDrafts';
import { clearPendingWarms } from '../src/voice/sampleWarm';

beforeEach(() => {
  watched.length = 0;
  clearVoiceDrafts();
  clearPendingWarms();
  useFretworkStore.getState().setInstrumentId('guitar');
  useVoiceStore.getState().reset();
});

function twoTracks(): readonly Track[] {
  if (!getEditingComposition()) openBlankComposition('Song');
  addTrack('Rhythm');
  return getTracks();
}

describe('the IN/OUT bar’s meter sources', () => {
  it('watches the pattern engine’s voice on the pattern page, IN then OUT', () => {
    openBlankPattern('Level bar test');

    render(<VoicePane collapsedSections={undefined} onCollapsedSectionsChange={() => {}} />);

    // No `trackId` anywhere: the pattern engine is a singleton holding one voice,
    // and a track id here would be a rack metering the wrong page.
    expect(watched).toEqual([{ kind: 'pattern-in' }, { kind: 'pattern-out' }]);
  });

  it('watches each rack’s OWN track, IN then OUT', () => {
    const tracks = twoTracks();
    expect(tracks.length).toBeGreaterThanOrEqual(2);

    for (const track of tracks) {
      render(
        <TrackVoiceRack
          track={track}
          audible
          collapsed={false}
          onCollapsedChange={() => {}}
          collapsedSections={undefined}
          onCollapsedSectionsChange={() => {}}
        />,
      );
    }

    // The SECOND rack carries the second track's id, which is what stops a
    // hard-coded or a first-track id passing. Nothing `pattern-*` appears: a rack
    // whose track has gone reads silence rather than the other page's voice.
    expect(watched).toEqual([
      { kind: 'track-in', trackId: tracks[0].id },
      { kind: 'track-out', trackId: tracks[0].id },
      { kind: 'track-in', trackId: tracks[1].id },
      { kind: 'track-out', trackId: tracks[1].id },
    ]);
  });

  it('names the track’s OUT for the fader it is reading past', () => {
    // The two meters are not symmetrical on a track — `track-out` has the fader,
    // mute and solo added — and the name is the only place a listener can learn
    // that. See `renderLevelBar`.
    const [track] = twoTracks();

    render(
      <TrackVoiceRack
        track={track}
        audible
        collapsed={false}
        onCollapsedChange={() => {}}
        collapsedSections={undefined}
        onCollapsedSectionsChange={() => {}}
      />,
    );

    const bar = within(screen.getByRole('group', { name: `${track.name} levels` }));
    expect(
      bar.getByRole('button', { name: `${track.name} voice input level — clip indicator. Click to clear.` }),
    ).toBeInTheDocument();
    expect(
      bar.getByRole('button', {
        name: `${track.name} voice output level, after the fader — clip indicator. Click to clear.`,
      }),
    ).toBeInTheDocument();
  });
});
