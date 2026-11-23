<script lang="ts">
  import { BUCKETS, SNOOZE_BUCKETS, SNOOZE_DAYS_MAX, SNOOZE_DAYS_MIN, type SnoozeBucket } from '../../../shared/snooze';
  import { BUILD_VERSION } from '../lib/version';
  import { api } from '../lib/api';
  import type { SettingsUpdate } from '../../../shared/api';
  import { settings } from '../lib/stores/settings.svelte';
  import { inbox } from '../lib/stores/inbox.svelte';
  import Icon from '../components/Icon.svelte';
  import { sources } from '../lib/stores/sources.svelte';
  import Avatar from '../components/Avatar.svelte';
  import { sync } from '../lib/stores/sync.svelte';
  import { theme, type ThemePref } from '../lib/stores/theme.svelte';
  import { toasts } from '../lib/stores/toasts.svelte';
  import { formatNumber, until } from '../lib/format';
  import { anyNeedsReauth, clientSourceLabel, connectedLabel, googleState, googleToast } from '../lib/google';
  import { router } from '../lib/router.svelte';
  import { push } from '../lib/stores/push.svelte';
  import { notes } from '../lib/stores/notes.svelte';
  import { chipText } from '../lib/suggestions';
  import SuggestProgress from '../components/SuggestProgress.svelte';
  import KeyField from '../components/KeyField.svelte';
  import { ui } from '../lib/stores/ui.svelte';
  import { onMount, tick, untrack } from 'svelte';
  import { OWNER_ABOUT_MAX, OWNER_NAME_MAX, ownerProfileComplete } from '../../../shared/owner';

  onMount(() => {
    void push.init();
    void notes.load();
  });

  /** One line saying what Nudge had suggested, and what you had just done, when a note was made. */
  function noteContext(n: (typeof notes.list)[number]): string {
    const bits: string[] = [];
    const sg = n.suggestion;
    if (sg) {
      bits.push(
        `Suggestion then: ${chipText({
          action: sg.action as 'reply' | 'act' | 'skip' | 'spam',
          reason: sg.reason,
          confidence: sg.confidence as 'low' | 'medium' | 'high',
          suspicious: false,
          turn: sg.turn as 'me' | 'them' | 'nobody' | null,
          nextStep: sg.nextStep,
        })}`,
      );
    }
    const a = n.lastAction;
    if (a) {
      const what = a.kind === 'snooze' ? (a.to ? 'snoozed it' : 'unsnoozed it') : `marked it ${a.to}`;
      bits.push(`You had just ${what}${a.why ? ` to: ${a.why}` : ''}`);
    }
    return bits.join(' · ');
  }

  const s = $derived(settings.value);

  // About you: the fields follow what is saved (here or in another tab) until edited, and are saved together.
  const savedName = $derived(s?.owner.name ?? '');
  const savedAbout = $derived(s?.owner.about ?? '');
  let ownerName = $state('');
  let ownerAbout = $state('');
  let ownerBusy = $state(false);
  $effect(() => {
    ownerName = savedName;
  });
  $effect(() => {
    ownerAbout = savedAbout;
  });
  const ownerDirty = $derived(ownerName.trim() !== savedName || ownerAbout.trim() !== savedAbout);
  /** Model features wait for the profile; only worth shouting about when there is a key to use. */
  const llmPaused = $derived(!!s && s.llm.configured && !ownerProfileComplete(s.owner));
  async function saveOwner(e: Event) {
    e.preventDefault();
    if (ownerBusy || !ownerDirty) return;
    ownerBusy = true;
    const ok = await settings.save({ owner: { name: ownerName.trim(), about: ownerAbout.trim() } });
    ownerBusy = false;
    if (ok) toasts.success('Saved', 2500);
  }
  /** Scroll to a section of this page, and put the cursor where the reader is sent to type. */
  function goTo(id: string, focusId?: string) {
    document.getElementById(id)?.scrollIntoView({ block: 'start' });
    if (focusId) document.getElementById(focusId)?.focus({ preventScroll: true });
  }
  function showAboutYou(e: Event) {
    e.preventDefault();
    goTo('about-you', 'owner-name');
  }
  function showMyChannels(e: Event) {
    e.preventDefault();
    goTo('my-channels', 'own-channel-input');
  }
  /** Links from elsewhere (a toast's Settings button, a hint in Sources) name a section in the hash: land on it once
   * the page has rendered. Reading router.state reruns this on each navigation, including to another section here. */
  const loaded = $derived(!!s);
  const LAND_FOCUS: Record<string, string> = { 'about-you': 'owner-name', 'my-channels': 'own-channel-input' };
  $effect(() => {
    void router.state;
    if (!loaded) return;
    void tick().then(() => {
      const id = decodeURIComponent(window.location.hash.slice(1));
      if (id) goTo(id, LAND_FOCUS[id]);
    });
  });

  /** Only what stops Nudge working as it should; optional extras never appear here. */
  const needsChannel = $derived(!!s && s.ownChannels.length === 0);
  const needsSetup = $derived(needsChannel || llmPaused);

  // The newest few notes; the rest on request, so a long history does not bury the cards below.
  const NOTES_SHOWN = 5;
  let allNotes = $state(false);
  const shownNotes = $derived(allNotes ? notes.list : notes.list.slice(0, NOTES_SHOWN));

  /** The Android install tip only means something on a touch device. */
  const coarse = typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches;

  let ghAccount = $state('');
  let chanInput = $state('');
  let chanError = $state('');
  let chanBusy = $state(false);

  /** The save and remove handlers of a secret field: `patch` builds the settings update, null clears the stored value. */
  function secretHandlers(patch: (value: string | null) => SettingsUpdate, saved: string, removed: string) {
    return {
      async save(value: string) {
        const ok = await settings.save(patch(value));
        if (ok) toasts.success(saved, 2500);
        return ok;
      },
      async remove() {
        if (await settings.save(patch(null))) toasts.push({ message: removed, timeoutMs: 2500 });
      },
    };
  }
  const youtubeKey = secretHandlers((v) => ({ apiKey: v }), 'API key saved', 'Stored API key removed');
  const llmKey = secretHandlers((v) => ({ llm: { apiKey: v } }), 'Anthropic key saved', 'Anthropic key removed');
  const githubToken = secretHandlers((v) => ({ github: { token: v } }), 'GitHub token saved', 'GitHub token removed');
  async function resetUsage() {
    if (!window.confirm('Delete all usage counts? This cannot be undone. Your inbox and its history are not touched.'))
      return;
    try {
      await api.resetUsage();
      toasts.success('Usage data deleted', 2500);
    } catch (e) {
      toasts.fail(e, 'Could not delete usage data');
    }
  }
  async function addAccount(e: Event) {
    e.preventDefault();
    const login = ghAccount.trim();
    const mine = s?.github.myAccounts ?? [];
    if (!login || mine.some((a) => a.toLowerCase() === login.toLowerCase())) return;
    if (await settings.save({ github: { myAccounts: [...mine, login] } })) ghAccount = '';
  }
  async function removeAccount(login: string) {
    await settings.save({ github: { myAccounts: (s?.github.myAccounts ?? []).filter((a) => a !== login) } });
  }

  async function addChannel(e: Event) {
    e.preventDefault();
    const v = chanInput.trim();
    if (!v || chanBusy) return;
    chanBusy = true;
    chanError = (await settings.addOwnChannel(v)) ?? '';
    chanBusy = false;
    if (!chanError) {
      chanInput = '';
      void sources.load().catch(() => {});
    }
  }
  function num(
    e: Event & { currentTarget: HTMLInputElement },
    field: 'dailyQuotaBudget' | 'manualReserve' | 'backfillDays',
  ) {
    const n = Math.max(0, Math.floor(Number(e.currentTarget.value)));
    if (Number.isFinite(n) && s && n !== s[field]) void settings.save({ [field]: n });
  }

  /** One bucket's follow-up days: whole days, kept within what the server accepts. */
  function bucketDays(e: Event & { currentTarget: HTMLInputElement }, bucket: SnoozeBucket) {
    const n = Math.min(SNOOZE_DAYS_MAX, Math.max(SNOOZE_DAYS_MIN, Math.round(Number(e.currentTarget.value))));
    if (!Number.isFinite(n)) {
      e.currentTarget.value = String(s?.snoozeDays[bucket] ?? '');
      return;
    }
    e.currentTarget.value = String(n);
    if (s && n !== s.snoozeDays[bucket]) void settings.save({ snoozeDays: { [bucket]: n } });
  }

  // Result of the OAuth round trip: toast it once, then drop the query so a reload doesn't repeat it.
  $effect(() => {
    const code = router.query.google;
    if (!code) return;
    untrack(() => {
      const t = googleToast(code);
      toasts.push({ message: t.message, kind: t.kind, timeoutMs: t.kind === 'error' ? 10000 : 5000 });
      router.setQuery({ google: undefined });
    });
  });

  let clientJson = $state('');
  let clientError = $state('');
  let clientBusy = $state(false);
  let connecting = $state(false);
  let copied = $state(false);
  const google = $derived(s?.google ?? null);
  const gState = $derived(google ? googleState(google) : 'no-client');

  async function saveClient() {
    if (!clientJson.trim() || clientBusy) return;
    clientBusy = true;
    clientError = (await settings.saveGoogleClient(clientJson.trim())) ?? '';
    clientBusy = false;
    if (!clientError) {
      clientJson = '';
      toasts.success('OAuth client saved', 2500);
    }
  }
  async function removeClient() {
    if (!window.confirm('Remove the stored OAuth client? Connected accounts will stop working.')) return;
    clientError = (await settings.saveGoogleClient(null)) ?? '';
  }
  async function connect() {
    connecting = true;
    if (!(await settings.connectGoogle())) connecting = false;
  }
  function disconnect(channelId: string, title: string | null) {
    if (!window.confirm(`Disconnect ${title ?? channelId}? Replies will go back to copy & open.`)) return;
    void settings.disconnectGoogle(channelId);
  }
  async function copyRedirect(uri: string) {
    try {
      await navigator.clipboard.writeText(uri);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {
      toasts.error('Could not copy');
    }
  }

  // Only a key stored in the database can be replaced here; an env key takes priority over it anyway.
  const sourceLabel = {
    env: 'from the YOUTUBE_API_KEY environment variable (change it there)',
    settings: "stored in Nudge's database",
  } as const;
</script>

<div class="page">
  <h1>Settings</h1>
  <nav class="toc meta" aria-label="Settings sections">
    <a href="#you">You</a><span aria-hidden="true">·</span><a href="#preferences">Preferences</a><span
      aria-hidden="true"
    >
      ·
    </span><a href="#connections">Connections</a><span aria-hidden="true">·</span><a href="#sync">Sync and data</a>
  </nav>
  {#if s}
    {#if needsSetup}
      <div class="setup" role="status" data-testid="profile-banner">
        <strong>Finish setting up</strong>
        <ul>
          {#if needsChannel}
            <li data-testid="setup-channel">
              <a class="link" href="#my-channels" onclick={showMyChannels}>Add your channel</a>, so your own comments
              stay out of the inbox.
            </li>
          {/if}
          {#if llmPaused}
            <li data-testid="setup-profile">
              <a class="link" href="#about-you" onclick={showAboutYou}>Fill in About you</a>. LLM features are paused
              until your profile is filled in: suggestions, nudge drafts and the assistant make no model calls until it
              has a name and a description.
            </li>
          {/if}
        </ul>
      </div>
    {/if}

    <section class="group first" id="you" aria-labelledby="you-h">
      <h2 id="you-h">You</h2>
      <p class="blurb">
        Who Nudge works for. The assistant is told this, and your own comments and pull requests stay out of the inbox.
      </p>
    </section>

    <section class="panel sec" id="about-you" data-testid="settings-about">
      <h3>About you</h3>
      <p class="muted meta">
        Suggestions, nudge drafts and the assistant are written for you, so the model is told who you are. Until both
        fields are filled in, nothing is sent to the model at all.
      </p>
      {#if !s.llm.configured}
        <p class="faint meta" data-testid="about-needs-key">
          Used once you add an Anthropic key under <a class="link" href="#assistant">Connections &rsaquo; Assistant</a>.
        </p>
      {/if}
      <form class="owner" onsubmit={saveOwner}>
        <label class="stack" for="owner-name">
          <span>What should the assistant call you?</span>
          <input
            id="owner-name"
            class="input"
            maxlength={OWNER_NAME_MAX}
            placeholder="e.g. Alex"
            autocomplete="given-name"
            bind:value={ownerName}
            data-testid="owner-name"
          />
        </label>
        <label class="stack" for="owner-about">
          <span>
            A short paragraph about who you are and what you maintain. It is sent to the model with every
            classification, so keep it factual.
          </span>
          <textarea
            id="owner-about"
            class="input about"
            rows="4"
            maxlength={OWNER_ABOUT_MAX}
            placeholder="e.g. Alex runs a YouTube channel about programming and maintains a few open-source libraries."
            bind:value={ownerAbout}
            data-testid="owner-about"></textarea>
        </label>
        <div class="line">
          <span class="faint meta grow">{ownerAbout.trim().length} / {OWNER_ABOUT_MAX}</span>
          <button class="btn primary" type="submit" disabled={!ownerDirty || ownerBusy} data-testid="owner-save">
            {ownerBusy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </section>

    <section class="panel sec" id="my-channels" data-testid="settings-channels">
      <h3>My channels</h3>
      <p class="muted meta">
        Paste your channel URL or @handle. Comments from your channels never land in the inbox, replying from them marks
        earlier comments as answered, and their uploads are tracked as a source.
      </p>
      <div class="chips" data-testid="own-channels">
        {#each s.ownChannels as c (c.id)}
          <span class="chip" data-testid="own-channel-chip">
            <Avatar name={c.title ?? c.id} url={c.thumbnailUrl} size={18} />
            <span title={c.id}>{c.title ?? c.id}</span>
            <button aria-label="Remove {c.title ?? c.id}" onclick={() => void settings.removeOwnChannel(c.id)}>
              ×
            </button>
          </span>
        {:else}
          <span class="faint meta">None yet.</span>
        {/each}
      </div>
      <form class="line" onsubmit={addChannel}>
        <input
          id="own-channel-input"
          class="input grow"
          placeholder="https://www.youtube.com/@yourchannel or @yourchannel"
          bind:value={chanInput}
          aria-label="Channel URL or @handle"
          spellcheck="false"
          autocomplete="off"
          data-testid="own-channel-input"
        />
        <button class="btn" type="submit" disabled={!chanInput.trim() || chanBusy}>
          {chanBusy ? 'Finding…' : 'Add'}
        </button>
      </form>
      {#if chanError}<p class="bad meta" role="alert">{chanError}</p>{/if}
    </section>

    <section class="panel sec" id="github-accounts" data-testid="settings-github-accounts">
      <h3>My GitHub accounts</h3>
      <p class="muted meta">
        Pull requests and issues opened by these logins are yours, so they never reach the inbox. Include any account an
        agent uses for you.
      </p>
      <div class="chips" data-testid="github-accounts">
        {#each s.github.myAccounts as login (login)}
          <span class="chip">
            {login}<button aria-label="Remove {login}" onclick={() => void removeAccount(login)}>×</button>
          </span>
        {:else}
          <span class="faint meta">None yet.</span>
        {/each}
      </div>
      <form class="line" onsubmit={addAccount}>
        <input
          class="input grow"
          bind:value={ghAccount}
          placeholder="GitHub login, e.g. octocat"
          aria-label="GitHub login"
          data-testid="github-account"
          autocomplete="off"
          spellcheck="false"
        />
        <button class="btn" type="submit" disabled={!ghAccount.trim()}>Add account</button>
      </form>
    </section>

    <section class="group" id="preferences" aria-labelledby="preferences-h">
      <h2 id="preferences-h">Preferences</h2>
      <p class="blurb">How Nudge looks and behaves day to day.</p>
    </section>

    <section class="panel sec" id="appearance" data-testid="settings-appearance">
      <h3>Appearance</h3>
      <div class="seg" role="group" aria-label="Theme">
        {#each [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']] as [v, l] (v)}
          <button
            class="segbtn"
            class:on={theme.preference === v}
            aria-pressed={theme.preference === v}
            onclick={() => theme.set(v as ThemePref)}
          >
            {l}
          </button>
        {/each}
      </div>
      <p class="faint meta keys-only">Press <kbd class="mono">t</kbd> anywhere to cycle.</p>
    </section>

    <section class="panel sec" id="suggestions" data-testid="settings-suggestions">
      <h3>Suggestions</h3>
      <label class="field">
        <span>Show suggestions</span>
        <input
          type="checkbox"
          checked={ui.showSuggestions}
          data-testid="show-suggestions"
          onchange={(e) => ui.setShowSuggestions(e.currentTarget.checked)}
        />
      </label>
      <p class="faint meta">
        A hint on each item (reply, act, skip or spam) with the reason. It only suggests; nothing is done for you.
      </p>
      {#if !s.llm.configured && !s.demo}
        <p class="meta warn" data-testid="suggestions-need-key">
          Needs an Anthropic key: see <a class="link" href="#assistant">Connections &rsaquo; Assistant</a>.
        </p>
      {/if}
      <SuggestProgress />
    </section>

    <section class="panel sec" id="notes" data-testid="settings-notes">
      <h3>Notes</h3>
      <p class="muted meta">
        What you tell the assistant about a suggestion, an item or how you like things done (press
        <kbd class="mono">c</kbd> and say it). Every note is kept. A note switched off here stays on record but is no longer
        shown to the model; “standing” notes apply to every suggestion, the others to one item.
      </p>
      <ul class="notes">
        {#each shownNotes as n (n.id)}
          <li class="note" class:off={!n.enabled} data-testid="note-row">
            <div class="notehead meta faint">
              <span>{new Date(n.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
              <span class="badge" data-testid="note-scope">
                {n.scope === 'standing' ? 'Standing' : 'About an item'}
              </span>
              {#if n.source === 'voice'}<span class="badge">Voice</span>{/if}
              {#if n.itemTitle}<span class="truncate notetitle" title={n.itemTitle} data-testid="note-item">
                  {n.itemTitle}
                </span>{/if}
            </div>
            <textarea
              class="input notetext"
              rows="2"
              maxlength="1000"
              aria-label="Note"
              data-testid="note-text"
              value={n.text}
              onchange={(e) => {
                const text = e.currentTarget.value.trim();
                if (text && text !== n.text) void notes.patch(n.id, { text });
                else e.currentTarget.value = n.text;
              }}></textarea>
            {#if noteContext(n)}<p class="meta faint">{noteContext(n)}</p>{/if}
            <div class="noteacts">
              <label class="check">
                <input
                  type="checkbox"
                  checked={n.enabled}
                  data-testid="note-enabled"
                  onchange={(e) => void notes.patch(n.id, { enabled: e.currentTarget.checked })}
                />
                <span>Tell the model</span>
              </label>
              <button
                class="btn ghost sm danger"
                aria-label="Delete note"
                data-testid="note-delete"
                onclick={() => void notes.remove(n.id)}
              >
                <Icon name="trash" size={14} />
              </button>
            </div>
          </li>
        {:else}
          <li class="faint meta" data-testid="notes-empty">No notes yet.</li>
        {/each}
      </ul>
      {#if notes.list.length > NOTES_SHOWN}
        <div>
          <button class="btn" data-testid="notes-all" onclick={() => (allNotes = !allNotes)}>
            {allNotes ? 'Show fewer' : `Show all (${notes.list.length})`}
          </button>
        </div>
      {/if}
    </section>

    <section class="panel sec" id="snoozing" data-testid="settings-snooze">
      <h3>Snoozing until activity</h3>
      <p class="meta muted">
        An item snoozed "until activity" comes back as soon as someone else comments, merges or replies. If nothing
        happens it comes back anyway after this many days, marked as still waiting.
      </p>
      {#each SNOOZE_BUCKETS as b (b)}
        <label class="field">
          <span>{BUCKETS[b].label} <small class="faint">days</small></span>
          <input
            class="input num"
            type="number"
            inputmode="numeric"
            min={SNOOZE_DAYS_MIN}
            max={SNOOZE_DAYS_MAX}
            step="1"
            value={s.snoozeDays[b]}
            data-testid="snooze-days-{b}"
            onchange={(e) => bucketDays(e, b)}
          />
        </label>
      {/each}
    </section>

    <section class="panel sec" id="this-device" data-testid="settings-notifications">
      <h3>On this device</h3>
      <p class="faint meta">Settings for this browser only; set them again on each phone or computer.</p>
      {#if push.status === 'unsupported'}
        <p class="muted meta">
          This browser can’t show push notifications here. They need HTTPS (or localhost) and a browser with Web Push
          support, such as Chrome on Android.
        </p>
      {:else}
        <p class="muted meta">
          Get a notification on <strong>this device</strong> when comments arrive or a snoozed one comes back. Tapping it
          opens that comment. You need to be able to reach Nudge (e.g. signed in through Cloudflare Access) to open it.
        </p>
        {#if push.status === 'blocked'}
          <p class="bad meta">
            Notifications are blocked for this site. Allow them in the browser’s site settings, then come back.
          </p>
        {:else}
          <div class="line">
            {#if push.status === 'on'}
              <button class="btn" data-testid="push-off" disabled={push.busy} onclick={() => void push.disable()}>
                Turn off on this device
              </button>
            {:else}
              <button
                class="btn primary"
                data-testid="push-on"
                disabled={push.busy || push.status === 'checking'}
                onclick={() => void push.enable()}
              >
                Turn on for this device
              </button>
            {/if}
          </div>
        {/if}
        {#if push.status === 'on'}
          <label class="field">
            <span>New comments</span>
            <input
              type="checkbox"
              data-testid="push-new"
              checked={push.prefs.newComments}
              onchange={(e) => void push.setPref('newComments', e.currentTarget.checked)}
            />
          </label>
          <label class="field">
            <span>Snoozed comments coming back</span>
            <input
              type="checkbox"
              data-testid="push-wake"
              checked={push.prefs.snoozeWake}
              onchange={(e) => void push.setPref('snoozeWake', e.currentTarget.checked)}
            />
          </label>
          <div>
            <button class="btn" data-testid="push-test" onclick={() => void push.sendTest()}>Send a test</button>
          </div>
        {/if}
      {/if}
      {#if push.canInstall}
        <div>
          <button class="btn" data-testid="push-install" onclick={() => void push.install()}>Install as an app</button>
        </div>
      {:else if !push.installed && coarse}
        <p class="faint meta" data-testid="install-tip">
          Tip: on Android, Chrome’s menu → “Install app” gives Nudge its own icon and a window without the address bar.
        </p>
      {/if}
    </section>

    <section class="panel sec" id="adventure" data-testid="settings-adventure">
      <h3>Adventure mode</h3>
      <label class="field">
        <span>Levels, titles and silly loot</span>
        <input
          type="checkbox"
          checked={s.rpg.enabled}
          data-testid="rpg-enabled"
          onchange={(e) => void settings.save({ rpg: { enabled: e.currentTarget.checked } })}
        />
      </label>
      <label class="field">
        <span>Level-up sound</span>
        <input
          type="checkbox"
          checked={s.rpg.sound}
          disabled={!s.rpg.enabled}
          data-testid="rpg-sound"
          onchange={(e) => void settings.save({ rpg: { sound: e.currentTarget.checked } })}
        />
      </label>
      <p class="faint meta">
        A level and a silly title earned from the triage you have already done, shown in the sidebar and in the Hall of
        Heroes under Stats, with a short chime on a level-up. Decoration only: it never changes how anything works.
      </p>
    </section>

    <section class="group" id="connections" aria-labelledby="connections-h">
      <h2 id="connections-h">Connections</h2>
      <p class="blurb">Keys and accounts Nudge uses to reach other services. Usually set once.</p>
    </section>

    <section class="panel sec" id="youtube-key" data-testid="settings-key">
      <h3>YouTube API key</h3>
      {#if !s.apiKey.configured}
        <p class="muted meta">No key configured. Sync is disabled until you add one.</p>
      {/if}
      <KeyField
        configured={s.apiKey.configured}
        replaceable={s.apiKey.source === 'settings'}
        label="API key"
        test={(k) => api.testKey(k)}
        save={youtubeKey.save}
        remove={youtubeKey.remove}
      >
        {#snippet status()}
          Key <code>…{s.apiKey.last4}</code>, {sourceLabel[s.apiKey.source ?? 'settings']}.
        {/snippet}
      </KeyField>
    </section>

    <section class="panel sec" id="assistant" data-testid="settings-llm">
      <h3>Assistant: Anthropic API key</h3>
      {#if !s.llm.configured}
        <p class="muted meta">
          Powers suggestions, nudge drafts and spoken or typed commands (press <kbd class="mono">c</kbd>). Use a key
          with a small spend limit. Without one, Nudge works without suggestions and what you say is saved as a plain
          todo.
        </p>
      {/if}
      <KeyField
        configured={s.llm.configured}
        label="Anthropic API key"
        test={(k) => api.testLlm(k)}
        save={llmKey.save}
        remove={llmKey.remove}
        inputTestId="llm-key"
        saveTestId="llm-save"
        resultTestId="llm-result"
      >
        {#snippet status()}
          Key <code>…{s.llm.last4}</code> ({s.llm.model}), stored in Nudge's database.
        {/snippet}
      </KeyField>
    </section>

    <section class="panel sec" id="github" data-testid="settings-github">
      <h3>GitHub token</h3>
      {#if !s.github.configured}
        <p class="muted meta">
          No token: public repositories still work, with a low rate limit. For private repositories or a higher limit,
          create a <strong>fine-grained</strong> token (GitHub &rsaquo; Settings &rsaquo; Developer settings): all
          repositories, with <em>Issues</em> and <em>Pull requests</em> set to read-only. A classic token cannot be read-only
          for private repositories. Nudge never writes to GitHub.
        </p>
      {/if}
      <KeyField
        configured={s.github.configured}
        label="GitHub token"
        placeholder="Paste a token…"
        test={(k) => api.testGithub(k)}
        save={githubToken.save}
        remove={githubToken.remove}
        inputTestId="github-token"
        saveTestId="github-save"
        resultTestId="github-result"
      >
        {#snippet status()}
          Token <code>…{s.github.last4}</code>, stored in Nudge's database.
        {/snippet}
      </KeyField>
    </section>

    <section class="panel sec" id="reply" data-testid="settings-google">
      <h3>Post replies from Nudge</h3>
      {#if google}
        <p class="muted meta">
          Optional. Lets Nudge post your replies on YouTube itself instead of copying them and opening YouTube. It needs
          a one-off Google Cloud setup; the
          <a
            class="link"
            href="https://github.com/mattgodbolt/nudge/blob/main/docs/YOUTUBE.md#replying-from-the-app-optional"
            target="_blank"
            rel="noopener noreferrer"
          >
            setup checklist
          </a>
          walks through it.
        </p>
        {#snippet redirectLine(uri: string)}
          <div class="line redirect">
            <span class="faint meta">Redirect URI</span>
            <code class="grow mono uri" data-testid="google-redirect">{uri}</code>
            <button class="btn sm" onclick={() => copyRedirect(uri)}>{copied ? 'Copied' : 'Copy'}</button>
          </div>
        {/snippet}
        {#if gState === 'no-client'}
          <ol class="steps">
            <li class="step">
              <span>Create an OAuth client (Web application) in Google Cloud with this redirect URI:</span>
              {@render redirectLine(google.redirectUri)}
            </li>
            <li class="step">
              <span>Download its JSON and paste it here:</span>
              <textarea
                class="input mono json"
                rows="5"
                placeholder="Paste the downloaded client JSON…"
                bind:value={clientJson}
                spellcheck="false"
                autocomplete="off"
                aria-label="OAuth client JSON"
                data-testid="google-client-json"></textarea>
              <div class="line">
                <button class="btn primary" onclick={saveClient} disabled={!clientJson.trim() || clientBusy}>
                  {clientBusy ? 'Saving…' : 'Save'}
                </button>
              </div>
              {#if clientError}<p class="bad meta" role="alert">{clientError}</p>{/if}
            </li>
            <li class="step">
              <span>Connect your Google account (the button appears here once the client is saved).</span>
            </li>
          </ol>
        {:else}
          <ul class="accounts" data-testid="google-accounts">
            {#each google.accounts as a (a.channelId)}
              <li class="acct" data-testid="google-account">
                <Avatar name={a.title ?? a.channelId} url={a.thumbnailUrl} size={28} />
                <div class="who">
                  <strong>{a.title ?? a.channelId}</strong>
                  <span class="faint meta">{connectedLabel(a.connectedAt)}</span>
                  {#if a.needsReauth}
                    <span class="bad meta" role="alert">Google sign-in expired or was revoked</span>
                  {/if}
                </div>
                {#if google.accounts.length > 1}
                  <label class="meta def">
                    <input
                      type="radio"
                      name="google-default"
                      checked={a.isDefault}
                      onchange={() => void settings.setDefaultGoogle(a.channelId)}
                    />
                    Default
                  </label>
                {/if}
                {#if a.needsReauth}
                  <button class="btn sm primary" onclick={connect} disabled={connecting}>Reconnect</button>
                {/if}
                <button class="btn sm danger" onclick={() => disconnect(a.channelId, a.title)}>Disconnect</button>
              </li>
            {/each}
          </ul>
          <div class="line">
            <button
              class="btn"
              class:primary={gState !== 'connected'}
              onclick={connect}
              disabled={connecting}
              data-testid="google-connect"
            >
              {connecting
                ? 'Opening Google…'
                : gState === 'connected'
                  ? 'Add another channel'
                  : 'Connect Google account'}
            </button>
          </div>
          {#if anyNeedsReauth(google.accounts)}
            <p class="faint meta">
              If the Google Cloud app is still in Testing status, sign-ins expire weekly: publish the app (step 6 of the
              setup checklist) to stop that.
            </p>
          {/if}
          <details class="setupdetails" data-testid="google-setup">
            <summary class="meta">Google Cloud setup</summary>
            <p class="muted meta">
              Using the OAuth client from <strong>{clientSourceLabel[google.clientSource ?? 'settings']}</strong>.
              {#if google.clientSource === 'settings'}
                <button class="link" onclick={removeClient}>Remove client</button>
              {/if}
            </p>
            {@render redirectLine(google.redirectUri)}
          </details>
        {/if}
      {/if}
    </section>

    <section class="group" id="sync" aria-labelledby="sync-h">
      <h2 id="sync-h">Sync and data</h2>
      <p class="blurb">Polling and quota, usage counts, and the running version.</p>
    </section>

    <section class="panel sec" id="syncing" data-testid="settings-sync">
      <h3>Syncing</h3>
      <label class="field">
        <span>Background polling</span>
        <input
          type="checkbox"
          checked={s.pollEnabled}
          onchange={(e) => void settings.save({ pollEnabled: e.currentTarget.checked })}
        />
      </label>
      <label class="field">
        <span>Daily quota budget <small class="faint">units</small></span>
        <input
          class="input num"
          type="number"
          min="0"
          step="500"
          value={s.dailyQuotaBudget}
          onchange={(e) => num(e, 'dailyQuotaBudget')}
        />
      </label>
      <label class="field">
        <span>Manual reserve <small class="faint">units kept for manual syncs</small></span>
        <input
          class="input num"
          type="number"
          min="0"
          step="100"
          value={s.manualReserve}
          onchange={(e) => num(e, 'manualReserve')}
        />
      </label>
      <label class="field">
        <span>Backfill <small class="faint">days of history for new sources</small></span>
        <input
          class="input num"
          type="number"
          min="0"
          max="3650"
          value={s.backfillDays}
          onchange={(e) => num(e, 'backfillDays')}
        />
      </label>
      {#if sync.quota}
        <p class="meta muted">
          Today (Pacific): <span class="mono">{formatNumber(sync.quota.used)}</span> of
          <span class="mono">{formatNumber(sync.quota.budget)}</span>
          units used.
          {#if sync.blocked}Blocked until {sync.quota.blockedUntil
              ? until(sync.quota.blockedUntil, sync.now)
              : ''}.{/if}
        </p>
      {/if}
    </section>

    <section class="panel sec" id="usage" data-testid="settings-usage">
      <h3>Usage data</h3>
      <p class="meta muted">
        Nudge counts which features you use and how (keyboard, button, touch), so you can see what earns its place. Only
        counts are kept, in this server's database: never what you typed, read or searched for. See them under Stats.
      </p>
      <div>
        <button class="btn danger" data-testid="reset-usage" onclick={() => void resetUsage()}>Reset usage data</button>
      </div>
    </section>

    <section class="panel sec" id="version" data-testid="settings-version">
      <h3>Version</h3>
      <p class="meta muted">
        Nudge <code class="mono" data-testid="about-server">{s.version}</code>
        {#if s.version !== BUILD_VERSION && s.version !== 'dev' && BUILD_VERSION !== 'dev'}
          · this page is <code class="mono" data-testid="about-page">{BUILD_VERSION}</code>, so it is out of date. Use
          Refresh to reload.
        {/if}
      </p>
      {#if s.demo}
        <p class="meta muted">Demo mode is on: data comes from a simulated YouTube and nothing is sent anywhere.</p>
      {/if}
    </section>
  {:else}
    <p class="muted">Loading…</p>
  {/if}
</div>

<style>
  .page {
    flex: 1;
    overflow-y: auto;
    padding: var(--s5);
    display: flex;
    flex-direction: column;
    gap: var(--s4);
    max-width: 720px;
    width: 100%;
    margin: 0 auto;
  }
  /* The page scrolls; its sections must keep their natural height rather than shrink to fit the viewport. */
  .page > :global(*) {
    flex-shrink: 0;
  }
  h1 {
    font-size: 18px;
    font-weight: 600;
    letter-spacing: -0.02em;
  }
  /* Group headings: plain text colour and a rule above, so the four groups read as chapters of one page. */
  h2 {
    font-size: 15px;
    font-weight: 600;
    color: var(--text);
  }
  h3 {
    font-size: 14px;
    font-weight: 600;
  }
  .toc {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s1) var(--s2);
    margin-top: calc(-1 * var(--s2));
    color: var(--text-faint);
  }
  .toc a {
    color: var(--accent);
  }
  .group {
    display: flex;
    flex-direction: column;
    gap: var(--s1);
    margin-top: var(--s4);
    padding-top: var(--s4);
    border-top: 1px solid var(--border);
  }
  .group.first {
    margin-top: 0;
    padding-top: 0;
    border-top: 0;
  }
  .blurb {
    font-size: 12px;
    color: var(--text-muted);
  }
  .page :global(section[id]) {
    scroll-margin-top: var(--s4);
  }
  .sec {
    padding: var(--s4);
    display: flex;
    flex-direction: column;
    gap: var(--s3);
  }
  .line {
    display: flex;
    gap: var(--s2);
  }
  /* On a phone an input given the row takes all of it and its buttons wrap below, instead of squeezing it. */
  @media (max-width: 899px) {
    .line:has(> .input.grow) {
      flex-wrap: wrap;
    }
    .line > .input.grow {
      flex-basis: 100%;
    }
  }
  .setup {
    padding: var(--s3) var(--s4);
    border: 1px solid var(--warn);
    border-radius: var(--radius);
    background: color-mix(in srgb, var(--warn) 14%, transparent);
    line-height: 1.5;
  }
  .setup ul {
    margin: var(--s1) 0 0;
    padding-left: var(--s4);
  }
  .warn {
    color: var(--warn);
  }
  .steps {
    margin: 0;
    padding-left: var(--s4);
    display: flex;
    flex-direction: column;
    gap: var(--s3);
  }
  /* Not flex: a flex li loses its list-item display, and with it the step number. */
  .step {
    display: list-item;
  }
  .step > :global(* + *) {
    margin-top: var(--s2);
  }
  .step::marker {
    font-weight: 600;
  }
  .setupdetails {
    display: flex;
    flex-direction: column;
    gap: var(--s2);
  }
  .setupdetails summary {
    cursor: pointer;
    color: var(--text-muted);
  }
  .setupdetails[open] summary {
    margin-bottom: var(--s2);
  }
  .owner {
    display: flex;
    flex-direction: column;
    gap: var(--s3);
  }
  .stack {
    display: flex;
    flex-direction: column;
    gap: var(--s1);
  }
  .about {
    width: 100%;
    resize: vertical;
    font: inherit;
  }
  @media (max-width: 899px) {
    .owner .input {
      font-size: 16px;
    }
  }
  .notes {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--s3);
  }
  .note {
    display: flex;
    flex-direction: column;
    gap: var(--s2);
    padding-bottom: var(--s3);
    border-bottom: 1px solid var(--border);
    min-width: 0;
  }
  .note.off .notetext {
    opacity: 0.6;
  }
  .notehead {
    display: flex;
    align-items: center;
    gap: var(--s2);
    min-width: 0;
  }
  .notetitle {
    min-width: 0;
    flex: 1;
  }
  .notetext {
    width: 100%;
    resize: vertical;
    font: inherit;
  }
  .noteacts {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--s3);
  }
  .check {
    display: inline-flex;
    align-items: center;
    gap: var(--s2);
    min-height: 32px;
  }
  @media (max-width: 899px) {
    .notetext {
      font-size: 16px;
    }
    .check {
      min-height: 44px;
    }
  }
  .grow {
    flex: 1;
  }
  .json {
    width: 100%;
    resize: vertical;
    font-size: 12px;
  }
  .redirect {
    align-items: center;
  }
  /* The whole URI must be readable to be copied into Google Cloud by hand, so it wraps rather than truncating. */
  .uri {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  @media (max-width: 899px) {
    .redirect {
      flex-wrap: wrap;
    }
    .uri {
      flex-basis: 100%;
      order: 1;
    }
    .redirect .btn {
      order: 2;
    }
  }
  .accounts {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--s2);
  }
  .acct {
    display: flex;
    align-items: center;
    gap: var(--s3);
  }
  .who {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .def {
    display: inline-flex;
    gap: 4px;
    align-items: center;
  }
  .link {
    border: 0;
    background: none;
    padding: 0;
    color: var(--accent);
    cursor: pointer;
    text-decoration: underline;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s2);
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  /* A bigger hit area than the 22px chip, without making the chip itself taller. */
  .chip button {
    border: 0;
    background: none;
    cursor: pointer;
    color: var(--text-faint);
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 32px;
    min-height: 32px;
    margin: -5px -8px -5px -6px;
  }
  @media (max-width: 899px), (pointer: coarse) {
    .chip button {
      min-width: 44px;
      min-height: 44px;
      margin: -4px -6px -4px -8px;
    }
  }
  .chip button:hover {
    color: var(--danger);
  }
  .field {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--s3);
  }
  .num {
    width: 110px;
    text-align: right;
  }
  .bad {
    color: var(--danger);
  }
  .seg {
    display: inline-flex;
    width: max-content;
  }
  .segbtn {
    height: 28px;
    padding: 0 14px;
    border: 1px solid var(--border-strong);
    background: var(--bg-elev);
    cursor: pointer;
    color: var(--text-muted);
  }
  .segbtn:first-child {
    border-radius: var(--radius) 0 0 var(--radius);
  }
  .segbtn:last-child {
    border-radius: 0 var(--radius) var(--radius) 0;
  }
  .segbtn + .segbtn {
    margin-left: -1px;
  }
  .segbtn.on {
    background: var(--accent-soft);
    border-color: var(--accent);
    color: var(--accent);
    position: relative;
    z-index: 1;
  }
</style>
