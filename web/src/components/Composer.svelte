<script lang="ts">
  import type { InboxItem } from '../../../shared/types';
  import { keymap } from '../lib/keys/keymap.svelte';
  import { copyOnly, handoff, send } from '../lib/reply';
  import { drafts } from '../lib/stores/drafts.svelte';
  import { inbox } from '../lib/stores/inbox.svelte';
  import { settings } from '../lib/stores/settings.svelte';
  import { ui } from '../lib/stores/ui.svelte';
  import Kbd from './Kbd.svelte';
  import { tick, untrack } from 'svelte';

  let { item, canReply }: { item: InboxItem; canReply: boolean } = $props();

  const id = $derived(item.comment.id);
  const body = $derived(drafts.bodies[id] ?? '');
  const handoffMode = $derived(settings.capabilities.postMode === 'handoff');
  const postAs = $derived(settings.capabilities.postAs?.title ?? null);
  const open = $derived(ui.composerOpen || body.trim().length > 0);
  let ta: HTMLTextAreaElement | undefined = $state();

  const prefill = () => (item.comment.parentId ? `@${item.comment.authorName} ` : '');

  // Restore any saved draft whenever the target comment changes; the composer starts closed.
  $effect(() => {
    const cid = id;
    untrack(() => {
      ui.composerOpen = false;
      void drafts.load(cid);
    });
  });

  // `r` requests focus.
  let handledTick = ui.composerFocusTick;
  $effect(() => {
    const tick_ = ui.composerFocusTick;
    if (tick_ === handledTick) return;
    handledTick = tick_;
    untrack(async () => {
      const existing = await drafts.load(id);
      if (!existing) drafts.set(id, prefill());
      await tick();
      ta?.focus();
      ta?.setSelectionRange(ta.value.length, ta.value.length);
    });
  });

  // Auto-size the textarea.
  $effect(() => {
    void body;
    if (ta) {
      ta.style.height = 'auto';
      ta.style.height = `${Math.min(ta.scrollHeight, 260)}px`;
    }
  });

  let popScope: (() => void) | null = null;
  function onfocus() {
    inbox.composing = true;
    popScope ??= keymap.pushScope('composer');
  }
  function onblur() {
    inbox.composing = false;
    popScope?.();
    popScope = null;
    void drafts.flush(id);
  }

  function doSend() {
    if (!canReply || !body.trim()) return;
    send(item, body);
    ui.composerOpen = false;
    ta?.blur();
  }
  function handoffInstead() {
    if (!canReply || !body.trim()) return;
    handoff(item, body);
    ui.composerOpen = false;
    ta?.blur();
  }
  function cancel() {
    ta?.blur();
    if (!body.trim() || body.trim() === prefill().trim()) {
      drafts.set(id, '');
      ui.composerOpen = false;
    }
  }

  $effect(() => {
    const unreg = keymap.register([
      {
        id: 'composer.send',
        keys: ['$mod+Enter'],
        scope: 'composer',
        group: 'Reply',
        description: 'Send reply',
        palette: false,
        inInputs: true,
        run: doSend,
      },
      {
        id: 'composer.copy',
        keys: ['$mod+Shift+c'],
        scope: 'composer',
        group: 'Reply',
        description: 'Copy reply only',
        palette: false,
        inInputs: true,
        run: () => body.trim() && copyOnly(body),
      },
      {
        id: 'composer.cancel',
        keys: ['Escape'],
        scope: 'composer',
        group: 'Reply',
        description: 'Cancel reply',
        palette: false,
        run: cancel,
      },
    ]);
    return () => {
      unreg();
      popScope?.();
      popScope = null;
      inbox.composing = false;
    };
  });
</script>

<div class="composer" data-testid="composer-box">
  {#if !canReply}
    <div class="closed disabled muted meta">Replies are disabled on this thread.</div>
  {:else if open}
    <textarea
      bind:this={ta}
      class="ta"
      data-testid="composer"
      rows="2"
      placeholder="Write a reply…"
      aria-label="Reply"
      value={body}
      oninput={(e) => drafts.set(id, e.currentTarget.value)}
      {onfocus}
      {onblur}></textarea>
    <div class="bar meta">
      <span class="hint muted">
        {#if handoffMode}<Kbd keys="$mod+Enter" /> copy &amp; open on YouTube{:else}<Kbd keys="$mod+Enter" /> post{postAs
            ? ` as ${postAs}`
            : ''}{/if}
        <span class="sep">·</span>
        <Kbd keys="Escape" /> cancel
      </span>
      <span class="grow"></span>
      <span class="faint count" class:over={body.length > 10000}>{body.length}</span>
      {#if !handoffMode}
        <button
          class="btn sm ghost"
          type="button"
          onclick={handoffInstead}
          disabled={!body.trim()}
          data-testid="composer-handoff">Copy &amp; open instead</button
        >
      {/if}
      <button class="btn sm" type="button" onclick={() => copyOnly(body)} disabled={!body.trim()}>Copy</button>
      <button class="btn sm primary" type="button" onclick={doSend} disabled={!body.trim()} data-testid="composer-send">
        {handoffMode ? 'Copy & open' : 'Reply'}
      </button>
    </div>
  {:else}
    <button class="closed" onclick={() => ui.openComposer()}>
      <span class="muted">Reply…</span>
      <Kbd id="reply.open" />
    </button>
  {/if}
</div>

<style>
  .composer {
    border-top: 1px solid var(--border);
    background: var(--bg-elev);
    padding: var(--s3) var(--s4);
    flex: none;
  }
  .closed {
    width: 100%;
    display: flex;
    justify-content: space-between;
    align-items: center;
    height: 36px;
    padding: 0 var(--s3);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    background: var(--bg);
    cursor: text;
    text-align: left;
  }
  .closed.disabled {
    cursor: default;
  }
  .ta {
    width: 100%;
    resize: none;
    min-height: 56px;
    padding: var(--s2) var(--s3);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    background: var(--bg);
    line-height: 1.5;
    display: block;
  }
  .ta:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft);
  }
  .bar {
    display: flex;
    align-items: center;
    gap: var(--s2);
    margin-top: var(--s2);
  }
  .grow {
    flex: 1;
  }
  .sep {
    margin: 0 4px;
  }
  .over {
    color: var(--danger);
  }
  .count {
    font-variant-numeric: tabular-nums;
  }
  @media (max-width: 899px) {
    .composer {
      padding: var(--s3) var(--s3) calc(var(--s3) + env(safe-area-inset-bottom));
    }
    .closed {
      height: 52px;
      font-size: 16px;
    }
    .ta {
      min-height: 96px;
      font-size: 16px;
    }
    .bar {
      flex-wrap: wrap;
      gap: var(--s2);
      margin-top: var(--s3);
    }
    .hint,
    .grow {
      display: none;
    }
    .bar :global(.btn) {
      flex: 1 1 auto;
      justify-content: center;
      min-height: 52px;
    }
    .bar :global(.btn.primary) {
      flex: 2 1 40%;
      font-weight: 600;
    }
    .count {
      order: 9;
      flex-basis: 100%;
      text-align: right;
    }
  }
</style>
