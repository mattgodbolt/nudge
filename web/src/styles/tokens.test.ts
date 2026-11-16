import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Faint text carries real content (timestamps, snooze times, counts, hints), so it must still be readable: WCAG AA,
// 4.5:1, against every background it sits on.
const css = readFileSync(resolve(__dirname, 'tokens.css'), 'utf8');
const block = (selector: string) => css.slice(css.indexOf(selector), css.indexOf('}', css.indexOf(selector)));
const token = (b: string, name: string) => b.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i'))![1]!;

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

describe.each([
  ['light', ":root[data-theme='light']"],
  ['dark', ":root[data-theme='dark']"],
])('%s theme', (_name, selector) => {
  const b = block(selector);
  it.each(['bg', 'bg-elev', 'bg-hover', 'bg-selected'])('faint text is readable on --%s', (bg) => {
    expect(contrast(token(b, 'text-faint'), token(b, bg))).toBeGreaterThanOrEqual(4.5);
  });
});
