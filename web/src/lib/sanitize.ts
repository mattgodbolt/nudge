import DOMPurify from 'dompurify';
import { Marked } from 'marked';

let hooked = false;

function ensureHook(): void {
  if (hooked) return;
  hooked = true;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });
}

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Images never load: a pull request body full of badges and tracking pixels would otherwise make the browser fetch
// them (leaking that you looked, and from where). The alt text becomes a plain link instead.
const markdown = new Marked({
  gfm: true,
  renderer: {
    image({ href, text }) {
      return text && /^https?:/i.test(href) ? `<a href="${esc(href)}">${esc(text)}</a>` : esc(text ?? '');
    },
  },
});

/** The only place comment HTML is made safe for {@html}. */
export function sanitizeCommentHtml(html: string): string {
  ensureHook();
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['a', 'br', 'b', 'i', 's', 'span', 'strong', 'em'],
    ALLOWED_ATTR: ['href'],
    ALLOWED_URI_REGEXP: /^https?:/i,
  });
}

/**
 * GitHub-flavoured markdown (which may embed HTML, as Dependabot's do) rendered for display. Everything goes through
 * the same gate as comments: a small tag allow-list, links only to http(s), no images, no styles, no scripts.
 */
export function renderMarkdown(src: string): string {
  ensureHook();
  const html = markdown.parse(src, { async: false });
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      'a',
      'b',
      'i',
      's',
      'em',
      'strong',
      'del',
      'code',
      'pre',
      'br',
      'hr',
      'p',
      'span',
      'blockquote',
      'ul',
      'ol',
      'li',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'details',
      'summary',
      'table',
      'thead',
      'tbody',
      'tr',
      'th',
      'td',
      'sub',
      'sup',
      'kbd',
    ],
    ALLOWED_ATTR: ['href'],
    ALLOWED_URI_REGEXP: /^https?:/i,
  });
}
