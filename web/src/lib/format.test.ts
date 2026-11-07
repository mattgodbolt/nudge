import { describe, expect, it } from 'vitest';
import { formatDuration } from './format';

describe('formatDuration', () => {
  it.each([
    [0, '0m'],
    [90, '2m'],
    [3600, '1h 0m'],
    [3723, '1h 2m'],
    [93_600, '1d 2h 0m'],
    [12 * 86400 + 4 * 3600 + 31 * 60, '12d 4h 31m'],
  ])('%s s -> %s', (s, out) => expect(formatDuration(s)).toBe(out));
});
