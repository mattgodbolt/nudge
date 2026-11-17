<script lang="ts">
  import { modalScope } from '../lib/keys/modalScope';
  import { assistant } from '../lib/stores/assistant.svelte';
  import { inbox } from '../lib/stores/inbox.svelte';
  import { settings } from '../lib/stores/settings.svelte';
  import Icon from './Icon.svelte';
  import { fade } from 'svelte/transition';

  let box: HTMLTextAreaElement | undefined = $state();
  const selected = $derived(inbox.selected?.item.title ?? null);
  const llmOn = $derived(!!settings.value?.llm.configured);

  $effect(() => {
    if (!assistant.open) return;
    void assistant.focusTick;
    return modalScope({
      id: 'assistant',
      description: 'Close the assistant',
      focus: () => box,
      bindings: [{ id: 'close', keys: ['Escape'], run: () => assistant.close() }],
    });
  });

  function onkeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void assistant.submit();
    }
  }
</script>

{#if assistant.open}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="scrim sheet" transition:fade={{ duration: 100 }} onclick={() => assistant.close()}>
    <div
      class="box panel"
      data-testid="assistant"
      role="dialog"
      tabindex="-1"
      aria-modal="true"
      aria-label="Tell Nudge"
      onclick={(e) => e.stopPropagation()}
    >
      <div class="head">
        <strong>Tell Nudge</strong>
        <span class="faint meta">
          {llmOn ? '“remind me in 3 days to ring the plumber”' : 'saved as a todo (no assistant key yet)'}
        </span>
      </div>
      <textarea
        bind:this={box}
        bind:value={assistant.text}
        {onkeydown}
        rows="3"
        data-testid="assistant-input"
        placeholder={assistant.listening ? 'Listening…' : 'Say or type what you need…'}
        aria-label="Tell Nudge what to do"
        disabled={assistant.busy}></textarea>
      {#if selected && llmOn}
        <p class="faint meta ctx">“this” means: {selected}</p>
      {/if}
      {#if assistant.micError}
        <p class="meta err" role="alert">{assistant.micError}</p>
      {/if}
      <div class="row">
        {#if assistant.micSupported}
          <button
            type="button"
            class="btn mic"
            class:live={assistant.listening}
            data-testid="assistant-mic"
            aria-pressed={assistant.listening}
            aria-label={assistant.listening ? 'Stop dictating' : 'Dictate'}
            onclick={() => assistant.toggleMic()}
          >
            <Icon name="mic" size={18} />
            {assistant.listening ? 'Stop' : 'Dictate'}
          </button>
        {/if}
        <span class="grow faint meta hint">Enter sends · Shift+Enter new line · Esc cancels</span>
        <button
          type="button"
          class="btn primary"
          data-testid="assistant-send"
          disabled={assistant.busy || !assistant.text.trim()}
          onclick={() => void assistant.submit()}
        >
          {assistant.busy ? 'Working…' : 'Send'}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .scrim {
    --scrim-top: 12vh;
  }
  .box {
    width: min(520px, 100%);
    box-shadow: var(--shadow-pop);
    padding: var(--s3);
    display: flex;
    flex-direction: column;
    gap: var(--s2);
  }
  .head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: var(--s3);
  }
  textarea {
    width: 100%;
    resize: vertical;
    min-height: 4.5em;
    font: inherit;
    font-size: 16px; /* no iOS zoom on focus */
  }
  .row {
    display: flex;
    align-items: center;
    gap: var(--s3);
  }
  .grow {
    flex: 1;
  }
  .ctx {
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .err {
    color: var(--danger, #c0392b);
    margin: 0;
  }
  .mic.live {
    background: var(--danger, #c0392b);
    color: #fff;
  }
  @media (max-width: 899px) {
    .box {
      width: 100%;
      border-radius: var(--radius-lg) var(--radius-lg) 0 0;
      border-bottom: 0;
      padding-bottom: calc(var(--s3) + env(safe-area-inset-bottom));
    }
    .hint {
      display: none;
    }
    .mic {
      min-height: 48px;
      padding: 0 var(--s4);
    }
    .row :global(.btn.primary) {
      min-height: 48px;
      padding: 0 var(--s5, 20px);
    }
  }
</style>
