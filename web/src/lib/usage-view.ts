import { USAGE_ACTIONS, featureOf, viaOf, type UsageDTO, type UsageVia } from '../../../shared/usage';

/** Keys that describe the session or device rather than something the owner chose to do. */
const BOOKKEEPING = /^(session|app|device)\./;
/** The server's own assistant counters: shown in the assistant block, not ranked as features. */
const ASSISTANT_SERVER = /^assistant\.(call|tool_call|fail|cost_micros)$/;

export interface UsageSummary {
  /** Feature uses (actions, views, searches...), excluding session and device bookkeeping. */
  total: number;
  top: { feature: string; count: number }[];
  /** How actions were invoked, over the action keys only. */
  via: Record<UsageVia, number>;
  /** One entry per day in the window, oldest first, with zero-filled gaps. */
  perDay: { day: string; count: number }[];
  assistant: { calls: number; toolCalls: number; failures: number; costMicros: number; voice: number };
  sessions: { started: number; activeMinutes: number; phone: number; desktop: number; pwa: number; browserTab: number };
  /** The event log, per kind with a count for each source. */
  events: { kind: string; user: number; auto: number; sync: number; total: number }[];
  unused: string[];
}

function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const end = new Date(`${to}T00:00:00Z`);
  for (let d = new Date(`${from}T00:00:00Z`); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

export function summarise(dto: UsageDTO, limit = 10): UsageSummary {
  const byFeature = new Map<string, number>();
  const via: Record<UsageVia, number> = { kbd: 0, btn: 0, touch: 0, palette: 0 };
  const perDay = new Map(daysBetween(dto.from, dto.to).map((d) => [d, 0]));
  const sum = (k: string): number => dto.rows.filter((r) => r.key === k).reduce((a, r) => a + r.count, 0);
  let total = 0;
  for (const r of dto.rows) {
    if (BOOKKEEPING.test(r.key) || ASSISTANT_SERVER.test(r.key)) continue;
    total += r.count;
    const f = featureOf(r.key);
    byFeature.set(f, (byFeature.get(f) ?? 0) + r.count);
    perDay.set(r.day, (perDay.get(r.day) ?? 0) + r.count);
    const v = viaOf(r.key);
    if (v && f in USAGE_ACTIONS) via[v] += r.count;
  }
  const kinds = new Map<string, { kind: string; user: number; auto: number; sync: number; total: number }>();
  for (const e of dto.events) {
    const row = kinds.get(e.kind) ?? { kind: e.kind, user: 0, auto: 0, sync: 0, total: 0 };
    if (e.source === 'user' || e.source === 'auto' || e.source === 'sync') row[e.source] += e.count;
    row.total += e.count;
    kinds.set(e.kind, row);
  }
  return {
    total,
    top: [...byFeature]
      .map(([feature, count]) => ({ feature, count }))
      .sort((a, b) => b.count - a.count || a.feature.localeCompare(b.feature))
      .slice(0, limit),
    via,
    perDay: [...perDay].map(([day, count]) => ({ day, count })),
    assistant: {
      calls: sum('assistant.call'),
      toolCalls: sum('assistant.tool_call'),
      failures: sum('assistant.fail'),
      costMicros: sum('assistant.cost_micros'),
      voice: sum('assistant.voice'),
    },
    sessions: {
      started: sum('session.start'),
      activeMinutes: sum('session.active_minute'),
      phone: sum('device.phone'),
      desktop: sum('device.desktop'),
      pwa: sum('app.pwa'),
      browserTab: sum('app.browser_tab'),
    },
    events: [...kinds.values()].sort((a, b) => b.total - a.total),
    unused: dto.unused,
  };
}

/** `done` -> "Done", `view.github_thread` -> "View: github thread", `open_source` -> "Open source". */
export function featureLabel(feature: string): string {
  const [head, ...rest] = feature.split('.');
  const words = (s: string) => s.replace(/_/g, ' ');
  const base = words(head!);
  const text = rest.length ? `${base}: ${rest.map(words).join(' ')}` : base;
  return text[0]!.toUpperCase() + text.slice(1);
}

export const VIA_LABEL: Record<UsageVia, string> = {
  kbd: 'Keyboard',
  btn: 'Buttons',
  touch: 'Touch',
  palette: 'Palette',
};

/** Micro-dollars as dollars, with enough places that a few cents of assistant use is not shown as $0.00. */
export function formatMicros(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(micros >= 10_000_000 ? 2 : 3)}`;
}
