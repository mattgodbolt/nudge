import { describe, expect, it } from 'vitest';
import { ownerProfileWarning } from './startup.js';
import { openDb } from './db/db.js';
import { createRepo } from './db/repo.js';
import { DEMO_OWNER, seedDemoOwner } from './demo/seed.js';

const llm = (apiKey: string | null) => ({ apiKey, model: 'claude-haiku-5-5' });

describe('the startup warning about Settings > About you', () => {
  it('is logged only when a key is set and the profile is incomplete', () => {
    const empty = { name: '', about: '' };
    expect(ownerProfileWarning({ llm: llm('sk'), owner: empty })).toMatch(/About you is empty.*paused/);
    expect(ownerProfileWarning({ llm: llm('sk'), owner: { name: 'Priya', about: ' ' } })).not.toBeNull();
    expect(ownerProfileWarning({ llm: llm('sk'), owner: { name: 'Priya', about: 'Maintains a parser.' } })).toBeNull();
    // No key: nothing would call the model anyway.
    expect(ownerProfileWarning({ llm: llm(null), owner: empty })).toBeNull();
  });
});

describe('the demo owner', () => {
  it('is seeded into a demo database with no profile, and never over one that was typed in', () => {
    const repo = createRepo(openDb(':memory:'));
    seedDemoOwner(repo);
    expect(repo.getSettings().owner).toEqual(DEMO_OWNER);
    expect(DEMO_OWNER.about).not.toMatch(/\b(he|him|his|she|her)\b/i);
    repo.updateSettings({ owner: { name: 'Sam', about: 'Typed into the demo.' } });
    seedDemoOwner(repo);
    expect(repo.getSettings().owner).toEqual({ name: 'Sam', about: 'Typed into the demo.' });
    repo.close();
  });
});
