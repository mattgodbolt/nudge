import { describe, expect, it, vi } from 'vitest';
import { deviceLabel, openFromNotification, pushSupported, urlBase64ToUint8Array } from './push';

describe('pushSupported', () => {
  const ok = { isSecureContext: true, PushManager: class {}, Notification: class {} };
  it('needs a secure context, a service worker, PushManager and Notification', () => {
    expect(pushSupported(ok, { serviceWorker: {} })).toBe(true);
    expect(pushSupported({ ...ok, isSecureContext: false }, { serviceWorker: {} })).toBe(false);
    expect(pushSupported(ok, {})).toBe(false);
    expect(pushSupported({ ...ok, PushManager: undefined }, { serviceWorker: {} })).toBe(false);
    expect(pushSupported({ ...ok, Notification: undefined }, { serviceWorker: {} })).toBe(false);
  });
});

describe('urlBase64ToUint8Array', () => {
  it('decodes unpadded base64url, including - and _', () => {
    // 0xfb 0xff 0xfe -> "-__-" in base64url ("+//+" in base64)
    expect([...urlBase64ToUint8Array('-__-')]).toEqual([0xfb, 0xff, 0xfe]);
    expect([...urlBase64ToUint8Array('AQID')]).toEqual([1, 2, 3]);
    expect([...urlBase64ToUint8Array('AQI')]).toEqual([1, 2]);
  });
  it('decodes a real 65-byte VAPID key to 65 bytes starting 0x04', () => {
    const key = 'BEl62iUYgUivxIkv69yViEuiBIa-ib37gb7yX3S2cTDHGSsfsxkdeaH_HGLmaFE-dVE3KFaWOMOpGbkdSa0V9fk';
    const bytes = urlBase64ToUint8Array(key);
    expect(bytes).toHaveLength(65);
    expect(bytes[0]).toBe(4);
  });
});

describe('deviceLabel', () => {
  it.each([
    [
      'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP1A) AppleWebKit/537.36 Chrome/126.0.0.0 Mobile Safari/537.36',
      'Chrome on Pixel 8',
    ],
    ['Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36', 'Chrome on Android'],
    ['Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36', 'Chrome on Linux'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0', 'Firefox on Windows'],
    ['something odd', 'Browser'],
  ])('%s', (ua, label) => expect(deviceLabel(ua)).toBe(label));
});

describe('openFromNotification', () => {
  it('routes a local path with its query', () => {
    const nav = vi.fn();
    expect(openFromNotification('/inbox?c=abc', nav)).toBe(true);
    expect(nav).toHaveBeenCalledWith({ route: 'inbox', params: {}, query: { c: 'abc' } });
  });
  it.each([['https://evil.example/'], ['//evil.example'], [42], [undefined], ['inbox']])('ignores %s', (u) => {
    const nav = vi.fn();
    expect(openFromNotification(u, nav)).toBe(false);
    expect(nav).not.toHaveBeenCalled();
  });
});
