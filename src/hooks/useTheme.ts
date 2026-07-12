/**
 * React hook that applies the user's theme preference to the document and
 * reactively switches between light, dark, and system preference.
 *
 * When the theme is set to `'system'` the hook listens for OS-level colour
 * scheme changes via `matchMedia('(prefers-color-scheme: dark)')` and keeps
 * the `<html>` element's `dark` class in sync.
 *
 * MUST be called once at the app root (typically in `App.tsx`) so the
 * theme class is applied before the first paint.
 *
 * @example
 * ```tsx
 * // App.tsx
 * export default function App() {
 *   useTheme();
 *   return <AppShell />;
 * }
 * ```
 *
 * @example
 * ```tsx
 * // Any component that needs to react to theme
 * const { theme, setTheme, isDark } = useTheme();
 * ```
 */

import { useEffect, useCallback, useMemo } from 'react';
import { useSettingsStore } from '@/stores/settingsStore';
import type { Theme } from '@/types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const THEME_CLASS = 'dark';
const MEDIA_QUERY = '(prefers-color-scheme: dark)';

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useTheme() {
  const storeTheme = useSettingsStore((s) => s.theme);
  const updateSetting = useSettingsStore((s) => s.updateSetting);

  /**
   * Determine the effective theme — 'dark' or 'light' — after resolving
   * the `'system'` option against the OS preference.
   */
  const isDark = useMemo<boolean>(() => {
    if (storeTheme === 'system') {
      try {
        return window.matchMedia(MEDIA_QUERY).matches;
      } catch {
        return false;
      }
    }
    return storeTheme === 'dark';
  }, [storeTheme]);

  // -----------------------------------------------------------------------
  // Apply the theme class to <html> whenever the resolved value changes
  // -----------------------------------------------------------------------
  useEffect(() => {
    const root = document.documentElement;

    if (isDark) {
      root.classList.add(THEME_CLASS);
    } else {
      root.classList.remove(THEME_CLASS);
    }
  }, [isDark]);

  // -----------------------------------------------------------------------
  // Listen for OS preference changes when theme === 'system'
  // -----------------------------------------------------------------------
  useEffect(() => {
    if (storeTheme !== 'system') return;

    let mql: MediaQueryList;
    try {
      mql = window.matchMedia(MEDIA_QUERY);
    } catch {
      return;
    }

    const handleChange = () => {
      const root = document.documentElement;
      if (mql.matches) {
        root.classList.add(THEME_CLASS);
      } else {
        root.classList.remove(THEME_CLASS);
      }
    };

    mql.addEventListener('change', handleChange);
    return () => {
      mql.removeEventListener('change', handleChange);
    };
  }, [storeTheme]);

  /**
   * Imperatively switch the theme. Persisted automatically by the settings
   * store.
   */
  const setTheme = useCallback(
    async (theme: Theme) => {
      await updateSetting('theme', theme);
    },
    [updateSetting],
  );

  return { theme: storeTheme, setTheme, isDark } as const;
}
