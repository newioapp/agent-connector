import { describe, it, expect } from 'vitest';
import { buildMentions } from '../src/app/mentions.js';

const members = [
  { userId: 'u1', username: 'alice' },
  { userId: 'u2', username: 'bob' },
  { userId: 'u3', username: 'charlie' },
  { userId: 'u4', username: 'helper_bot' },
  { userId: 'u5', username: 'helper' },
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

  it('resolves usernames with internal underscores', () => {
    const result = buildMentions('hey @helper_bot please review', members);
    expect(result).toEqual({ userIds: ['u4'] });
  });

  it('resolves underscored usernames case-insensitively', () => {
    const result = buildMentions('hey @Helper_Bot', members);
    expect(result).toEqual({ userIds: ['u4'] });
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

  it('allows punctuation after a valid mention', () => {
    expect(buildMentions('thanks @alice, noted', members)).toEqual({ userIds: ['u1'] });
    expect(buildMentions('thanks @helper_bot.', members)).toEqual({ userIds: ['u4'] });
  });

  it('does not partially resolve usernames with trailing underscores', () => {
    expect(buildMentions('@helper_', members)).toBeUndefined();
    expect(buildMentions('@helper_bot_', members)).toBeUndefined();
  });

  it('does not partially resolve usernames with repeated underscores', () => {
    expect(buildMentions('@helper__bot', members)).toBeUndefined();
  });

  it('does not partially resolve dot or hyphen continuations', () => {
    expect(buildMentions('@alice.bob', members)).toBeUndefined();
    expect(buildMentions('@alice-bob', members)).toBeUndefined();
  });

  it('does not detect special mentions inside dot or underscore continuations', () => {
    expect(buildMentions('@everyone.com', members)).toBeUndefined();
    expect(buildMentions('@here_now', members)).toBeUndefined();
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
