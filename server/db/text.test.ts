import { describe, expect, it } from 'vitest';
import { htmlToPlain } from './text.js';
import { tierFor, tierInfo, unitsPerDay } from './tiers-lite.js';

describe('htmlToPlain', () => {
  it('turns br into newlines and strips tags', () => {
    expect(htmlToPlain('a<br>b<br />c<BR/>d')).toBe('a\nb\nc\nd');
    expect(htmlToPlain('see <a href="https://x.y/?a=1&amp;b=2">https://x.y/?a=1&amp;b=2</a> now')).toBe(
      'see https://x.y/?a=1&b=2 now',
    );
    expect(htmlToPlain('<b>bold</b> <i>it</i>')).toBe('bold it');
  });
  it('decodes named and numeric entities', () => {
    expect(htmlToPlain('Tom &amp; Jerry &lt;3 &quot;hi&quot; it&#39;s &#x1F600; &apos;x&apos; &nbsp;')).toBe(
      "Tom & Jerry <3 \"hi\" it's \u{1F600} 'x'  ",
    );
  });
  it('keeps escaped markup as literal text and leaves unknown entities alone', () => {
    expect(htmlToPlain('&lt;b&gt;not bold&lt;/b&gt;')).toBe('<b>not bold</b>');
    expect(htmlToPlain('&bogus; &#99999999;')).toBe('&bogus; &#99999999;');
  });
  it('handles empty input and emoji', () => {
    expect(htmlToPlain('')).toBe('');
    expect(htmlToPlain('great 🎉')).toBe('great 🎉');
  });
});

describe('tiers-lite', () => {
  const now = new Date('2025-06-01T00:00:00Z');
  const ago = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
  it('maps age to tier and interval', () => {
    expect(tierFor(ago(1), null, now)).toMatchObject({ tier: 'hot', intervalMin: 10, deepEveryMin: 360 });
    expect(tierFor(ago(2.9), null, now).tier).toBe('hot');
    expect(tierFor(ago(3), null, now)).toMatchObject({ tier: 'warm', intervalMin: 60 });
    expect(tierFor(ago(30), null, now)).toMatchObject({ tier: 'cold', intervalMin: 720 });
    expect(tierFor(ago(365), null, now)).toMatchObject({ tier: 'frozen', intervalMin: 2880 });
  });
  it('override wins and paused does not poll', () => {
    expect(tierFor(ago(1), 'frozen', now).tier).toBe('frozen');
    const p = tierFor(ago(1), 'paused', now);
    expect(p.intervalMin).toBeNull();
    expect(unitsPerDay(p)).toBe(0);
    expect(unitsPerDay(tierInfo('hot'))).toBe(144);
  });
  it('treats unknown publish date as warm', () => {
    expect(tierFor(null, null, now).tier).toBe('warm');
  });
});
