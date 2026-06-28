import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { assertWorkingDirectory } from '../src/acp-session-factory';
import { InvalidWorkingDirectoryError } from '../src/errors';

let dir: string;
let file: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'awd-'));
  file = join(dir, 'a-file');
  writeFileSync(file, 'x');
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('assertWorkingDirectory', () => {
  it('resolves for an existing directory', async () => {
    await expect(assertWorkingDirectory(dir)).resolves.toBeUndefined();
  });

  it('throws InvalidWorkingDirectoryError naming a missing path', async () => {
    const missing = join(dir, 'does-not-exist');
    await expect(assertWorkingDirectory(missing)).rejects.toBeInstanceOf(InvalidWorkingDirectoryError);
    await expect(assertWorkingDirectory(missing)).rejects.toThrow(`does not exist: ${missing}`);
  });

  it('throws distinguishing a file from a directory', async () => {
    await expect(assertWorkingDirectory(file)).rejects.toThrow(`is not a directory: ${file}`);
  });

  it('carries the invalid_working_directory error code', async () => {
    await assertWorkingDirectory(join(dir, 'nope')).catch((err: unknown) => {
      expect(err).toBeInstanceOf(InvalidWorkingDirectoryError);
      expect((err as InvalidWorkingDirectoryError).errorCode).toBe('invalid_working_directory');
    });
  });
});
