const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/**
 * Remove every `open`…`close` span, matching the first `close` after each `open`, exactly as the regex
 * /open[\s\S]*?close/g would. Done by hand because that regex rescans to the end of the input for every
 * unclosed opener, which is quadratic on hostile text ('<!--'.repeat(n) took seconds at 256 KB).
 */
export function stripBetween(s: string, open: string, close: string): string {
  let out = '';
  let from = 0;
  for (;;) {
    const start = s.indexOf(open, from);
    if (start < 0) break;
    const end = s.indexOf(close, start + open.length);
    // No closer after this opener means none after any later opener either: the regex stops matching here too.
    if (end < 0) break;
    out += s.slice(from, start);
    from = end + close.length;
  }
  return out + s.slice(from);
}

/**
 * Derive plain text from YouTube's textFormat=html. We never rely on textOriginal
 * (only guaranteed for the comment's author). Tags are stripped before entities are
 * decoded so that an escaped "&lt;b&gt;" survives as literal text.
 */
export function htmlToPlain(html: string): string {
  return decodeEntities(stripBetween(html.replace(/<br\s*\/?>/gi, '\n'), '<', '>'));
}
