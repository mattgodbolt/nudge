import DOMPurify from 'dompurify';

let hooked = false;

/** The only place comment HTML is made safe for {@html}. */
export function sanitizeCommentHtml(html: string): string {
  if (!hooked) {
    hooked = true;
    DOMPurify.addHook('afterSanitizeAttributes', (node) => {
      if (node.tagName === 'A') {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      }
    });
  }
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['a', 'br', 'b', 'i', 's', 'span', 'strong', 'em'],
    ALLOWED_ATTR: ['href'],
    ALLOWED_URI_REGEXP: /^https?:/i,
  });
}
