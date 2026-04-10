import { describe, it, expect } from 'vitest';
import { buildMentions } from '../src/app/mentions.js';

const members = [
  { userId: 'u1', username: 'alice' },
  { userId: 'u2', username: 'bob' },
  { userId: 'u3', username: 'charlie' },
];

describe('buildMentions', () => {
  it('returns undefined when no mentions found', () => {
    expect(buildMentions('hello world', members)).toBeUndefined();
  });

  it('resolves @username to userId', () => {
    const result = buildMentions('hey @alice check this', members);
    expect(result).toEqual({ userIds: ['u1'] });
  });

  it('resolves multiple @usernames', () => {
    const result = buildMentions('@alice and @bob please review', members);
    expect(result).toEqual({ userIds: ['u1', 'u2'] });
  });

  it('deduplicates repeated mentions', () => {
    const result = buildMentions('@alice said @alice should do it', members);
    expect(result).toEqual({ userIds: ['u1'] });
  });

  it('is case-insensitive', () => {
    const result = buildMentions('@Alice and @BOB', members);
    expect(result).toEqual({ userIds: ['u1', 'u2'] });
  });

  it('ignores @usernames not in member list', () => {
    const result = buildMentions('@alice and @stranger', members);
    expect(result).toEqual({ userIds: ['u1'] });
  });

  it('detects @everyone', () => {
    const result = buildMentions('hey @everyone', members);
    expect(result).toEqual({ everyone: true });
  });

  it('detects @here', () => {
    const result = buildMentions('hey @here', members);
    expect(result).toEqual({ here: true });
  });

  it('combines @username with @everyone', () => {
    const result = buildMentions('@alice @everyone', members);
    expect(result).toEqual({ userIds: ['u1'], everyone: true });
  });

  it('requires whitespace or start-of-line before @', () => {
    // email-like patterns should not match
    expect(buildMentions('email@alice.com', members)).toBeUndefined();
  });

  it('matches @username at start of line', () => {
    const result = buildMentions('@bob hello', members);
    expect(result).toEqual({ userIds: ['u2'] });
  });

  it('handles empty member list', () => {
    expect(buildMentions('@alice hello', [])).toBeUndefined();
  });

  it('handles members without usernames', () => {
    const noUsernames = [{ userId: 'u1' }, { userId: 'u2', username: 'bob' }];
    const result = buildMentions('@bob hello', noUsernames);
    expect(result).toEqual({ userIds: ['u2'] });
  });
});
