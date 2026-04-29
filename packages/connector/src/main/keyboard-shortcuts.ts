/**
 * Block Chromium-inherited keyboard shortcuts that don't belong in a desktop app.
 * Covers macOS (Cmd), Windows/Linux (Ctrl), and function keys across all platforms.
 */
import type { BrowserWindow, Input, Event } from 'electron';

/** Returns true if the given keyboard input is a blocked Chromium shortcut. */
export function isBlockedShortcut(input: Input): boolean {
  const key = input.key.toLowerCase();
  const isMac = process.platform === 'darwin';
  const meta = isMac ? input.meta : input.control;

  // Function keys (all platforms): F5 (reload), F12 (DevTools)
  if (key === 'f5' || key === 'f12') {
    return true;
  }

  if (!meta) {
    return false;
  }

  // Cmd/Ctrl+R, Cmd/Ctrl+Shift+R — reload
  if (key === 'r') {
    return true;
  }
  // Cmd/Ctrl+Plus/=, Cmd/Ctrl+Minus, Cmd/Ctrl+0 — zoom
  if (key === '=' || key === '+' || key === '-' || key === '0') {
    return true;
  }
  // Cmd+Option+I (macOS) / Ctrl+Shift+I (Windows/Linux) — DevTools
  if (key === 'i' && (isMac ? input.alt : input.shift)) {
    return true;
  }
  // Cmd/Ctrl+L — focus address bar
  if (key === 'l') {
    return true;
  }
  // Cmd/Ctrl+G, Cmd/Ctrl+Shift+G — find next/previous
  if (key === 'g') {
    return true;
  }

  return false;
}

/** Install the before-input-event handler on a BrowserWindow to block Chromium shortcuts. */
export function blockChromiumShortcuts(window: BrowserWindow): void {
  window.webContents.on('before-input-event', (event: Event, input: Input) => {
    if (input.type === 'keyDown' && isBlockedShortcut(input)) {
      event.preventDefault();
    }
  });
}
