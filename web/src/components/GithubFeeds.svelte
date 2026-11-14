<script lang="ts">
  import type { ImportMode, MuteRuleDTO } from '../../../shared/types';
  import { ago } from '../lib/format';
  import { feeds } from '../lib/stores/feeds.svelte';
  import { settings } from '../lib/stores/settings.svelte';
  import { sync } from '../lib/stores/sync.svelte';
  import { router } from '../lib/router.svelte';
  import Icon from './Icon.svelte';

  let owner = $state('');
  let prs = $state(true);
  let issues = $state(true);
  let importMode = $state<ImportMode>('none');
  let busy = $state(false);
  let confirmRemove = $state<number | null>(null);

  const configured = $derived(settings.value?.github.configured ?? false);

  async function add(e: SubmitEvent) {
    e.preventDefault();
    if (!owner.trim() || busy) return;
    busy = true;
    const ok = await feeds.add(owner.trim(), { prs, issues, importMode });
    busy = false;
    if (ok) owner = '';
  }

  const ruleText = (m: MuteRuleDTO) =>
    m.kind === 'bots' ? 'All bots' : m.kind === 'item' ? `Item ${m.value.replace(/^gh:/, '')}` : m.value;
  const kindText = (m: MuteRuleDTO) =>
    ({ repo: 'Repository', owner: 'Organisation', author: 'Author', bots: 'Bots', item: 'Item' })[m.kind];
</script>

<section class="panel gh" data-testid="github-feeds">
  <h2>GitHub</h2>
  <p class="meta muted">
    Every new pull request and issue in a GitHub user's or organisation's repositories lands in your inbox, so you can
    press <kbd class="mono">e</kbd> on the ones that need nothing. Give <span class="mono">owner/repo</span> (e.g.
    compiler-explorer/compiler-explorer) instead to follow just one repository, then widen to the whole owner later.
    {#if !configured}
      No token yet: public repositories work, with a low rate limit. Add a read-only token in
      <a
        class="link"
        href="/settings"
        onclick={(e) => {
          e.preventDefault();
          router.navigate('settings');
        }}>Settings &rsaquo; GitHub</a
      >.
    {/if}
  </p>

  <form class="add" onsubmit={add}>
    <input
      class="input"
      bind:value={owner}
      placeholder="owner or owner/repo"
      aria-label="GitHub user, organisation or repository (owner/repo)"
      data-testid="feed-owner"
      autocomplete="off"
      spellcheck="false"
    />
    <label class="check"><input type="checkbox" bind:checked={prs} /> PRs</label>
    <label class="check"><input type="checkbox" bind:checked={issues} /> Issues</label>
    <select class="input" bind:value={importMode} aria-label="What to import first" data-testid="feed-import">
      <option value="none">From now on</option>
      <option value="recent">Last two weeks</option>
      <option value="all">Everything open</option>
    </select>
    <button
      class="btn primary"
      type="submit"
      disabled={busy || !owner.trim() || (!prs && !issues)}
      data-testid="feed-add">Add</button
    >
  </form>

  {#if feeds.list.length > 0}
    <div class="tablewrap">
      <table class="grid" data-testid="feeds-table">
        <thead><tr><th>Feed</th><th class="num">Inbox</th><th>Last poll</th><th>On</th><th></th></tr></thead>
        <tbody>
          {#each feeds.list as f (f.id)}
            <tr class:off={!f.enabled} data-testid="feed-row">
              <td>
                <a
                  class="stitle"
                  href="/inbox?feed={f.id}"
                  onclick={(e) => {
                    e.preventDefault();
                    router.navigate('inbox', { feed: String(f.id) });
                  }}
                >
                  <Icon name="list" size={14} /><span class="truncate">{f.owner}</span>
                  {#if f.kind === 'repo'}<span class="faint meta" data-testid="feed-kind">repo</span>{/if}
                  <span class="faint meta">{f.prs && f.issues ? 'PRs + issues' : f.prs ? 'PRs' : 'issues'}</span>
                </a>
                {#if f.lastError}<div class="err meta" title={f.lastError} data-testid="feed-last-error">
                    {f.lastError}
                  </div>{/if}
              </td>
              <td class="num">{f.inboxCount}</td>
              <td class="muted meta">
                {f.lastPolledAt ? ago(f.lastPolledAt, sync.now) : 'not yet'}
                {#if f.rate}<span class="faint" title="GitHub API calls left this hour">
                    · {f.rate.remaining} left</span
                  >{/if}
              </td>
              <td
                ><input
                  type="checkbox"
                  checked={f.enabled}
                  aria-label="Enabled"
                  onchange={(e) => void feeds.patch(f.id, { enabled: e.currentTarget.checked })}
                /></td
              >
              <td class="num actions">
                <button class="btn sm" onclick={() => void feeds.poll(f.id)} data-testid="feed-poll">Poll now</button>
                {#if confirmRemove === f.id}
                  <button
                    class="btn sm danger"
                    onclick={() => {
                      confirmRemove = null;
                      void feeds.remove(f.id);
                    }}
                    title="Also removes its items from Nudge">Remove</button
                  >
                  <button class="btn sm ghost" onclick={() => (confirmRemove = null)}>Cancel</button>
                {:else}
                  <button class="btn sm ghost" aria-label="Remove feed" onclick={() => (confirmRemove = f.id)}
                    ><Icon name="trash" size={13} /></button
                  >
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}

  <h3>Muted</h3>
  {#if feeds.mutes.length === 0}
    <p class="meta muted">
      Nothing muted. Press <kbd class="mono">Shift+M</kbd> on a pull request or issue to mute its repository, its whole organisation,
      its author, all bots, or just that item.
    </p>
  {:else}
    <ul class="mutes" data-testid="mute-rules">
      {#each feeds.mutes as m (m.id)}
        <li data-testid="mute-rule">
          <span class="badge">{kindText(m)}</span>
          <span class="truncate grow">{ruleText(m)}</span>
          <button class="btn sm ghost" onclick={() => void feeds.unmute(m.id)} aria-label="Unmute {ruleText(m)}"
            >Unmute</button
          >
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .gh {
    padding: var(--s4);
    display: flex;
    flex-direction: column;
    gap: var(--s3);
  }
  h2,
  h3 {
    margin: 0;
    font-size: 15px;
  }
  h3 {
    font-size: 13px;
    color: var(--text-muted);
  }
  .add {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s2);
    align-items: center;
  }
  .add .input:first-child {
    flex: 1;
    min-width: 220px;
  }
  .check {
    display: inline-flex;
    gap: 4px;
    align-items: center;
    font-size: var(--fs-meta);
  }
  .stitle {
    display: inline-flex;
    gap: var(--s2);
    align-items: center;
    color: inherit;
    text-decoration: none;
  }
  .tablewrap {
    overflow-x: auto;
    /* The panel clips; on a phone the table is wider than it, so scroll it rather than cut off Poll now and Remove. */
    flex-shrink: 0;
  }
  .actions {
    white-space: nowrap;
  }
  .err {
    color: var(--danger);
  }
  tr.off {
    opacity: 0.55;
  }
  .mutes {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--s1);
  }
  .mutes li {
    display: flex;
    gap: var(--s2);
    align-items: center;
  }
  .grow {
    flex: 1;
    min-width: 0;
  }
  @media (max-width: 899px) {
    .add .input,
    .add .btn {
      min-height: 44px;
    }
  }
</style>
