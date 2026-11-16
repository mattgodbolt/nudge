import { describe, expect, it } from 'vitest';
import { htmlToPlain } from './text.js';

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
