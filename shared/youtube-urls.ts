import type { SourceKind } from './types.js';

export interface ParsedSource {
  kind: SourceKind;
  /** Video id, playlist id, channel id (UC...) or handle (@name). */
  ytId: string;
}

export function permalink(videoId: string, commentId: string): string {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&lc=${encodeURIComponent(commentId)}`;
}

const VIDEO_ID = /^[\w-]{11}$/;
const PLAYLIST_ID = /^(PL|UU|OL|FL|LL|RD)[\w-]{10,}$/;
const CHANNEL_ID = /^UC[\w-]{22}$/;
const HANDLE = /^@[\w.-]{3,}$/;

/** Interpret whatever the user pasted: URL, bare id or @handle. A watch URL carrying list= resolves to the playlist. */
export function parseSourceInput(raw: string): ParsedSource | null {
  const input = raw.trim();
  if (!input) return null;
  if (CHANNEL_ID.test(input)) return { kind: 'channel', ytId: input };
  if (HANDLE.test(input)) return { kind: 'channel', ytId: input };
  if (PLAYLIST_ID.test(input)) return { kind: 'playlist', ytId: input };
  if (VIDEO_ID.test(input)) return { kind: 'video', ytId: input };

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www|m|music)\./, '');
  if (host !== 'youtube.com' && host !== 'youtu.be') return null;

  const list = url.searchParams.get('list');
  if (list && PLAYLIST_ID.test(list)) return { kind: 'playlist', ytId: list };

  const parts = url.pathname.split('/').filter(Boolean);
  if (host === 'youtu.be') {
    return parts[0] && VIDEO_ID.test(parts[0]) ? { kind: 'video', ytId: parts[0] } : null;
  }
  const v = url.searchParams.get('v');
  if (parts[0] === 'watch' && v && VIDEO_ID.test(v)) return { kind: 'video', ytId: v };
  if ((parts[0] === 'shorts' || parts[0] === 'live' || parts[0] === 'embed') && parts[1] && VIDEO_ID.test(parts[1])) {
    return { kind: 'video', ytId: parts[1] };
  }
  if (parts[0] === 'channel' && parts[1] && CHANNEL_ID.test(parts[1])) return { kind: 'channel', ytId: parts[1] };
  if (parts[0]?.startsWith('@') && HANDLE.test(parts[0])) return { kind: 'channel', ytId: parts[0] };
  return null;
}
