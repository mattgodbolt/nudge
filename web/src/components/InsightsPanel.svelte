<script lang="ts">
  import {
    CONFIDENCES,
    FIRST_ACTIONS,
    INSIGHTS_RANGES,
    OUTCOMES,
    SUGGESTED,
    type InsightCard,
    type Insights,
    type InsightsRange,
    type Outcome,
  } from '../../../shared/insights';
  import { api } from '../lib/api';
  import {
    ACTION_LABEL,
    AGE_BAND_LABEL,
    OUTCOME_LABEL,
    RANGE_LABEL,
    SIZE_BAND_LABEL,
    SUGGESTED_LABEL,
    TURN_LABEL,
    WEEKDAYS,
    browserTimeZone,
    bucketLabel,
    captions,
    dayLabel,
    heatLevel,
    hourLabel,
    kindLabel,
    loadRange,
    pct,
    perDayLabel,
    providerLabel,
    saveRange,
    shortDuration,
  } from '../lib/insights';
  import { buildPath, router } from '../lib/router.svelte';
  import EmptyState from './EmptyState.svelte';
  import Card from './insights/Card.svelte';
  import Heatmap from './insights/Heatmap.svelte';
  import HourBars from './insights/HourBars.svelte';
  import LineChart from './insights/LineChart.svelte';
  import MeterList, { type Meter } from './insights/MeterList.svelte';
  import RangeBars from './insights/RangeBars.svelte';
  import RankedBars, { type Ranked } from './insights/RankedBars.svelte';
  import SegBar, { type Part } from './insights/SegBar.svelte';
  import StatTile from './insights/StatTile.svelte';

  // Insights (docs/INSIGHTS.md): read-only cards about when things arrive, what happens to them and how the robot
  // does. The server decides every number and whether a card has enough data; this only draws. Nothing here can
  // change an item: the only action is opening one in the All view.

  let range = $state<InsightsRange>(loadRange());
  let ins = $state<Insights | null>(null);
  let failed = $state(false);
  let loading = $state(true);
  const tz = browserTimeZone();

  $effect(() => {
    const r = range;
    loading = true;
    failed = false;
    api
      .insights(r, tz)
      .then((v) => {
        if (r === range) ins = v;
      })
      .catch(() => {
        if (r === range) failed = true;
      })
      .finally(() => {
        if (r === range) loading = false;
      });
  });

  function choose(r: InsightsRange) {
    range = r;
    saveRange(r);
  }
  const itemHref = (id: string) => buildPath('all', {}, { c: id });
  const open = (id: string) => router.navigate('all', { c: id });

  const OUTCOME_COLOR: Record<Outcome, string> = {
    replied: 'var(--viz-replied)',
    done: 'var(--viz-done)',
    dismissed: 'var(--viz-dismissed)',
    snoozed: 'var(--viz-snoozed)',
    legacy: 'var(--viz-legacy)',
    upstream: 'var(--viz-upstream)',
  };
  const CATEGORICAL = [
    'var(--viz-replied)',
    'var(--viz-done)',
    'var(--viz-dismissed)',
    'var(--viz-snoozed)',
    'var(--viz-cat-5)',
    'var(--viz-cat-6)',
  ];
  const groupEmpty = (cards: object) => Object.values(cards).every((c) => (c as InsightCard<unknown>).data === null);
  const rangeText = $derived(
    !ins || !ins.from
      ? ''
      : range === 'all'
        ? `Everything since ${dayLabel(ins.from)} (${ins.days} days)`
        : `The last ${ins.days} days, from ${dayLabel(ins.from)}`,
  );

  const rateMeters = <R extends { n: number; hits: number; rate: number | null }>(rows: R[], label: (r: R) => string) =>
    rows.map((r, i): Meter => ({ key: `${i}-${label(r)}`, label: label(r), value: r.rate, text: pct(r.rate), n: r.n }));
</script>

