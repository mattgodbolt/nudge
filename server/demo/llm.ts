import type { AssistantAction, LlmClient, SnoozeAi } from '../contracts.js';

const addDays = (now: string, days: number): string => {
  const offset = /(Z|[+-]\d{2}:\d{2})$/.exec(now)?.[1] ?? 'Z';
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() + days);
  return new Date(`${d.toISOString().slice(0, 10)}T09:00:00${offset}`).toISOString();
};

/**
 * Demo/e2e assistant: no network. Understands "snooze this ... [to <why>]", "done"/"mark this done", notes (anything
 * with "always", "never", "wouldn't" or "suggestion" in it: "always"/"never" make it a standing preference, "wouldn't"
 * is about what he just did), and "remind me [in N days] to X" / anything else as a todo ("tomorrow" or "in N days"
 * sets a due time).
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
      if (/^\s*(mark (this|it) as )?(no action( needed)?|dismiss(ed)?)\b/i.test(text)) {
        return selected ? { actions: [{ type: 'dismiss' }], reply: '' } : { actions, reply: 'Nothing is selected.' };
      }
      if (/^\s*(mark (this|it) )?done\b/i.test(text)) {
        return selected ? { actions: [{ type: 'done' }], reply: '' } : { actions, reply: 'Nothing is selected.' };
      }
      if (/^\s*snooze\b/i.test(text)) {
        const why = /\bto (.+?)\s*$/i.exec(text.replace(/\b(tomorrow|in \d+ days?)\b/gi, ''))?.[1] ?? null;
        // "snooze until they reply": waiting on activity; the follow-up date comes from Settings.
        const waiting = /\buntil (they|he|she|it'?s?|there)\b|\bwait(ing)? for\b/i.test(text);
        const bucket = /\bmerge|\bCI\b/i.test(text) ? 'waiting_on_merge' : waiting ? 'waiting_on_them' : null;
        return selected && (when || waiting)
          ? {
              actions: [
                {
                  type: 'snooze',
                  until: when ? addDays(now, when) : null,
                  why,
                  bucket,
                  untilActivity: waiting,
                },
              ],
              reply: '',
            }
          : { actions, reply: 'Nothing is selected.' };
      }
      if (/\b(always|never|wouldn't|suggestion)\b/i.test(text)) {
        return {
          actions: [
            {
              type: 'note',
              text: text.trim(),
              scope: /\b(always|never)\b/i.test(text) ? 'standing' : 'item',
              about: /wouldn't/i.test(text) ? 'last_action' : 'selected',
            },
          ],
          reply: '',
        };
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

/**
 * Demo/e2e stand-ins for the small snooze calls: a reason mentioning "reply" or "waiting for them" is waiting_on_them,
 * "CI" or "waiting for the merge" waiting_on_merge, "someday" lower_priority, "fix", "review" or "working" in_flight;
 * and a nudge is a fixed polite line.
 */
export function createFakeSnoozeAi(): SnoozeAi {
  const tokens = { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
  return {
    async bucket({ why }) {
      const bucket = /\breply|\banswer|\bresponse|\bwaiting (on|for) (them|him|her|the)\b/i.test(why)
        ? 'waiting_on_them'
        : /\bCI\b|\bwait\w* (on|for) (the )?(merge|build|release)/i.test(why)
          ? 'waiting_on_merge'
          : /\bsomeday|\blater\b|\blow priority/i.test(why)
            ? 'lower_priority'
            : /\bfix|\bworking|\breview|\bwrite/i.test(why)
              ? 'in_flight'
              : null;
      return { bucket, tokens };
    },
    async nudge({ title, days }) {
      return {
        text: `Hi! Just checking in on "${title}": it has been about ${days} days. Are you still planning to pick this up, or is anything blocking you?`,
        tokens,
      };
    },
  };
}
