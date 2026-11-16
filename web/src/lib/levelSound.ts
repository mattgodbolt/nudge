// The level-up chime: a short, bright, bell-like rising arpeggio, synthesised with the Web Audio API (no recorded
// audio, nothing copied from any game). It is the only sound in Nudge. Browsers only allow audio after a user gesture,
// so the context is made (or resumed) on the first key or click while the chime is wanted, and if that is blocked or
// unsupported the chime silently does nothing.

type Ctor = typeof AudioContext;
let ctx: AudioContext | null = null;

function ctorOf(): Ctor | null {
  const w = globalThis as unknown as { AudioContext?: Ctor; webkitAudioContext?: Ctor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

/** Call from a key or pointer handler: makes (or wakes) the audio context. Safe to call repeatedly. */
export function primeAudio(): void {
  try {
    if (!ctx) {
      const C = ctorOf();
      if (!C) return;
      ctx = new C();
    }
    if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
  } catch {
    ctx = null; // blocked or unsupported: stay silent
  }
}

export const audioPrimed = () => ctx !== null;

/** Notes of the chime (Hz) and when each starts (s): E6, G#6, B6, then a high E7 that rings on. */
const NOTES: { f: number; at: number; len: number }[] = [
  { f: 1318.5, at: 0, len: 0.45 },
  { f: 1661.2, at: 0.08, len: 0.45 },
  { f: 1975.5, at: 0.16, len: 0.5 },
  { f: 2637.0, at: 0.26, len: 0.85 },
];
/** Bell partials: the fundamental, a slightly inharmonic overtone for shimmer, and a soft octave below for body. */
const PARTIALS: { ratio: number; gain: number; type: OscillatorType }[] = [
  { ratio: 1, gain: 1, type: 'sine' },
  { ratio: 2.76, gain: 0.18, type: 'sine' },
  { ratio: 0.5, gain: 0.25, type: 'triangle' },
];

/** Play the chime, only if the tab is visible and audio is allowed. Never throws. */
export function playLevelUp(): void {
  try {
    if (!ctx || ctx.state !== 'running') return;
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    const t0 = ctx.currentTime + 0.02;
    const master = ctx.createGain();
    master.gain.value = 0.16;
    master.connect(ctx.destination);
    for (const n of NOTES) {
      for (const p of PARTIALS) {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = p.type;
        osc.frequency.value = n.f * p.ratio;
        const start = t0 + n.at;
        // A fast strike and an exponential ring-out: what makes it a bell and not a beep.
        g.gain.setValueAtTime(0.0001, start);
        g.gain.exponentialRampToValueAtTime(p.gain * 0.5, start + 0.006);
        g.gain.exponentialRampToValueAtTime(0.0001, start + n.len);
        osc.connect(g);
        g.connect(master);
        osc.start(start);
        osc.stop(start + n.len + 0.05);
      }
    }
  } catch {
    /* audio unavailable: stay silent */
  }
}

/** Tests only. */
export function resetAudioForTests(): void {
  ctx = null;
}