<section class="insights" class:stale={loading && !!ins} data-testid="insights-section" aria-label="Insights">
  <header class="head">
    <h2>Insights</h2>
    <span class="grow"></span>
    <div class="seg" role="group" aria-label="Range">
      {#each INSIGHTS_RANGES as r (r)}
        <button
          class="btn sm"
          class:primary={range === r}
          aria-pressed={range === r}
          data-testid="insights-range-{r}"
          onclick={() => choose(r)}
        >
          {RANGE_LABEL[r]}
        </button>
      {/each}
    </div>
  </header>

  {#if failed && ins}
    <!-- The new range is highlighted, but these numbers are still the old one's: say so. -->
    <p class="meta failed" role="alert" data-testid="insights-failed">
      Could not load that range; still showing {rangeText.charAt(0).toLowerCase() + rangeText.slice(1)}.
    </p>
  {/if}
  {#if failed && !ins}
    <p class="meta muted">Insights could not be loaded.</p>
  {:else if !ins}
    <p class="meta muted">Loading…</p>
  {:else if ins.empty}
    <div data-testid="insights-empty">
      <EmptyState title="No insights yet" body="Insights appear once things arrive and you deal with them." />
    </div>
  {:else}
    {@const i = ins}
    <p class="sentence" data-testid="insights-sentence">{i.sentence}</p>
    <p class="meta muted scope">
      {rangeText}. Times are {i.tz}. Read-only: nothing here changes your inbox.
    </p>

    <!-- Rhythm -->
    <h3 class="group">Rhythm</h3>
    {#if groupEmpty(i.rhythm)}
      <p class="meta muted collapsed" data-testid="group-empty-rhythm">
        Rhythm: not enough data yet ({i.rhythm.arrivals.n} of {i.rhythm.arrivals.min} arrivals, {i.rhythm.actions.n} of
        {i.rhythm.actions.min} actions).
      </p>
    {:else}
      <div class="cards">
        <Card
          id="arrivals"
          title="When the world writes"
          card={i.rhythm.arrivals}
          caption={captions.arrivals(i)}
          wide
          note={i.rhythm.arrivals.data?.rearrivals
            ? `Includes ${i.rhythm.arrivals.data.rearrivals} comebacks (new activity or reopened). Imports are left out.`
            : 'Imports and backfills are left out: only things that arrived as they happened.'}
        >
          {#snippet chart()}
            <Heatmap grid={i.rhythm.arrivals.data!} unit="arrivals" label="Arrivals by weekday and hour, per day" />
          {/snippet}
          {#snippet table()}
            {@const d = i.rhythm.arrivals.data!}
            <p class="meta muted">When Nudge saw them, against when they were written (they differ by sync lag).</p>
            <div class="tablewrap">
              <table class="itable">
                <thead><tr><th>Hour</th><th class="num">Seen</th><th class="num">Written</th></tr></thead>
                <tbody>
                  {#each Array.from({ length: 24 }, (_, h) => h) as h (h)}
                    <tr>
                      <td>{hourLabel(h)}</td>
                      <td class="num">{d.counts.reduce((a, row) => a + row[h]!, 0)}</td>
                      <td class="num">{d.written.counts.reduce((a, row) => a + row[h]!, 0)}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
              <table class="itable">
                <thead>
                  <tr><th>Day</th><th class="num">Seen</th><th class="num">Written</th><th class="num">Per day</th></tr>
                </thead>
                <tbody>
                  {#each [1, 2, 3, 4, 5, 6, 0] as wd (wd)}
                    {@const seen = d.counts[wd]!.reduce((a, b) => a + b, 0)}
                    <tr>
                      <td>{WEEKDAYS[wd]}</td>
                      <td class="num">{seen}</td>
                      <td class="num">{d.written.counts[wd]!.reduce((a, b) => a + b, 0)}</td>
                      <td class="num">{perDayLabel(d.weekdays[wd] ? seen / d.weekdays[wd]! : 0)}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {/snippet}
        </Card>

        <Card
          id="actions"
          title="When you triage"
          card={i.rhythm.actions}
          caption={captions.actions(i)}
          wide
          note={i.rhythm.actions.data?.bulkActions
            ? `A bulk action counts once (${i.rhythm.actions.data.bulkActions} of these were bulk).`
            : null}
        >
          {#snippet chart()}
            <Heatmap grid={i.rhythm.actions.data!} unit="actions" label="Your actions by weekday and hour, per day" />
          {/snippet}
          {#snippet table()}
            {@const d = i.rhythm.actions.data!}
            <div class="tablewrap">
              <table class="itable">
                <thead>
                  <tr><th>Day</th><th class="num">Actions</th><th class="num">Per day</th><th>Busiest hour</th></tr>
                </thead>
                <tbody>
                  {#each [1, 2, 3, 4, 5, 6, 0] as wd (wd)}
                    {@const row = d.counts[wd]!}
                    {@const n = row.reduce((a, b) => a + b, 0)}
                    <tr>
                      <td>{WEEKDAYS[wd]}</td>
                      <td class="num">{n}</td>
                      <td class="num">{perDayLabel(d.weekdays[wd] ? n / d.weekdays[wd]! : 0)}</td>
                      <td>{n ? hourLabel(row.indexOf(Math.max(...row))) : '–'}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {/snippet}
        </Card>

        <Card
          id="hourly"
          title="Hour by hour"
          card={i.rhythm.hourly}
          caption="Arrivals above, your actions below: same clock, separate scales."
        >
          {#snippet chart()}
            <HourBars values={i.rhythm.hourly.data!.arrivals} unit="arrivals" label="Arrivals" />
            <HourBars values={i.rhythm.hourly.data!.actions} unit="actions" label="Your actions" />
          {/snippet}
          {#snippet table()}
            <div class="tablewrap">
              <table class="itable">
                <thead><tr><th>Hour</th><th class="num">Arrivals</th><th class="num">Actions</th></tr></thead>
                <tbody>
                  {#each i.rhythm.hourly.data!.arrivals as a, h (h)}
                    <tr>
                      <td>{hourLabel(h)}</td><td class="num">{a}</td><td class="num">
                        {i.rhythm.hourly.data!.actions[h]}
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {/snippet}
        </Card>

        <Card
          id="first-response"
          title="First response time"
          card={i.rhythm.firstResponse}
          caption={captions.firstResponse(i)}
          note="From arrival to the first thing you did with it. Bulk actions left out; an hour with fewer than 10 is left blank."
        >
          {#snippet chart()}
            {@const d = i.rhythm.firstResponse.data!}
            {@const maxMed = Math.max(1, ...d.byProvider.map((r) => r.medianMs ?? 0))}
            <MeterList
              label="Median first response by source"
              min={d.rowMin}
              rows={d.byProvider.map((r) => ({
                key: r.provider,
                label: providerLabel(r.provider),
                value: r.medianMs === null ? null : r.medianMs / maxMed,
                text: shortDuration(r.medianMs),
                n: r.n,
              }))}
            />
            <div class="gap"></div>
            <HourBars
              values={d.byHour.map((h) => (h.medianMs === null ? 0 : Math.round(h.medianMs / 360_000) / 10))}
              unit="hours median"
              label="Median hours, by arrival hour"
            />
          {/snippet}
          {#snippet table()}
            {@const d = i.rhythm.firstResponse.data!}
            <div class="tablewrap">
              <table class="itable">
                <thead>
                  <tr><th>Source</th><th class="num">n</th><th class="num">Median</th><th class="num">p75</th></tr>
                </thead>
                <tbody>
                  {#each d.byProvider as r (r.provider)}
                    <tr>
                      <td>{providerLabel(r.provider)}</td><td class="num">{r.n}</td><td class="num">
                        {shortDuration(r.medianMs)}
                      </td><td class="num">{shortDuration(r.p75Ms)}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
              <table class="itable">
                <thead><tr><th>Arrived</th><th class="num">n</th><th class="num">Median</th></tr></thead>
                <tbody>
                  {#each d.byHour as h (h.hour)}
                    <tr>
                      <td>{hourLabel(h.hour)}</td><td class="num">{h.n}</td><td class="num">
                        {shortDuration(h.medianMs)}
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {/snippet}
        </Card>
      </div>
    {/if}

    <!-- Responses -->
    <h3 class="group">Responses</h3>
    {#if groupEmpty(i.responses)}
      <p class="meta muted collapsed" data-testid="group-empty-responses">
        Responses: not enough data yet ({i.responses.outcomes.n} of {i.responses.outcomes.min} things dealt with).
      </p>
    {:else}
      <div class="cards">
        <Card
          id="outcomes"
          title="What happens to things"
          card={i.responses.outcomes}
          caption={captions.outcomes(i)}
          note={[
            i.responses.outcomes.data?.waiting
              ? `${i.responses.outcomes.data.waiting} arrived in this range and are still waiting.`
              : '',
            i.responses.outcomes.data?.bulk ? `${i.responses.outcomes.data.bulk} handled in bulk are not counted.` : '',
          ]
            .filter(Boolean)
            .join(' ') || null}
        >
          {#snippet chart()}
            {@const d = i.responses.outcomes.data!}
            <SegBar
              label="What happened first"
              parts={OUTCOMES.map((o): Part => ({
                key: o,
                label: OUTCOME_LABEL[o],
                n: d.counts[o],
                color: OUTCOME_COLOR[o],
                ink: o === 'snoozed' || o === 'legacy' ? 'dark' : 'light',
              }))}
            />
          {/snippet}
          {#snippet table()}
            {@const d = i.responses.outcomes.data!}
            {@const total = OUTCOMES.reduce((a, o) => a + d.counts[o], 0)}
            <table class="itable">
              <thead><tr><th>First thing that happened</th><th class="num">n</th><th class="num">Share</th></tr></thead>
              <tbody>
                {#each OUTCOMES as o (o)}
                  <tr>
                    <td>{OUTCOME_LABEL[o]}</td><td class="num">{d.counts[o]}</td><td class="num">
                      {pct(d.counts[o] / Math.max(1, total))}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          {/snippet}
        </Card>

        <Card
          id="reply-by-source"
          title="Reply rate by source"
          card={i.responses.replyBySource}
          caption={captions.replyBySource(i)}
          note="Of the things you resolved yourself, one at a time."
        >
          {#snippet chart()}
            <MeterList
              label="Reply rate by source"
              min={i.responses.replyBySource.data!.rowMin}
              rows={rateMeters(i.responses.replyBySource.data!.rows, (r) => kindLabel(r.provider, r.kind))}
            />
          {/snippet}
        </Card>

        <Card
          id="reply-by-size"
          title="Reply rate by thread size"
          card={i.responses.replyBySize}
          caption={captions.replyBySize(i)}
          note={i.responses.replyBySize.data?.approx
            ? `${i.responses.replyBySize.data.approx} of these use today's thread size: the size when you acted is recorded from now on.`
            : 'Thread size when you acted.'}
        >
          {#snippet chart()}
            <MeterList
              label="Reply rate by thread size"
              min={i.responses.replyBySize.data!.rowMin}
              rows={rateMeters(i.responses.replyBySize.data!.rows, (r) => SIZE_BAND_LABEL[r.band])}
            />
          {/snippet}
        </Card>

        <Card
          id="age-when-answered"
          title="Age when dealt with"
          card={i.responses.ageWhenAnswered}
          caption={captions.ageWhenAnswered(i)}
          note="Dot: median. Bar: the middle half. Time since Nudge first saw it."
        >
          {#snippet chart()}
            {@const d = i.responses.ageWhenAnswered.data!}
            <RangeBars
              label="Age when dealt with"
              min={d.rowMin}
              rows={d.rows.map((r) => ({
                key: r.outcome,
                label: OUTCOME_LABEL[r.outcome],
                n: r.n,
                p25: r.p25Ms,
                median: r.medianMs,
                p75: r.p75Ms,
              }))}
            />
          {/snippet}
          {#snippet table()}
            <table class="itable">
              <thead>
                <tr>
                  <th>How</th><th class="num">n</th><th class="num">p25</th><th class="num">Median</th><th class="num">
                    p75
                  </th>
                </tr>
              </thead>
              <tbody>
                {#each i.responses.ageWhenAnswered.data!.rows as r (r.outcome)}
                  <tr>
                    <td>{OUTCOME_LABEL[r.outcome]}</td><td class="num">{r.n}</td><td class="num">
                      {shortDuration(r.p25Ms)}
                    </td><td class="num">{shortDuration(r.medianMs)}</td><td class="num">{shortDuration(r.p75Ms)}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          {/snippet}
        </Card>

        <Card
          id="snoozes"
          title="Snooze habits"
          card={i.responses.snoozes}
          caption={captions.snoozes(i)}
          note="Share of each kind of snooze that woke because something happened."
        >
          {#snippet chart()}
            <MeterList
              label="Snoozes that woke on activity, by reason"
              rows={i.responses.snoozes.data!.rows.map((r) => {
                const ended = r.activity + r.fallback + r.manual + r.timed;
                return {
                  key: r.bucket,
                  label: bucketLabel(r.bucket),
                  value: ended ? r.activity / ended : 0,
                  text: ended ? pct(r.activity / ended) : '–',
                  n: r.n,
                };
              })}
            />
          {/snippet}
          {#snippet table()}
            <div class="tablewrap">
              <table class="itable">
                <thead>
                  <tr>
                    <th>Reason</th><th class="num">n</th><th class="num">Activity</th><th class="num">Fallback</th><th
                      class="num"
                    >
                      By hand
                    </th><th class="num">Timed</th><th class="num">Still</th><th class="num">Median</th>
                  </tr>
                </thead>
                <tbody>
                  {#each i.responses.snoozes.data!.rows as r (r.bucket)}
                    <tr>
                      <td>{bucketLabel(r.bucket)}</td><td class="num">{r.n}</td><td class="num">{r.activity}</td><td
                        class="num"
                      >
                        {r.fallback}
                      </td><td class="num">{r.manual}</td><td class="num">{r.timed}</td><td class="num">{r.open}</td><td
                        class="num"
                      >
                        {shortDuration(r.medianMs)}
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {/snippet}
        </Card>

        <Card id="undos" title="Undo corner" card={i.responses.undos} caption={captions.undos(i)}>
          {#snippet chart()}
            {@const d = i.responses.undos.data!}
            <StatTile value={String(d.undos)} sub="undos, out of {d.actions} actions" />
          {/snippet}
        </Card>
      </div>
    {/if}

    <!-- Predictions -->
    <h3 class="group">Predictions</h3>
    {#if groupEmpty(i.predictions)}
      <p class="meta muted collapsed" data-testid="group-empty-predictions">
        Predictions: not enough data yet ({i.predictions.agreement.n} of {i.predictions.agreement.min} suggestions judged).
      </p>
    {:else}
      <div class="cards">
        <Card
          id="agreement"
          title="How often the robot was right"
          card={i.predictions.agreement}
          caption={captions.agreement(i)}
          note={[
            'Judged against the first thing you did, one at a time.',
            i.predictions.agreement.data?.ambiguous
              ? `${i.predictions.agreement.data.ambiguous} old “done”s can't be judged.`
              : '',
            i.predictions.agreement.data?.bulk ? `${i.predictions.agreement.data.bulk} bulk-actioned left out.` : '',
          ]
            .filter(Boolean)
            .join(' ')}
        >
          {#snippet chart()}
            {@const d = i.predictions.agreement.data!}
            <StatTile value={pct(d.hits / Math.max(1, d.total))} sub="{d.hits} of {d.total} agreed" />
          {/snippet}
        </Card>

        <Card
          id="by-suggestion"
          title="By suggestion"
          card={i.predictions.bySuggestion}
          caption="How often each kind of suggestion matched what you did."
        >
          {#snippet chart()}
            <MeterList
              label="Agreement by suggestion"
              min={i.predictions.bySuggestion.data!.rowMin}
              rows={rateMeters(
                i.predictions.bySuggestion.data!.rows,
                (r) => SUGGESTED_LABEL[r.suggested] ?? r.suggested,
              )}
            />
          {/snippet}
        </Card>

        <Card
          id="calibration"
          title="Calibration"
          card={i.predictions.calibration}
          caption={captions.calibration(i)}
          note={i.predictions.calibration.data?.highNotBetter
            ? 'High confidence agreed no more often than medium.'
            : null}
        >
          {#snippet chart()}
            <MeterList
              label="Agreement by confidence"
              min={i.predictions.calibration.data!.rowMin}
              rows={rateMeters(
                i.predictions.calibration.data!.rows,
                (r) => r.confidence[0]!.toUpperCase() + r.confidence.slice(1),
              )}
            />
          {/snippet}
        </Card>

        <Card
          id="confusion"
          title="Where it trips"
          card={i.predictions.confusion}
          caption={captions.confusion(i, SUGGESTED, FIRST_ACTIONS)}
        >
          {#snippet chart()}
            {@const cells = i.predictions.confusion.data!.cells}
            {@const max = Math.max(1, ...cells.flat())}
            <div class="tablewrap">
              <table class="itable confusion" aria-label="Suggested against what you did first">
                <thead>
                  <tr>
                    <th>Said / did</th>{#each FIRST_ACTIONS as a (a)}<th class="num">{ACTION_LABEL[a]}</th>{/each}
                  </tr>
                </thead>
                <tbody>
                  {#each SUGGESTED as s, si (s)}
                    <tr>
                      <th>{SUGGESTED_LABEL[s]}</th>
                      {#each cells[si]! as n, ai (ai)}
                        <td class="num heat l{heatLevel(n, max)}" class:ink={heatLevel(n, max) >= 4}>{n}</td>
                      {/each}
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {/snippet}
        </Card>

        <Card
          id="categories"
          title="Overridden categories"
          card={i.predictions.categories}
          caption={captions.categories(i)}
          note={(() => {
            const d = i.predictions.categories.data;
            const approx = d?.rows.reduce((a, r) => a + r.approx, 0) ?? 0;
            const since = d?.capturedSince
              ? `Recorded with each action since ${dayLabel(d.capturedSince.slice(0, 10))}.`
              : '';
            return [since, approx ? `${approx} use today's category (approx.).` : ''].filter(Boolean).join(' ') || null;
          })()}
        >
          {#snippet chart()}
            {@const d = i.predictions.categories.data!}
            <MeterList
              label="How often you overrule each category"
              min={d.rowMin}
              rows={d.rows.map((r) => ({
                key: r.category,
                label: r.approx ? `${r.category} (approx.)` : r.category,
                value: r.rate,
                text: pct(r.rate),
                n: r.n,
              }))}
            />
          {/snippet}
        </Card>

        <Card
          id="turns"
          title="Whose turn"
          card={i.predictions.turns}
          caption={captions.turns(i)}
          note="How often you replied, by whose turn the robot said it was."
        >
          {#snippet chart()}
            <MeterList
              label="Reply rate by whose turn"
              min={i.predictions.turns.data!.rowMin}
              rows={rateMeters(i.predictions.turns.data!.rows, (r) => TURN_LABEL[r.turn] ?? r.turn)}
            />
          {/snippet}
        </Card>
      </div>
    {/if}

    <!-- Sources -->
    <h3 class="group">Sources</h3>
    {#if groupEmpty(i.sources)}
      <p class="meta muted collapsed" data-testid="group-empty-sources">Sources: not enough data yet.</p>
    {:else}
      <div class="cards">
        <Card id="repos" title="Noisiest repos" card={i.sources.repos} caption={captions.repos(i)}>
          {#snippet chart()}
            <RankedBars
              label="Arrivals by repository"
              rows={i.sources.repos.data!.rows.map((r) => ({ key: r.label, ...r }))}
              other={i.sources.repos.data!.other}
            />
          {/snippet}
        </Card>
        <Card id="videos" title="Chattiest videos" card={i.sources.videos} caption={captions.videos(i)}>
          {#snippet chart()}
            <RankedBars
              label="Arrivals by video"
              rows={i.sources.videos.data!.rows.map((r) => ({ key: r.label, ...r }))}
              other={i.sources.videos.data!.other}
            />
          {/snippet}
        </Card>
        <Card id="channels" title="Channels" card={i.sources.channels} caption={captions.channels(i)}>
          {#snippet chart()}
            <RankedBars
              label="Arrivals by channel"
              rows={i.sources.channels.data!.rows.map((r) => ({ key: r.label, ...r }))}
            />
          {/snippet}
        </Card>
        <Card
          id="regulars"
          title="Regulars"
          card={i.sources.regulars}
          caption={captions.regulars(i)}
          note="People with three or more things in this range; you and bots left out."
        >
          {#snippet chart()}
            <RankedBars
              label="Most things written, by person"
              rows={i.sources.regulars.data!.rows.map((r) => ({ key: r.label, ...r }))}
            />
          {/snippet}
        </Card>
        <Card
          id="threads"
          title="Longest threads"
          card={i.sources.threads}
          caption={captions.threads(i)}
          note="Comment counts as they are now."
        >
          {#snippet chart()}
            <RankedBars
              label="Biggest conversations"
              rows={i.sources.threads.data!.rows.map((r): Ranked => ({
                key: r.itemId,
                label: r.label,
                n: r.size,
                href: itemHref(r.itemId),
                onopen: () => open(r.itemId),
              }))}
            />
          {/snippet}
        </Card>
        <Card id="mix" title="What it's made of" card={i.sources.mix} caption={captions.mix(i)}>
          {#snippet chart()}
            <SegBar
              label="Arrivals by kind"
              parts={i.sources.mix.data!.parts.map((p, k): Part => ({
                key: `${p.provider}-${p.kind}`,
                label: kindLabel(p.provider, p.kind),
                n: p.n,
                color: p.provider === 'other' ? 'var(--viz-legacy)' : CATEGORICAL[k]!,
                ink: k === 3 || p.provider === 'other' ? 'dark' : 'light',
              }))}
            />
          {/snippet}
        </Card>
      </div>
    {/if}

    <!-- Backlog -->
    <h3 class="group">Backlog <span class="meta muted">right now</span></h3>
    {#if groupEmpty(i.backlog)}
      <p class="meta muted collapsed" data-testid="group-empty-backlog">Backlog: nothing waiting. Lovely.</p>
    {:else}
      <div class="cards">
        <Card
          id="inbox-age"
          title="Inbox by age"
          card={i.backlog.inboxAge}
          caption={captions.inboxAge(i)}
          note="Age since it arrived, or last came back."
        >
          {#snippet chart()}
            <RankedBars
              label="Inbox by age"
              rows={i.backlog.inboxAge.data!.bands.map((b) => ({ key: b.band, label: AGE_BAND_LABEL[b.band], n: b.n }))}
            />
          {/snippet}
        </Card>
        <Card id="elder" title="The elder" card={i.backlog.elder} caption={captions.elder(i)}>
          {#snippet chart()}
            {@const d = i.backlog.elder.data!}
            <StatTile
              value={shortDuration(d.ageMs)}
              sub="waiting since {dayLabel(d.since.slice(0, 10))}"
              href={itemHref(d.itemId)}
              linkText={d.label}
              onopen={() => open(d.itemId)}
            />
          {/snippet}
        </Card>
        <Card id="snoozed-now" title="Snoozed now" card={i.backlog.snoozedNow} caption={captions.snoozedNow(i)}>
          {#snippet chart()}
            <RankedBars
              label="Snoozed now, by reason"
              rows={i.backlog.snoozedNow.data!.rows.map((r) => ({
                key: r.bucket,
                label: bucketLabel(r.bucket),
                n: r.n,
              }))}
            />
          {/snippet}
          {#snippet table()}
            <table class="itable">
              <thead><tr><th>Reason</th><th class="num">n</th><th class="num">Median days parked</th></tr></thead>
              <tbody>
                {#each i.backlog.snoozedNow.data!.rows as r (r.bucket)}
                  <tr>
                    <td>{bucketLabel(r.bucket)}</td><td class="num">{r.n}</td><td class="num">
                      {r.medianDays === null ? '–' : r.medianDays.toFixed(1)}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          {/snippet}
        </Card>
        <Card
          id="over-time"
          title="Backlog over time"
          card={i.backlog.overTime}
          caption={captions.overTime(i)}
          wide
          note="Replayed from the history: what the inbox held at the end of each day."
        >
          {#snippet chart()}
            <LineChart points={i.backlog.overTime.data!.days} unit="in the inbox" label="Inbox count by day" />
          {/snippet}
          {#snippet table()}
            <div class="tablewrap">
              <table class="itable">
                <thead><tr><th>Day</th><th class="num">In the inbox</th></tr></thead>
                <tbody>
                  {#each i.backlog.overTime.data!.days as d (d.day)}
                    <tr><td>{dayLabel(d.day)}</td><td class="num">{d.count}</td></tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {/snippet}
        </Card>
      </div>
    {/if}

    <!-- Fun extras -->
    <h3 class="group">Odds and ends</h3>
    {#if groupEmpty(i.extras)}
      <p class="meta muted collapsed" data-testid="group-empty-extras">Odds and ends: nothing yet.</p>
    {:else}
      <div class="cards">
        <Card id="busiest-day" title="Busiest day" card={i.extras.busiestDay} caption={captions.busiestDay(i)}>
          {#snippet chart()}
            {@const d = i.extras.busiestDay.data!}
            <StatTile value={String(d.actions)} sub="actions on {dayLabel(d.day)}" />
          {/snippet}
        </Card>
        <Card id="quietest-hour" title="Quietest hour" card={i.extras.quietestHour} caption={captions.quietestHour(i)}>
          {#snippet chart()}
            {@const d = i.extras.quietestHour.data!}
            <StatTile value={hourLabel(d.hour)} sub="{perDayLabel(d.perDay)} arrivals a day in that hour" />
          {/snippet}
        </Card>
        <Card
          id="biggest-cleared"
          title="Biggest thread cleared"
          card={i.extras.biggestCleared}
          caption={captions.biggestCleared(i)}
        >
          {#snippet chart()}
            {@const d = i.extras.biggestCleared.data!}
            <StatTile
              value={String(d.size)}
              sub="comments"
              href={itemHref(d.itemId)}
              linkText={d.label}
              onopen={() => open(d.itemId)}
            />
          {/snippet}
        </Card>
        <Card id="polyglot" title="Polyglot days" card={i.extras.polyglot} caption={captions.polyglot(i)}>
          {#snippet chart()}
            {@const d = i.extras.polyglot.data!}
            <StatTile value={String(d.days)} sub={d.last ? `most recently ${dayLabel(d.last)}` : 'not yet'} />
          {/snippet}
        </Card>
      </div>
    {/if}
  {/if}
</section>

<style>
  .insights {
    display: flex;
    flex-direction: column;
    gap: var(--s3);
    transition: opacity var(--dur) var(--ease);
  }
  /* Refetch keeps the frame: the previous numbers stay, dimmed, until the new ones arrive. */
  .stale {
    opacity: 0.6;
  }
  .head {
    display: flex;
    align-items: center;
    gap: var(--s2);
    flex-wrap: wrap;
  }
  h2 {
    font-size: 16px;
    font-weight: 600;
    letter-spacing: -0.02em;
  }
  .grow {
    flex: 1;
  }
  .seg {
    display: flex;
    gap: var(--s1);
  }
  .sentence {
    font-size: 15px;
    line-height: 1.45;
    color: var(--text);
  }
  .scope {
    margin-top: calc(-1 * var(--s2));
  }
  .group {
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
    margin-top: var(--s2);
  }
  .group .meta {
    text-transform: none;
    letter-spacing: 0;
    font-weight: 400;
  }
  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(300px, 100%), 1fr));
    gap: var(--s3);
  }
  .collapsed {
    font-size: 13px;
  }
  .gap {
    height: var(--s3);
  }
  .confusion td.heat {
    border-radius: 2px;
    border: 2px solid var(--bg-elev);
  }
  .confusion .l0 {
    background: var(--viz-empty);
  }
  .confusion .l1 {
    background: var(--viz-seq-1);
  }
  .confusion .l2 {
    background: var(--viz-seq-2);
  }
  .confusion .l3 {
    background: var(--viz-seq-3);
  }
  .confusion .l4 {
    background: var(--viz-seq-4);
  }
  .confusion .l5 {
    background: var(--viz-seq-5);
  }
  .confusion .l6 {
    background: var(--viz-seq-6);
  }
  .confusion .l7 {
    background: var(--viz-seq-7);
  }
  /* Light text on the darker half of the ramp in light mode; the dark ramp brightens instead, so dark text there. */
  :global(:root[data-theme='light']) .confusion .ink,
  :global(:root:not([data-theme])) .confusion .ink {
    color: #ffffff;
  }
  :global(:root[data-theme='dark']) .confusion .ink {
    color: #0b0b0b;
  }
  .failed {
    color: var(--danger);
    margin: 0 0 8px;
  }
</style>
