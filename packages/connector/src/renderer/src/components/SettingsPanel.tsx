/**
 * Settings panel — theme and auto-update preferences.
 */
import { useEffect, useState } from 'react';
import { Monitor, Sun, Moon } from 'lucide-react';
import type { ThemeSource, UpdateMode } from '../../../shared/types';

const THEMES: readonly { readonly value: ThemeSource; readonly label: string; readonly icon: typeof Monitor }[] = [
  { value: 'system', label: 'System', icon: Monitor },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
];

const UPDATE_MODES: readonly { readonly value: UpdateMode; readonly label: string }[] = [
  { value: 'auto', label: 'Automatic' },
  { value: 'manual', label: 'Manual' },
  { value: 'disabled', label: 'Disabled' },
];

function SettingRow({
  label,
  description,
  children,
}: {
  readonly label: string;
  readonly description: string;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between py-3">
      <div className="mr-4">
        <span className="text-sm text-foreground">{label}</span>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      {children}
    </div>
  );
}

function Dropdown<T extends string>({
  value,
  options,
  onChange,
}: {
  readonly value: T;
  readonly options: readonly { readonly value: T; readonly label: string }[];
  readonly onChange: (v: T) => void;
}): React.JSX.Element {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      className="rounded-md border border-input bg-secondary px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function SettingsPanel(): React.JSX.Element {
  const [theme, setTheme] = useState<ThemeSource>('system');
  const [updateMode, setUpdateMode] = useState<UpdateMode>('auto');

  useEffect(() => {
    void window.api.getTheme().then(setTheme);
    void window.api.getUpdateMode().then(setUpdateMode);
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

  async function handleUpdateModeChange(mode: UpdateMode): Promise<void> {
    await window.api.setUpdateMode(mode);
    setUpdateMode(mode);
  }

  function handleCheck(): void {
    void window.api.checkForUpdates();
  }

  return (
    <div className="flex flex-1 flex-col items-center overflow-y-auto px-6 pt-16">
      <h2 className="text-lg font-semibold text-foreground">Settings</h2>

      <div className="mt-6 w-full max-w-sm divide-y divide-border">
        <SettingRow label="Theme" description="Choose your preferred appearance">
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
        </SettingRow>

        <SettingRow label="Updates" description="How the connector checks for new versions">
          <div className="flex items-center gap-2">
            <Dropdown
              value={updateMode}
              options={UPDATE_MODES}
              onChange={(mode) => void handleUpdateModeChange(mode)}
            />
            <button
              onClick={handleCheck}
              disabled={updateMode === 'disabled'}
              className="whitespace-nowrap rounded-md border border-input px-3 py-1.5 text-sm text-foreground transition-colors hover:bg-accent disabled:opacity-50"
            >
              Check Now
            </button>
          </div>
        </SettingRow>
      </div>
    </div>
  );
}
