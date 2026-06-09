import { describe, it, expect } from 'vitest';
import { parseVersion, compareVersions, isNewer } from '../src/update/version';

describe('parseVersion', () => {
  it('parses a plain semver, tolerating a leading v', () => {
    expect(parseVersion('1.2.3')).toEqual({ core: [1, 2, 3], prerelease: [] });
    expect(parseVersion('v0.1.0')).toEqual({ core: [0, 1, 0], prerelease: [] });
  });

  it('parses a prerelease suffix into dot-separated identifiers', () => {
    expect(parseVersion('1.2.3-beta.1')).toEqual({ core: [1, 2, 3], prerelease: ['beta', '1'] });
  });

  it('rejects malformed input', () => {
    expect(parseVersion('1.2')).toBeNull();
    expect(parseVersion('latest')).toBeNull();
    expect(parseVersion('1.2.3.4')).toBeNull();
    expect(parseVersion('')).toBeNull();
  });
});

describe('compareVersions', () => {
  it('orders by core release fields', () => {
    expect(compareVersions('1.0.0', '2.0.0')).toBeLessThan(0);
    expect(compareVersions('1.2.0', '1.1.9')).toBeGreaterThan(0);
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('0.1.10', '0.1.2')).toBeGreaterThan(0);
  });

  it('ranks a prerelease below its release', () => {
    expect(compareVersions('1.2.3-beta.1', '1.2.3')).toBeLessThan(0);
    expect(compareVersions('1.2.3', '1.2.3-rc.1')).toBeGreaterThan(0);
  });

  it('orders prerelease identifiers (numeric by value, shorter set lower)', () => {
    expect(compareVersions('1.2.3-beta.1', '1.2.3-beta.2')).toBeLessThan(0);
    expect(compareVersions('1.2.3-beta', '1.2.3-beta.1')).toBeLessThan(0);
    expect(compareVersions('1.2.3-alpha', '1.2.3-beta')).toBeLessThan(0);
  });

  it('sorts unparseable versions below parseable ones without throwing', () => {
    expect(compareVersions('garbage', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', 'garbage')).toBeGreaterThan(0);
    expect(compareVersions('garbage', 'nonsense')).toBe(0);
  });
});

describe('isNewer', () => {
  it('is true only for a strictly greater candidate', () => {
    expect(isNewer('1.0.0', '1.0.1')).toBe(true);
    expect(isNewer('1.0.0', '1.0.0')).toBe(false);
    expect(isNewer('1.0.1', '1.0.0')).toBe(false);
  });

  it('never reports a malformed manifest version as newer', () => {
    expect(isNewer('1.0.0', 'latest')).toBe(false);
  });
});
