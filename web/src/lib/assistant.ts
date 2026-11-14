import type { AssistantOutcome } from '../../../shared/types';

/** The user's local time with its UTC offset (2026-11-08T13:05:00-06:00), so "Friday" resolves in their time zone. */
export function localNow(d: Date = new Date()): string {
  const p = (n: number, w = 2) => String(Math.abs(n)).padStart(w, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` +
    `${sign}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`
  );
}

/** "Fri 14 Nov, 09:00" */
export function whenLabel(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** One line for the toast. */
export function describeOutcome(o: AssistantOutcome): string {
  if (o.type === 'add_todo') return o.due ? `Todo: ${o.title} (${whenLabel(o.due)})` : `Todo: ${o.title}`;
  if (o.type === 'snooze') return `Snoozed until ${whenLabel(o.until)}${o.why ? `: ${o.why}` : ''}`;
  if (o.type === 'note')
    return o.scope === 'standing' ? `Noted as a standing preference: ${o.text}` : `Noted: ${o.text}`;
  if (o.type === 'dismissed') return 'Marked no action needed';
  return 'Marked done';
}

/* Browser speech recognition (Chrome/Android/Safari); absent elsewhere, where the keyboard's own dictation still works. */
interface Recognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  start(): void;
  stop(): void;
}
type RecognitionCtor = new () => Recognition;

export function speechCtor(): RecognitionCtor | null {
  const w = globalThis as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}
export type { Recognition };
