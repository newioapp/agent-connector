/**
 * Settings panel — theme preferences.
 */
import { useEffect, useState } from 'react';
import { Monitor, Sun, Moon } from 'lucide-react';
import type { ThemeSource } from '../../../shared/types';

const THEMES: readonly { readonly value: ThemeSource; readonly label: string; readonly icon: typeof Monitor }[] = [
  { value: 'system', label: 'System', icon: Monitor },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
];

export function SettingsPanel(): React.JSX.Element {
  const [theme, setTheme] = useState<ThemeSource>('system');

  useEffect(() => {
    void window.api.getTheme().then(setTheme);
  }, []);

  async function handleThemeChange(t: ThemeSource): Promise<void> {
    await window.api.setTheme(t);
    setTheme(t);
    if (t === 'dark' || (t === 'system' && (await window.api.getNativeThemeDark()))) {
      document.documentElement.classList.remove('light');
    } else {
      document.documentElement.classList.add('light');
    }
  }

  return (
    <div className="flex flex-1 flex-col min-h-0">
      {/* Header */}
      <div className="flex items-center border-b border-border px-6 py-4">
        <h2 className="text-base font-semibold text-foreground">Settings</h2>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        <div className="mb-1 text-xs font-medium text-muted-foreground">Theme</div>
        <div className="flex gap-2">
          {THEMES.map((t) => {
            const Icon = t.icon;
            return (
              <button
                key={t.value}
                className={`flex flex-1 flex-col items-center gap-1.5 rounded-md border px-3 py-3 text-xs transition-colors ${
                  theme === t.value
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-input text-foreground hover:bg-accent'
                }`}
                onClick={() => void handleThemeChange(t.value)}
              >
                <Icon size={18} />
                {t.label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
