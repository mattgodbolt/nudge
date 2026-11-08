import type { AssistantAction, LlmClient } from '../contracts.js';

const addDays = (now: string, days: number): string => {
  const offset = /(Z|[+-]\d{2}:\d{2})$/.exec(now)?.[1] ?? 'Z';
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() + days);
  return new Date(`${d.toISOString().slice(0, 10)}T09:00:00${offset}`).toISOString();
};

/**
 * Demo/e2e assistant: no network. Understands "snooze this ...", "done"/"mark this done", and "remind me [in N days]
 * to X" / anything else as a todo ("tomorrow" or "in N days" sets a due time).
 */
export function createFakeLlmClient(): LlmClient {
  return {
    async test(apiKey) {
      return apiKey === 'bad'
        ? { ok: false, message: 'Anthropic said 401: invalid x-api-key' }
        : { ok: true, message: 'Key works (demo)' };
    },
    async command({ text, now, selected }) {
      const actions: AssistantAction[] = [];
      const days = /\bin (\d+) days?\b/i.exec(text);
      const when = days ? Number(days[1]) : /\btomorrow\b/i.test(text) ? 1 : null;
      if (/^\s*(mark (this|it) )?done\b/i.test(text)) {
        return selected ? { actions: [{ type: 'done' }], reply: '' } : { actions, reply: 'Nothing is selected.' };
      }
      if (/^\s*snooze\b/i.test(text)) {
        return selected && when
          ? { actions: [{ type: 'snooze', until: addDays(now, when) }], reply: '' }
          : { actions, reply: 'Nothing is selected.' };
      }
      const clean = text
        .replace(/^\s*(um+,?\s*)?(remind me|i need|don't forget)( in \d+ days?)?( to)?\s+/i, '')
        .replace(/\s+(tomorrow|in \d+ days?)\b/i, '')
        .trim();
      const title = clean.charAt(0).toUpperCase() + clean.slice(1);
      actions.push({
        type: 'add_todo',
        title,
        notes: /\bnotes?:\s*(.+)$/i.exec(text)?.[1] ?? '',
        due: when ? addDays(now, when) : null,
      });
      return { actions, reply: '' };
    },
  };
}
