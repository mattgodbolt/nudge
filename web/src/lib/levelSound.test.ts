import { afterEach, describe, expect, it, vi } from 'vitest';
import { audioPrimed, playLevelUp, primeAudio, resetAudioForTests } from './levelSound';

/** A stand-in AudioContext that records what the chime asks of it. */
function fakeAudio(state: 'running' | 'suspended' = 'running') {
  const log = { made: 0, oscillators: 0, resumed: 0 };
  const param = () => ({ value: 0, setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() });
  class Fake {
    state = state;
    currentTime = 0;
    destination = {};
    constructor() {
      log.made++;
    }
    resume() {
      log.resumed++;
      this.state = 'running';
      return Promise.resolve();
    }
    createGain() {
      return { gain: param(), connect: vi.fn() };
    }
    createOscillator() {
      log.oscillators++;
      return { type: 'sine', frequency: param(), connect: vi.fn(), start: vi.fn(), stop: vi.fn() };
    }
  }
  vi.stubGlobal('AudioContext', Fake);
  return log;
}

afterEach(() => {
  resetAudioForTests();
  vi.unstubAllGlobals();
});

describe('the level-up chime', () => {
  it('does nothing until a gesture has made the audio context', () => {
    const log = fakeAudio();
    playLevelUp();
    expect(log).toMatchObject({ made: 0, oscillators: 0 });
    primeAudio();
    expect(audioPrimed()).toBe(true);
    playLevelUp();
    expect(log.made).toBe(1);
    expect(log.oscillators).toBeGreaterThan(0);
  });

  it('resumes a suspended context on the gesture, and makes only one', () => {
    const log = fakeAudio('suspended');
    primeAudio();
    primeAudio();
    expect(log.made).toBe(1);
    expect(log.resumed).toBeGreaterThan(0);
  });

  it('stays silent when audio is missing or refused', () => {
    vi.stubGlobal('AudioContext', undefined);
    expect(() => primeAudio()).not.toThrow();
    expect(() => playLevelUp()).not.toThrow();
    vi.stubGlobal(
      'AudioContext',
      class {
        constructor() {
          throw new Error('NotAllowedError');
        }
      },
    );
    expect(() => primeAudio()).not.toThrow();
    expect(audioPrimed()).toBe(false);
  });

  it('stays silent in a hidden tab', () => {
    const log = fakeAudio();
    primeAudio();
    const spy = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    playLevelUp();
    expect(log.oscillators).toBe(0);
    spy.mockRestore();
  });
});
