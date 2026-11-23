<script lang="ts">
  import type { Snippet } from 'svelte';
  import { tick } from 'svelte';

  type Result = { ok: boolean; message: string };

  /**
   * A stored secret (API key or token): once configured it is a status line with Test, Replace and Remove, so a
   * password box is not left sitting there asking to be filled in; Replace brings the box back.
   */
  let {
    configured,
    status,
    replaceable = true,
    removable = true,
    label,
    placeholder = 'Paste a key…',
    test,
    save,
    remove,
    inputTestId,
    saveTestId,
    resultTestId,
  }: {
    configured: boolean;
    /** The one-line description of the key in use, shown while configured. */
    status: Snippet;
    /** False when the key comes from outside Nudge's database (an env var or a file), which Settings cannot change. */
    replaceable?: boolean;
    removable?: boolean;
    label: string;
    placeholder?: string;
    /** Test the pasted value, or the stored key when called without one. */
    test: (key?: string) => Promise<Result>;
    save: (key: string) => Promise<boolean>;
    remove?: () => Promise<void>;
    inputTestId?: string;
    saveTestId?: string;
    resultTestId?: string;
  } = $props();

  let value = $state('');
  let busy = $state(false);
  let replacing = $state(false);
  let result = $state<Result | null>(null);
  let input = $state<HTMLInputElement | null>(null);
  const editing = $derived(!configured || replacing);

  async function runTest() {
    busy = true;
    result = null;
    try {
      result = await test(editing ? value.trim() || undefined : undefined);
    } catch (e) {
      result = { ok: false, message: e instanceof Error ? e.message : 'Test failed' };
    } finally {
      busy = false;
    }
  }
  async function runSave(e: Event) {
    e.preventDefault();
    if (!value.trim()) return;
    if (await save(value.trim())) {
      value = '';
      result = null;
      replacing = false;
    }
  }
  async function startReplace() {
    replacing = true;
    result = null;
    await tick();
    input?.focus();
  }
  function cancel() {
    replacing = false;
    value = '';
    result = null;
  }
</script>

{#if editing}
  <form class="line" onsubmit={runSave}>
    <input
      bind:this={input}
      class="input mono grow"
      type="password"
      {placeholder}
      bind:value
      autocomplete="off"
      aria-label={label}
      data-testid={inputTestId}
    />
    <span class="btns">
      <button class="btn" type="button" onclick={runTest} disabled={busy || !value.trim()}>
        {busy ? 'Testing…' : 'Test'}
      </button>
      <button class="btn primary" type="submit" disabled={!value.trim()} data-testid={saveTestId}>Save</button>
      {#if replacing}<button class="btn ghost" type="button" onclick={cancel}>Cancel</button>{/if}
    </span>
  </form>
{:else}
  <div class="line status">
    <p class="meta muted grow" data-testid="key-status">{@render status()}</p>
    <span class="btns">
      <button class="btn" onclick={runTest} disabled={busy}>{busy ? 'Testing…' : 'Test'}</button>
      {#if replaceable}<button class="btn" onclick={startReplace}>Replace</button>{/if}
      {#if replaceable && removable && remove}<button class="btn danger" onclick={() => void remove()}>
          Remove
        </button>{/if}
    </span>
  </div>
{/if}
{#if result}<p class="meta" class:ok={result.ok} class:bad={!result.ok} data-testid={resultTestId}>
    {result.message}
  </p>{/if}

<style>
  .line {
    display: flex;
    gap: var(--s2);
    align-items: center;
  }
  .btns {
    display: flex;
    gap: var(--s2);
    flex: none;
  }
  .grow {
    flex: 1;
    min-width: 0;
  }
  .status p {
    margin: 0;
  }
  .ok {
    color: var(--success);
  }
  .bad {
    color: var(--danger);
  }
  /* On a phone the input takes the whole row and the buttons go under it, rather than squeezing it to a stub. */
  @media (max-width: 899px) {
    .line {
      flex-wrap: wrap;
    }
    .line > .input.grow,
    .status > .grow {
      flex-basis: 100%;
    }
  }
</style>
