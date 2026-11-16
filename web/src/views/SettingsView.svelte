<script lang="ts">
  import { BUCKETS, SNOOZE_BUCKETS, SNOOZE_DAYS_MAX, SNOOZE_DAYS_MIN, type SnoozeBucket } from '../../../shared/snooze';
  import { BUILD_VERSION } from '../lib/version';
  import { api } from '../lib/api';
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
  import { ui } from '../lib/stores/ui.svelte';
  import { onMount, untrack } from 'svelte';

  onMount(() => {
    void push.init();
    void notes.load();
  });

  /** One line saying what Nudge had suggested, and what he had just done, when a note was made. */
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
          turn: sg.turn as 'matt' | 'them' | 'nobody' | null,
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

  let keyInput = $state('');
  let keyBusy = $state(false);
  let keyResult = $state<{ ok: boolean; message: string } | null>(null);
  let ghToken = $state('');
  let ghBusy = $state(false);
  let ghResult = $state<{ ok: boolean; message: string } | null>(null);
  let ghAccount = $state('');
  let chanInput = $state('');
  let chanError = $state('');
  let chanBusy = $state(false);

  async function testKey() {
    keyBusy = true;
    keyResult = null;
    try {
      keyResult = await api.testKey(keyInput.trim() || undefined);
    } catch (e) {
      keyResult = { ok: false, message: e instanceof Error ? e.message : 'Test failed' };
    } finally {
      keyBusy = false;
    }
  }
  async function saveKey() {
    if (!keyInput.trim()) return;
    if (await settings.save({ apiKey: keyInput.trim() })) {
      keyInput = '';
      keyResult = null;
      toasts.push({ message: 'API key saved', kind: 'success', timeoutMs: 2500 });
    }
  }
  async function removeKey() {
    if (await settings.save({ apiKey: null })) toasts.push({ message: 'Stored API key removed', timeoutMs: 2500 });
  }

  let llmKey = $state('');
  let llmBusy = $state(false);
  let llmResult = $state<{ ok: boolean; message: string } | null>(null);
  async function testLlm() {
    llmBusy = true;
    llmResult = null;
    try {
      llmResult = await api.testLlm(llmKey.trim() || undefined);
    } catch (e) {
      llmResult = { ok: false, message: e instanceof Error ? e.message : 'Test failed' };
    } finally {
      llmBusy = false;
    }
  }
  async function saveLlmKey() {
    if (!llmKey.trim()) return;
    if (await settings.save({ llm: { apiKey: llmKey.trim() } })) {
      llmKey = '';
      llmResult = null;
      toasts.push({ message: 'Anthropic key saved', kind: 'success', timeoutMs: 2500 });
    }
  }
  async function removeLlmKey() {
    if (await settings.save({ llm: { apiKey: null } }))
      toasts.push({ message: 'Anthropic key removed', timeoutMs: 2500 });
  }

  async function testGithub() {
    ghBusy = true;
    ghResult = null;
    try {
      ghResult = await api.testGithub(ghToken.trim() || undefined);
    } catch (e) {
      ghResult = { ok: false, message: e instanceof Error ? e.message : 'Test failed' };
    } finally {
      ghBusy = false;
    }
  }
  async function saveGithubToken() {
    if (!ghToken.trim()) return;
    if (await settings.save({ github: { token: ghToken.trim() } })) {
      ghToken = '';
      ghResult = null;
      toasts.push({ message: 'GitHub token saved', kind: 'success', timeoutMs: 2500 });
    }
  }
  async function resetUsage() {
    if (!window.confirm('Delete all usage counts? This cannot be undone. Your inbox and its history are not touched.'))
      return;
    try {
      await api.resetUsage();
      toasts.push({ message: 'Usage data deleted', kind: 'success', timeoutMs: 2500 });
    } catch (e) {
      toasts.error(e instanceof Error ? e.message : 'Could not delete usage data');
    }
  }
  async function removeGithubToken() {
    if (await settings.save({ github: { token: null } }))
      toasts.push({ message: 'GitHub token removed', timeoutMs: 2500 });
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
      toasts.push({ message: 'Google client saved', kind: 'success', timeoutMs: 2500 });
    }
  }
  async function removeClient() {
    if (!window.confirm('Remove the stored Google client? Connected accounts will stop working.')) return;
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

  const sourceLabel = {
    env: 'YOUTUBE_API_KEY environment variable',
    settings: 'Settings (stored in the local database)',
    file: '~/.nudge-key',
  } as const;
</script>

<div class="page">
  <h1>Settings</h1>
  {#if s}
    <section class="panel sec" data-testid="settings-key">
      <h2>YouTube API key</h2>
      <p class="muted meta">
        {#if s.apiKey.configured}
          Using key ending <code>…{s.apiKey.last4}</code> from
          <strong>{sourceLabel[s.apiKey.source ?? 'settings']}</strong>.
          {#if s.apiKey.source !== 'settings'}An env or file key takes priority over one saved here.{/if}
        {:else}
          No key configured. Sync is disabled until you add one.
        {/if}
      </p>
      <div class="line">
        <input
          class="input mono grow"
          type="password"
          placeholder="Paste a key to test or replace…"
          bind:value={keyInput}
          autocomplete="off"
          aria-label="API key"
        />
        <button class="btn" onclick={testKey} disabled={keyBusy || (!keyInput.trim() && !s.apiKey.configured)}
          >{keyBusy ? 'Testing…' : 'Test'}</button
        >
        <button class="btn primary" onclick={saveKey} disabled={!keyInput.trim()}>Save</button>
        {#if s.apiKey.source === 'settings'}<button class="btn danger" onclick={removeKey}>Remove</button>{/if}
      </div>
      {#if keyResult}<p class="meta" class:ok={keyResult.ok} class:bad={!keyResult.ok}>{keyResult.message}</p>{/if}
    </section>

    <section class="panel sec" data-testid="settings-google">
      <h2>Reply from Nudge</h2>
      {#if google}
        <p class="muted meta">
          Connect a Google account to post replies straight from here instead of copying them to YouTube. Setup takes a
          few minutes in Google Cloud; follow the
          <a href="https://github.com/mattgodbolt/nudge" target="_blank" rel="noopener noreferrer">README checklist</a>.
        </p>
        {#if gState === 'no-client'}
          <textarea
            class="input mono json"
            rows="5"
            placeholder="Paste the downloaded client JSON…"
            bind:value={clientJson}
            spellcheck="false"
            autocomplete="off"
            aria-label="Google client JSON"
            data-testid="google-client-json"></textarea>
          <div class="line">
            <button class="btn primary" onclick={saveClient} disabled={!clientJson.trim() || clientBusy}
              >{clientBusy ? 'Saving…' : 'Save'}</button
            >
          </div>
          {#if clientError}<p class="bad meta" role="alert">{clientError}</p>{/if}
        {:else}
          <p class="muted meta">
            Using the Google client from <strong>{clientSourceLabel[google.clientSource ?? 'settings']}</strong>.
            {#if google.clientSource === 'settings'}
              <button class="link" onclick={removeClient}>Remove client</button>
            {/if}
          </p>
        {/if}
        <div class="line redirect">
          <span class="faint meta">Redirect URI</span>
          <code class="grow mono truncate" data-testid="google-redirect">{google.redirectUri}</code>
          <button class="btn sm" onclick={() => copyRedirect(google.redirectUri)}>{copied ? 'Copied' : 'Copy'}</button>
        </div>

        {#if gState !== 'no-client'}
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
              If the Google Cloud app is still in Testing status, sign-ins expire weekly: publish the app (README step
              6) to stop that.
            </p>
          {/if}
        {/if}
      {/if}
    </section>

    <section class="panel sec">
      <h2>My channels</h2>
      <p class="muted meta">
        Paste your channel URL or @handle. Comments from your channels never land in the inbox, replying from them marks
        earlier comments as answered, and their uploads are tracked as a source.
      </p>
      <div class="chips" data-testid="own-channels">
        {#each s.ownChannels as c (c.id)}
          <span class="chip" data-testid="own-channel-chip">
            <Avatar name={c.title ?? c.id} url={c.thumbnailUrl} size={18} />
            <span title={c.id}>{c.title ?? c.id}</span>
            <button aria-label="Remove {c.title ?? c.id}" onclick={() => void settings.removeOwnChannel(c.id)}>×</button
            >
          </span>
        {:else}
          <span class="faint meta">None yet.</span>
        {/each}
      </div>
      <form class="line" onsubmit={addChannel}>
        <input
          class="input grow"
          placeholder="https://www.youtube.com/@yourchannel or @yourchannel"
          bind:value={chanInput}
          aria-label="Channel URL or @handle"
          spellcheck="false"
          autocomplete="off"
          data-testid="own-channel-input"
        />
        <button class="btn" type="submit" disabled={!chanInput.trim() || chanBusy}
          >{chanBusy ? 'Finding…' : 'Add'}</button
        >
      </form>
      {#if chanError}<p class="bad meta" role="alert">{chanError}</p>{/if}
    </section>

    <section class="panel sec">
      <h2>Syncing</h2>
      <label class="field"
        ><span>Background polling</span>
        <input
          type="checkbox"
          checked={s.pollEnabled}
          onchange={(e) => void settings.save({ pollEnabled: e.currentTarget.checked })}
        />
      </label>
      <label class="field"
        ><span>Daily quota budget <small class="faint">units</small></span>
        <input
          class="input num"
          type="number"
          min="0"
          step="500"
          value={s.dailyQuotaBudget}
          onchange={(e) => num(e, 'dailyQuotaBudget')}
        />
      </label>
      <label class="field"
        ><span>Manual reserve <small class="faint">units kept for manual syncs</small></span>
        <input
          class="input num"
          type="number"
          min="0"
          step="100"
          value={s.manualReserve}
          onchange={(e) => num(e, 'manualReserve')}
        />
      </label>
      <label class="field"
        ><span>Backfill <small class="faint">days of history for new sources</small></span>
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

    <section class="panel sec" data-testid="settings-snooze">
      <h2>Snoozing until activity</h2>
      <p class="meta muted">
        An item snoozed "until activity" comes back as soon as someone else comments, merges or replies. If nothing
        happens it comes back anyway after this many days, marked as still waiting.
      </p>
      {#each SNOOZE_BUCKETS as b (b)}
        <label class="field"
          ><span>{BUCKETS[b].label} <small class="faint">days</small></span>
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

    <section class="panel sec" data-testid="settings-llm">
      <h2>Assistant</h2>
      <p class="muted meta">
        {#if s.llm.configured}
          Using an Anthropic key ending <code>…{s.llm.last4}</code> ({s.llm.model}), stored in Nudge's database.
        {:else}
          Press <kbd class="mono">c</kbd> (or the mic button on your phone) and say things like “remind me in 3 days to ring
          the plumber” or “snooze this till Monday”. This needs an Anthropic API key, ideally one with a small spend limit.
          Without one, what you say is saved as a plain todo.
        {/if}
      </p>
      <div class="line">
        <input
          class="input mono grow"
          type="password"
          placeholder="Paste a key to test or replace…"
          bind:value={llmKey}
          autocomplete="off"
          aria-label="Anthropic API key"
          data-testid="llm-key"
        />
        <button class="btn" onclick={testLlm} disabled={llmBusy || (!llmKey.trim() && !s.llm.configured)}
          >{llmBusy ? 'Testing…' : 'Test'}</button
        >
        <button class="btn primary" onclick={saveLlmKey} disabled={!llmKey.trim()} data-testid="llm-save">Save</button>
        {#if s.llm.configured}<button class="btn danger" onclick={removeLlmKey}>Remove</button>{/if}
      </div>
      {#if llmResult}<p class="meta" class:ok={llmResult.ok} class:bad={!llmResult.ok} data-testid="llm-result">
          {llmResult.message}
        </p>{/if}
    </section>

    <section class="panel sec" data-testid="settings-notes">
      <h2>Notes</h2>
      <p class="muted meta">
        What you tell the assistant about a suggestion, an item or how you like things done (press
        <kbd class="mono">c</kbd> and say it). Every note is kept. A note switched off here stays on record but is no longer
        shown to the model; “standing” notes apply to every suggestion, the others to one item.
      </p>
      <ul class="notes">
        {#each notes.list as n (n.id)}
          <li class="note" class:off={!n.enabled} data-testid="note-row">
            <div class="notehead meta faint">
              <span>{new Date(n.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
              <span class="badge" data-testid="note-scope">{n.scope === 'standing' ? 'Standing' : 'About an item'}</span
              >
              {#if n.source === 'voice'}<span class="badge">Voice</span>{/if}
              {#if n.itemTitle}<span class="truncate notetitle" title={n.itemTitle} data-testid="note-item"
                  >{n.itemTitle}</span
                >{/if}
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
              <label class="check"
                ><input
                  type="checkbox"
                  checked={n.enabled}
                  data-testid="note-enabled"
                  onchange={(e) => void notes.patch(n.id, { enabled: e.currentTarget.checked })}
                />
                <span>Tell the model</span></label
              >
              <button
                class="btn ghost sm danger"
                aria-label="Delete note"
                data-testid="note-delete"
                onclick={() => void notes.remove(n.id)}><Icon name="trash" size={14} /></button
              >
            </div>
          </li>
        {:else}
          <li class="faint meta" data-testid="notes-empty">No notes yet.</li>
        {/each}
      </ul>
    </section>

    <section class="panel sec" data-testid="settings-github">
      <h2>GitHub</h2>
      <p class="muted meta">
        {#if s.github.configured}
          Using a token ending <code>…{s.github.last4}</code>, stored in Nudge's database.
        {:else}
          No token: public repositories still work, with a low rate limit. For private repositories or a higher limit,
          create a <strong>fine-grained</strong> token (GitHub &rsaquo; Settings &rsaquo; Developer settings): all
          repositories, with <em>Issues</em> and <em>Pull requests</em> set to read-only. A classic token cannot be read-only
          for private repositories. Nudge never writes to GitHub.
        {/if}
      </p>
      <div class="line">
        <input
          class="input mono grow"
          type="password"
          placeholder="Paste a token to test or replace…"
          bind:value={ghToken}
          autocomplete="off"
          aria-label="GitHub token"
          data-testid="github-token"
        />
        <button class="btn" onclick={testGithub} disabled={ghBusy || (!ghToken.trim() && !s.github.configured)}
          >{ghBusy ? 'Testing…' : 'Test'}</button
        >
        <button class="btn primary" onclick={saveGithubToken} disabled={!ghToken.trim()} data-testid="github-save"
          >Save</button
        >
        {#if s.github.configured}<button class="btn danger" onclick={removeGithubToken}>Remove</button>{/if}
      </div>
      {#if ghResult}<p class="meta" class:ok={ghResult.ok} class:bad={!ghResult.ok} data-testid="github-result">
          {ghResult.message}
        </p>{/if}
      <h3>My accounts</h3>
      <p class="muted meta">
        Pull requests and issues opened by these logins are yours, so they never land in the inbox. Add your own account
        and any account an agent uses on your behalf.
      </p>
      <div class="chips" data-testid="github-accounts">
        {#each s.github.myAccounts as login (login)}
          <span class="chip"
            >{login}<button aria-label="Remove {login}" onclick={() => void removeAccount(login)}>×</button></span
          >
        {/each}
      </div>
      <form class="line" onsubmit={addAccount}>
        <input
          class="input grow"
          bind:value={ghAccount}
          placeholder="GitHub login, e.g. mattgodbolt"
          aria-label="GitHub login"
          data-testid="github-account"
          autocomplete="off"
          spellcheck="false"
        />
        <button class="btn" type="submit" disabled={!ghAccount.trim()}>Add account</button>
      </form>
    </section>

    <section class="panel sec" data-testid="settings-notifications">
      <h2>Notifications</h2>
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
        {:else if push.status === 'on'}
          <label class="field"
            ><span>New comments</span>
            <input
              type="checkbox"
              data-testid="push-new"
              checked={push.prefs.newComments}
              onchange={(e) => void push.setPref('newComments', e.currentTarget.checked)}
            />
          </label>
          <label class="field"
            ><span>Snoozed comments coming back</span>
            <input
              type="checkbox"
              data-testid="push-wake"
              checked={push.prefs.snoozeWake}
              onchange={(e) => void push.setPref('snoozeWake', e.currentTarget.checked)}
            />
          </label>
        {/if}
        <div class="line">
          {#if push.status === 'on'}
            <button class="btn" data-testid="push-test" onclick={() => void push.sendTest()}>Send a test</button>
            <button class="btn" data-testid="push-off" disabled={push.busy} onclick={() => void push.disable()}
              >Turn off on this device</button
            >
          {:else if push.status !== 'blocked'}
            <button
              class="btn primary"
              data-testid="push-on"
              disabled={push.busy || push.status === 'checking'}
              onclick={() => void push.enable()}>Turn on for this device</button
            >
          {/if}
          {#if push.canInstall}
            <button class="btn" data-testid="push-install" onclick={() => void push.install()}>Install as an app</button
            >
          {/if}
        </div>
        {#if !push.installed && !push.canInstall}
          <p class="faint meta">
            Tip: on Android, Chrome’s menu → “Install app” gives Nudge its own icon and a window without the address
            bar.
          </p>
        {/if}
      {/if}
    </section>

    <section class="panel sec">
      <h2>Appearance</h2>
      <div class="seg" role="group" aria-label="Theme">
        {#each [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']] as [v, l] (v)}
          <button
            class="segbtn"
            class:on={theme.preference === v}
            aria-pressed={theme.preference === v}
            onclick={() => theme.set(v as ThemePref)}>{l}</button
          >
        {/each}
      </div>
      <p class="faint meta">Press <kbd class="mono">t</kbd> anywhere to cycle.</p>
      <label class="field"
        ><span>Show suggestions</span>
        <input
          type="checkbox"
          checked={ui.showSuggestions}
          data-testid="show-suggestions"
          onchange={(e) => ui.setShowSuggestions(e.currentTarget.checked)}
        />
      </label>
      <p class="faint meta">
        A small hint on each item (reply, act, skip or spam) with the reason, from the assistant key's model. It only
        suggests; nothing is ever done for you.
      </p>
      <SuggestProgress />
      <label class="field"
        ><span>Adventure mode (levels, titles, silly loot)</span>
        <input
          type="checkbox"
          checked={s.rpg.enabled}
          data-testid="rpg-enabled"
          onchange={(e) => void settings.save({ rpg: { enabled: e.currentTarget.checked } })}
        />
      </label>
      <label class="field"
        ><span>Level-up sound</span>
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

    <section class="panel sec" data-testid="settings-usage">
      <h2>Usage data</h2>
      <p class="meta muted">
        Nudge counts which features you use and how (keyboard, button, touch), so you can see what earns its place. Only
        counts are kept, in this server's database: never what you typed, read or searched for. See them under Stats.
      </p>
      <div>
        <button class="btn danger" data-testid="reset-usage" onclick={() => void resetUsage()}>Reset usage data</button>
      </div>
    </section>

    <section class="panel sec" data-testid="settings-about">
      <h2>About</h2>
      <p class="meta muted">
        Nudge <code class="mono" data-testid="about-server">{s.version}</code>
        {#if s.version !== BUILD_VERSION && s.version !== 'dev' && BUILD_VERSION !== 'dev'}
          · this page is <code class="mono" data-testid="about-page">{BUILD_VERSION}</code>, so it is out of date. Use
          Refresh to reload.
        {/if}
      </p>
    </section>

    {#if s.demo}
      <p class="meta muted">Demo mode is on: data comes from a simulated YouTube and nothing is sent anywhere.</p>
    {/if}
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
  h2 {
    font-size: 14px;
    font-weight: 600;
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
    resize: vertical;
    font-size: 12px;
  }
  .redirect {
    align-items: center;
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
  .chip button {
    border: 0;
    background: none;
    cursor: pointer;
    color: var(--text-faint);
    padding: 0;
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
  .ok {
    color: var(--success);
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
  h3 {
    margin: var(--s2) 0 0;
    font-size: 13px;
    color: var(--text-muted);
  }
</style>
