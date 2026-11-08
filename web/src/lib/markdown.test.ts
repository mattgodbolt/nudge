import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './sanitize';

describe('renderMarkdown', () => {
  it('renders the usual markdown', () => {
    const html = renderMarkdown('# Title\n\nSome **bold** and `code`.\n\n- one\n- two\n\n```\nlet x = 1;\n```');
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('<li>one</li>');
    expect(html).toContain('<pre><code>let x = 1;');
  });

  it('renders a Dependabot-style body as formatted text, not as visible tags', () => {
    const body = [
      'Bumps [flatted](https://github.com/WebReflection/flatted) from 3.4.1 to 3.4.2.',
      '<details>',
      '<summary>Commits</summary>',
      '<ul>',
      '<li><a href="https://github.com/x/commit/abc"><code>3bf0909</code></a> 3.4.2</li>',
      '</ul>',
      '</details>',
      '<br />',
      '',
      '[![Dependabot compatibility score](https://dependabot-badges.githubapp.com/badges/x.svg)](https://docs.github.com/y)',
      '',
      '[//]: # (dependabot-automerge-start)',
    ].join('\n');
    const html = renderMarkdown(body);
    expect(html).toContain('<details>');
    expect(html).toContain('<summary>Commits</summary>');
    expect(html).toContain('href="https://github.com/WebReflection/flatted"');
    expect(html).not.toContain('&lt;details'); // not shown as literal text
    expect(html).not.toContain('<img');
    expect(html).toContain('Dependabot compatibility score'); // the badge survives as its alt text
    expect(html).not.toContain('automerge'); // link-reference comments are not content
  });

  it('opens links in a new tab without leaking the opener', () => {
    const html = renderMarkdown('[x](https://example.com/a)');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('never lets markup run: scripts, handlers, javascript: links, styles and iframes are gone', () => {
    const html = renderMarkdown(
      [
        '<script>alert(1)</script>',
        '<img src=x onerror="alert(2)">',
        '[click](javascript:alert(3))',
        '<a href="javascript:alert(4)" onclick="alert(5)">a</a>',
        '<div style="position:fixed" onmouseover="alert(6)">d</div>',
        '<iframe src="https://evil.example"></iframe>',
        '![tracker](https://evil.example/pixel.gif)',
      ].join('\n\n'),
    );
    for (const bad of [
      '<script',
      'onerror',
      'javascript:',
      'onclick',
      'onmouseover',
      'style=',
      '<iframe',
      '<img',
      'src=',
    ]) {
      expect(html.toLowerCase()).not.toContain(bad);
    }
    expect(html).toContain('tracker'); // as a link, not an image
  });

  it('copes with empty and truncated input', () => {
    expect(renderMarkdown('')).toBe('');
    expect(() => renderMarkdown('<details><summary>cut off mid-')).not.toThrow();
    expect(() => renderMarkdown('**unclosed bold and a [link](https://x')).not.toThrow();
  });
});
