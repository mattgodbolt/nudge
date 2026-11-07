import { describe, expect, it } from 'vitest';
import { parseGoogleClientJson } from './google-client.js';

const ID = '123-abc.apps.googleusercontent.com';

describe('parseGoogleClientJson', () => {
  it.each([
    ['installed', JSON.stringify({ installed: { client_id: ID, client_secret: 'S', project_id: 'p' } })],
    ['web', JSON.stringify({ web: { client_id: ID, client_secret: 'S' } })],
    ['flat snake', JSON.stringify({ client_id: ID, client_secret: 'S' })],
    ['flat camel', JSON.stringify({ clientId: ` ${ID} `, clientSecret: ' S ' })],
  ])('parses %s', (_n, text) => {
    expect(parseGoogleClientJson(text)).toEqual({ clientId: ID, clientSecret: 'S' });
  });

  it.each([
    ['not json', 'nope'],
    ['array', '[]'],
    ['null', 'null'],
    ['missing secret', JSON.stringify({ installed: { client_id: ID } })],
    ['empty secret', JSON.stringify({ installed: { client_id: ID, client_secret: ' ' } })],
    ['non-google id', JSON.stringify({ installed: { client_id: 'abc', client_secret: 'S' } })],
  ])('rejects %s', (_n, text) => {
    expect(parseGoogleClientJson(text)).toBeNull();
  });
});
