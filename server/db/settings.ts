import { EMPTY_OWNER } from '../../shared/owner.js';
import { DEFAULT_SNOOZE_DAYS } from '../../shared/snooze.js';
import type { PushPrefs } from '../../shared/types.js';
import type { PushSubscriptionRow, Repo, StoredSettings } from '../contracts.js';
import type { Row } from './common.js';
import type { Db } from './db.js';

const DEFAULT_SETTINGS: StoredSettings = {
  apiKey: null,
  googleClient: null,
  ownChannelIds: [],
  pollEnabled: true,
  dailyQuotaBudget: 9000,
  manualReserve: 1000,
  backfillDays: 14,
  theme: 'system',
  snoozeDays: { ...DEFAULT_SNOOZE_DAYS },
  github: { token: null, myAccounts: [] },
  llm: { apiKey: null, model: 'claude-haiku-5-5' },
  owner: { ...EMPTY_OWNER },
  // Adventure mode is on unless switched off: the owner asked for it (docs/RPG.md).
  rpg: { enabled: true, sound: true, title: null, seen: null, tz: null, prevTz: null },
};

export interface SettingsStore extends Pick<
  Repo,
  | 'getSettings'
  | 'updateSettings'
  | 'listPushSubscriptions'
  | 'getPushSubscription'
  | 'upsertPushSubscription'
  | 'deletePushSubscription'
  | 'markPushResult'
  | 'getVapidKeys'
  | 'setVapidKeys'
> {
  /** Store one already-JSON-encoded setting, bypassing updateSettings' side effects. */
  putSetting(key: string, json: string): void;
}

export interface SettingsDeps {
  db: Db;
  now: () => string;
  /** Called (inside updateSettings' transaction) when the own channel ids change; it stores them itself. */
  recomputeOwnership: (ids: string[]) => void;
  /** Called (inside updateSettings' transaction) when the GitHub accounts that count as the owner change. */
  recomputeGithubOwnership: () => void;
}

/** Settings, web push subscriptions and the VAPID keys (kept in the settings table). */
export function createSettings(deps: SettingsDeps): SettingsStore {
  const { db, now } = deps;

  function getSettings(): StoredSettings {
    const out: Row = { ...DEFAULT_SETTINGS };
    for (const r of db.prepare('SELECT key, value FROM settings').all() as Row[]) {
      if (r.key in DEFAULT_SETTINGS) {
        try {
          out[r.key] = JSON.parse(r.value);
        } catch {
          /* keep default */
        }
      }
    }
    // Stored days may predate a bucket; fill from the defaults so every bucket always has a number.
    out.snoozeDays = { ...DEFAULT_SNOOZE_DAYS, ...(out.snoozeDays as object) };
    out.rpg = { ...DEFAULT_SETTINGS.rpg, ...(out.rpg && typeof out.rpg === 'object' ? (out.rpg as object) : {}) };
    // Seeded by hand into a database (see README), so a half-written row reads as the missing parts, never a crash.
    const o = (out.owner && typeof out.owner === 'object' ? out.owner : {}) as Row;
    out.owner = {
      name: typeof o.name === 'string' ? o.name.trim() : '',
      about: typeof o.about === 'string' ? o.about.trim() : '',
    };
    return out as StoredSettings;
  }
  const putSetting = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );

  function updateSettings(p: Partial<StoredSettings>): StoredSettings {
    const before = getSettings();
    db.transaction(() => {
      for (const [k, v] of Object.entries(p)) {
        if (v === undefined || !(k in DEFAULT_SETTINGS) || k === 'ownChannelIds') continue;
        putSetting.run(k, JSON.stringify(v));
      }
      if (p.ownChannelIds && JSON.stringify(p.ownChannelIds) !== JSON.stringify(before.ownChannelIds)) {
        deps.recomputeOwnership(p.ownChannelIds);
      }
      if (p.github && JSON.stringify(p.github.myAccounts) !== JSON.stringify(before.github.myAccounts)) {
        deps.recomputeGithubOwnership();
      }
    })();
    return getSettings();
  }

  /* ---------------- web push ---------------- */
  const pushRow = (r: Row): PushSubscriptionRow => ({
    endpoint: r.endpoint,
    p256dh: r.p256dh,
    auth: r.auth,
    newComments: !!r.new_comments,
    snoozeWake: !!r.snooze_wake,
    label: r.label,
    createdAt: r.created_at,
    lastSuccessAt: r.last_success_at,
    failureCount: r.failure_count,
  });
  const listPushSubscriptions = (): PushSubscriptionRow[] =>
    (db.prepare('SELECT * FROM push_subscriptions ORDER BY created_at, endpoint').all() as Row[]).map(pushRow);
  function getPushSubscription(endpoint: string): PushSubscriptionRow | null {
    const r = db.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?').get(endpoint) as Row | undefined;
    return r ? pushRow(r) : null;
  }
  function upsertPushSubscription(s: {
    endpoint: string;
    p256dh: string;
    auth: string;
    label: string | null;
    prefs: PushPrefs;
  }): void {
    db.prepare(
      `INSERT INTO push_subscriptions (endpoint, p256dh, auth, new_comments, snooze_wake, label, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth,
         new_comments = excluded.new_comments, snooze_wake = excluded.snooze_wake, label = excluded.label,
         failure_count = 0`,
    ).run(s.endpoint, s.p256dh, s.auth, s.prefs.newComments ? 1 : 0, s.prefs.snoozeWake ? 1 : 0, s.label, now());
  }
  const deletePushSubscription = (endpoint: string): boolean =>
    db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint).changes > 0;
  function markPushResult(endpoint: string, ok: boolean): void {
    if (ok) {
      db.prepare('UPDATE push_subscriptions SET last_success_at = ?, failure_count = 0 WHERE endpoint = ?').run(
        now(),
        endpoint,
      );
    } else {
      db.prepare('UPDATE push_subscriptions SET failure_count = failure_count + 1 WHERE endpoint = ?').run(endpoint);
    }
  }
  function getVapidKeys(): { publicKey: string; privateKey: string } | null {
    const r = db.prepare("SELECT value FROM settings WHERE key = 'vapidKeys'").get() as Row | undefined;
    if (!r) return null;
    try {
      const v = JSON.parse(r.value);
      return typeof v?.publicKey === 'string' && typeof v?.privateKey === 'string' ? v : null;
    } catch {
      return null;
    }
  }
  const setVapidKeys = (k: { publicKey: string; privateKey: string }): void =>
    void putSetting.run('vapidKeys', JSON.stringify(k));

  return {
    getSettings,
    updateSettings,
    putSetting: (key, json) => void putSetting.run(key, json),
    listPushSubscriptions,
    getPushSubscription,
    upsertPushSubscription,
    deletePushSubscription,
    markPushResult,
    getVapidKeys,
    setVapidKeys,
  };
}
