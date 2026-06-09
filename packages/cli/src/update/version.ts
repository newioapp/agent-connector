/**
 * Minimal semver comparison for the self-updater.
 *
 * The CLI versions are plain `MAJOR.MINOR.PATCH` tags (the release workflow
 * derives them from `cli-v*` tags), so a full semver dependency would be
 * overkill. This handles the `x.y.z` core plus an optional `-prerelease` suffix
 * (a prerelease sorts BELOW its release, per semver), which is all we publish.
 */

interface ParsedVersion {
  readonly core: readonly [number, number, number];
  /** Dot-separated prerelease identifiers, e.g. `['beta', '1']`. Empty for a release. */
  readonly prerelease: readonly string[];
}

/** Parse `1.2.3` or `1.2.3-beta.1`; returns null for anything malformed. */
export function parseVersion(value: string): ParsedVersion | null {
  const trimmed = value.trim().replace(/^v/, '');
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(trimmed);
  if (match === null) {
    return null;
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  const prerelease = match[4] === undefined || match[4] === '' ? [] : match[4].split('.');
  return { core: [major, minor, patch], prerelease };
}

/**
 * Compare two versions: negative if `a < b`, positive if `a > b`, 0 if equal.
 * Unparseable inputs sort below parseable ones (and equal to each other), so a
 * garbage manifest never spuriously reports "newer".
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (pa === null || pb === null) {
    return pa === pb ? 0 : pa === null ? -1 : 1;
  }
  for (let i = 0; i < 3; i++) {
    const ca = pa.core[i] ?? 0;
    const cb = pb.core[i] ?? 0;
    if (ca !== cb) {
      return ca - cb;
    }
  }
  // Equal core: a version WITH a prerelease is lower than one without.
  if (pa.prerelease.length === 0 || pb.prerelease.length === 0) {
    return pa.prerelease.length === pb.prerelease.length ? 0 : pa.prerelease.length === 0 ? 1 : -1;
  }
  // Both prerelease: compare identifiers left-to-right (numeric < by value,
  // mixed/alpha by ASCII), shorter set lower when otherwise equal.
  const len = Math.min(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < len; i++) {
    const ai = pa.prerelease[i];
    const bi = pb.prerelease[i];
    if (ai === undefined || bi === undefined || ai === bi) {
      continue;
    }
    const an = /^\d+$/.test(ai);
    const bn = /^\d+$/.test(bi);
    if (an && bn) {
      return Number(ai) - Number(bi);
    }
    if (an !== bn) {
      return an ? -1 : 1; // numeric identifiers rank lower than alphanumeric
    }
    return ai < bi ? -1 : 1;
  }
  return pa.prerelease.length - pb.prerelease.length;
}

/** True when `candidate` is a strictly newer version than `current`. */
export function isNewer(current: string, candidate: string): boolean {
  return compareVersions(candidate, current) > 0;
}
