/**
 * Theme picker with three visual card options: Light, Dark, and System.
 *
 * Each card shows an icon, label, and a mini preview of the appearance.
 * The selected card is highlighted with a primary ring.
 */

import { useCallback } from 'react';
import { Sun, Moon, Monitor } from 'lucide-react';
import { useSettingsStore } from '@/stores/settingsStore';
import { cn } from '@/lib/utils';
import type { Theme } from '@/types';

// ---------------------------------------------------------------------------
// Theme options
// ---------------------------------------------------------------------------

interface ThemeOption {
  value: Theme;
  label: string;
  icon: React.ReactNode;
  previewClass: string;
}

const THEME_OPTIONS: ThemeOption[] = [
  {
    value: 'light',
    label: 'Light',
    icon: <Sun className="h-5 w-5" />,
    previewClass: 'bg-white border border-gray-200',
  },
  {
    value: 'dark',
    label: 'Dark',
    icon: <Moon className="h-5 w-5" />,
    previewClass: 'bg-gray-900 border border-gray-700',
  },
  {
    value: 'system',
    label: 'System',
    icon: <Monitor className="h-5 w-5" />,
    previewClass: 'bg-gradient-to-r from-white via-white to-gray-900 border border-gray-300',
  },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface ThemeSelectorProps {
  /** Optional callback fired after the theme is changed. */
  onChange?: (theme: Theme) => void;
}

export function ThemeSelector({ onChange }: ThemeSelectorProps) {
  const theme = useSettingsStore((s) => s.theme);
  const updateSetting = useSettingsStore((s) => s.updateSetting);

  const handleSelect = useCallback(
    (value: Theme) => {
      updateSetting('theme', value);
      onChange?.(value);
    },
    [updateSetting, onChange],
  );

  return (
    <div className="grid grid-cols-3 gap-3">
      {THEME_OPTIONS.map((option) => {
        const isSelected = theme === option.value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => handleSelect(option.value)}
            className={cn(
              'flex flex-col items-center gap-2 rounded-lg border-2 p-3 transition-all duration-200',
              'hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              isSelected
                ? 'border-primary ring-1 ring-primary bg-primary/5'
                : 'border-border bg-card',
            )}
            aria-label={`${option.label} theme`}
            aria-pressed={isSelected}
          >
            {/* Icon */}
            <div
              className={cn(
                'rounded-full p-1.5 transition-colors',
                isSelected ? 'text-primary' : 'text-muted-foreground',
              )}
            >
              {option.icon}
            </div>

            {/* Label */}
            <span
              className={cn(
                'text-xs font-medium',
                isSelected ? 'text-primary' : 'text-muted-foreground',
              )}
            >
              {option.label}
            </span>

            {/* Mini preview */}
            <div
              className={cn(
                'mt-1 h-8 w-full rounded',
                option.previewClass,
              )}
            >
              {/* Fake text lines in preview */}
              <div className="flex flex-col gap-1 p-1.5">
                <div
                  className={cn(
                    'h-0.5 w-3/4 rounded',
                    option.value === 'dark' ? 'bg-gray-600' : 'bg-gray-200',
                  )}
                />
                <div
                  className={cn(
                    'h-0.5 w-1/2 rounded',
                    option.value === 'dark' ? 'bg-gray-600' : 'bg-gray-200',
                  )}
                />
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}
