import { describe, expect, it } from 'vitest';
import { parseSourceInput, permalink } from './youtube-urls.js';

describe('parseSourceInput', () => {
  const cases: [string, unknown][] = [
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', { kind: 'video', ytId: 'dQw4w9WgXcQ' }],
    ['youtu.be/dQw4w9WgXcQ?t=3', { kind: 'video', ytId: 'dQw4w9WgXcQ' }],
    ['https://youtube.com/shorts/dQw4w9WgXcQ', { kind: 'video', ytId: 'dQw4w9WgXcQ' }],
    ['dQw4w9WgXcQ', { kind: 'video', ytId: 'dQw4w9WgXcQ' }],
    [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLzH6n4zXuckpwdGMHgRH5N9xNHzVGCxwf',
      { kind: 'playlist', ytId: 'PLzH6n4zXuckpwdGMHgRH5N9xNHzVGCxwf' },
    ],
    ['PLzH6n4zXuckpwdGMHgRH5N9xNHzVGCxwf', { kind: 'playlist', ytId: 'PLzH6n4zXuckpwdGMHgRH5N9xNHzVGCxwf' }],
    ['UC0123456789abcdefFAKEid', { kind: 'channel', ytId: 'UC0123456789abcdefFAKEid' }],
    ['https://www.youtube.com/channel/UC0123456789abcdefFAKEid', { kind: 'channel', ytId: 'UC0123456789abcdefFAKEid' }],
    ['https://www.youtube.com/@example-channel', { kind: 'channel', ytId: '@example-channel' }],
    ['@example-channel', { kind: 'channel', ytId: '@example-channel' }],
    ['https://example.com/watch?v=dQw4w9WgXcQ', null],
    ['', null],
    ['hello world', null],
  ];
  it.each(cases)('%s', (input, expected) => expect(parseSourceInput(input)).toEqual(expected));
});

describe('permalink', () => {
  it('builds a comment deep link', () => {
    expect(permalink('abc', 'Ugx1')).toBe('https://www.youtube.com/watch?v=abc&lc=Ugx1');
  });
});
