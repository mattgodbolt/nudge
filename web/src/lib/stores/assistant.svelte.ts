import { api } from '../api';
import { describeOutcome, localNow, speechCtor, type Recognition } from '../assistant';
import type { AssistantOutcome } from '../../../../shared/types';
import { inbox } from './inbox.svelte';
import { toasts } from './toasts.svelte';
import { ui } from './ui.svelte';
import { usage } from '../usage';

/** The "tell Nudge" box: dictate or type a command; the server's assistant does the right thing. */
class AssistantStore {
  open = $state(false);
  text = $state('');
  busy = $state(false);
  listening = $state(false);
  micError = $state<string | null>(null);
  focusTick = $state(0);
  readonly micSupported = speechCtor() !== null;
  #rec: Recognition | null = null;

  show() {
    ui.helpOpen = false;
    ui.paletteOpen = false;
    this.open = true;
    this.focusTick++;
  }
  close() {
    this.stopMic();
    this.open = false;
  }

  toggleMic() {
    if (this.listening) return this.stopMic();
    const Ctor = speechCtor();
    if (!Ctor) return;
    this.micError = null;
    const rec = new Ctor();
    rec.continuous = false;
    rec.interimResults = true;
    rec.lang = navigator.language || 'en-US';
    const base = this.text.trim() ? `${this.text.trim()} ` : '';
    rec.onresult = (e) => {
      let said = '';
      for (let i = 0; i < e.results.length; i++) said += e.results[i]![0]!.transcript;
      this.text = base + said.trim();
    };
    rec.onerror = (e) => {
      this.micError = e.error === 'not-allowed' ? 'Microphone permission was denied' : `Dictation failed (${e.error})`;
    };
    rec.onend = () => {
      this.listening = false;
      this.#rec = null;
    };
    this.#rec = rec;
    this.listening = true;
    usage.count('assistant.voice');
    try {
      rec.start();
    } catch {
      this.listening = false;
    }
  }
  stopMic() {
    try {
      this.#rec?.stop();
    } catch {
      /* already stopped */
    }
    this.listening = false;
  }

  async submit() {
    const text = this.text.trim();
    if (!text || this.busy) return;
    this.stopMic();
    this.busy = true;
    try {
      const res = await api.assistant({ text, now: localNow(), selectedId: inbox.selectedId });
      this.text = '';
      this.open = false;
      for (const o of res.outcomes) {
        toasts.push({
          message: describeOutcome(o),
          kind: 'success',
          timeoutMs: 8000,
          action: { label: 'Undo', run: () => void this.undo(o) },
        });
      }
      if (res.fallback === 'off') {
        toasts.push({
          message: 'Saved as a todo. Add an Anthropic key in Settings to have it understood.',
          timeoutMs: 6000,
        });
      } else if (res.fallback === 'failed') {
        toasts.error(`Saved as you said it; the assistant failed${res.error ? `: ${res.error}` : ''}`);
      } else if (res.reply) {
        toasts.push({ message: res.reply, timeoutMs: 8000 });
      }
    } catch (e) {
      // Keep the text so nothing said is lost.
      toasts.error(e instanceof Error ? e.message : 'Could not reach Nudge');
    } finally {
      this.busy = false;
    }
  }

  async undo(o: AssistantOutcome) {
    try {
      if (o.type === 'add_todo') await api.deleteTodo(o.id);
      else if (o.undoActionId !== null) {
        if (o.type === 'snooze') await api.undoSnooze(o.undoActionId);
        else await api.undo(o.undoActionId);
      }
      void inbox.load();
    } catch (e) {
      toasts.error(e instanceof Error ? e.message : 'Could not undo');
    }
  }
}

export const assistant = new AssistantStore();
