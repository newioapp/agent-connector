import { describe, it, expect, vi } from 'vitest';
import type { Input } from 'electron';
import { isBlockedShortcut } from '../../src/main/keyboard-shortcuts';

/** Helper to build a partial Input object with sensible defaults. */
function input(overrides: Partial<Input> & { key: string }): Input {
  return {
    type: 'keyDown',
    key: overrides.key,
    code: '',
    isAutoRepeat: false,
    isComposing: false,
    shift: false,
    control: false,
    alt: false,
    meta: false,
    ...overrides,
  };
}

describe('isBlockedShortcut', () => {
  describe('function keys', () => {
    it('blocks F5', () => {
      expect(isBlockedShortcut(input({ key: 'F5' }))).toBe(true);
    });

    it('blocks F12', () => {
      expect(isBlockedShortcut(input({ key: 'F12' }))).toBe(true);
    });
  });

  describe('reload (Cmd/Ctrl+R)', () => {
    it('blocks Cmd+R on macOS', () => {
      vi.stubGlobal('process', { ...process, platform: 'darwin' });
      expect(isBlockedShortcut(input({ key: 'r', meta: true }))).toBe(true);
      vi.unstubAllGlobals();
    });

    it('blocks Ctrl+R on Linux', () => {
      vi.stubGlobal('process', { ...process, platform: 'linux' });
      expect(isBlockedShortcut(input({ key: 'r', control: true }))).toBe(true);
      vi.unstubAllGlobals();
    });

    it('blocks Cmd+Shift+R (hard reload)', () => {
      vi.stubGlobal('process', { ...process, platform: 'darwin' });
      expect(isBlockedShortcut(input({ key: 'r', meta: true, shift: true }))).toBe(true);
      vi.unstubAllGlobals();
    });
  });

  describe('zoom (Cmd/Ctrl+Plus/Minus/0)', () => {
    it('blocks Cmd+= (zoom in)', () => {
      vi.stubGlobal('process', { ...process, platform: 'darwin' });
      expect(isBlockedShortcut(input({ key: '=', meta: true }))).toBe(true);
      vi.unstubAllGlobals();
    });

    it('blocks Cmd+- (zoom out)', () => {
      vi.stubGlobal('process', { ...process, platform: 'darwin' });
      expect(isBlockedShortcut(input({ key: '-', meta: true }))).toBe(true);
      vi.unstubAllGlobals();
    });

    it('blocks Cmd+0 (reset zoom)', () => {
      vi.stubGlobal('process', { ...process, platform: 'darwin' });
      expect(isBlockedShortcut(input({ key: '0', meta: true }))).toBe(true);
      vi.unstubAllGlobals();
    });
  });

  describe('DevTools', () => {
    it('blocks Cmd+Option+I on macOS', () => {
      vi.stubGlobal('process', { ...process, platform: 'darwin' });
      expect(isBlockedShortcut(input({ key: 'i', meta: true, alt: true }))).toBe(true);
      vi.unstubAllGlobals();
    });

    it('blocks Ctrl+Shift+I on Windows', () => {
      vi.stubGlobal('process', { ...process, platform: 'win32' });
      expect(isBlockedShortcut(input({ key: 'i', control: true, shift: true }))).toBe(true);
      vi.unstubAllGlobals();
    });

    it('does not block Cmd+I without Option on macOS', () => {
      vi.stubGlobal('process', { ...process, platform: 'darwin' });
      expect(isBlockedShortcut(input({ key: 'i', meta: true }))).toBe(false);
      vi.unstubAllGlobals();
    });
  });

  describe('address bar and find', () => {
    it('blocks Cmd+L', () => {
      vi.stubGlobal('process', { ...process, platform: 'darwin' });
      expect(isBlockedShortcut(input({ key: 'l', meta: true }))).toBe(true);
      vi.unstubAllGlobals();
    });

    it('blocks Cmd+G', () => {
      vi.stubGlobal('process', { ...process, platform: 'darwin' });
      expect(isBlockedShortcut(input({ key: 'g', meta: true }))).toBe(true);
      vi.unstubAllGlobals();
    });
  });

  describe('allowed shortcuts (should NOT be blocked)', () => {
    it('allows Cmd+C (copy)', () => {
      vi.stubGlobal('process', { ...process, platform: 'darwin' });
      expect(isBlockedShortcut(input({ key: 'c', meta: true }))).toBe(false);
      vi.unstubAllGlobals();
    });

    it('allows Cmd+V (paste)', () => {
      vi.stubGlobal('process', { ...process, platform: 'darwin' });
      expect(isBlockedShortcut(input({ key: 'v', meta: true }))).toBe(false);
      vi.unstubAllGlobals();
    });

    it('allows Cmd+A (select all — handled in renderer)', () => {
      vi.stubGlobal('process', { ...process, platform: 'darwin' });
      expect(isBlockedShortcut(input({ key: 'a', meta: true }))).toBe(false);
      vi.unstubAllGlobals();
    });

    it('allows bare letter keys', () => {
      expect(isBlockedShortcut(input({ key: 'r' }))).toBe(false);
    });

    it('allows bare number keys', () => {
      expect(isBlockedShortcut(input({ key: '0' }))).toBe(false);
    });
  });
});
