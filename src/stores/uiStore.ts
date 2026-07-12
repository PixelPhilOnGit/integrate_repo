/**
 * Zustand store for transient UI state that does not need to be persisted.
 *
 * Manages: sidebar visibility, onboarding dialog state, active settings tab,
 * the current app mode, and usage statistics loading.
 *
 * @example
 * ```ts
 * const sidebarOpen = useUiStore((s) => s.sidebarOpen);
 * const { toggleSidebar } = useUiStore();
 * ```
 */

import { create } from 'zustand';
import type { UsageStats } from '@/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UiActions {
  /** Toggle the sidebar open/closed. */
  toggleSidebar: () => void;
  /** Explicitly set the sidebar open state. */
  setSidebarOpen: (open: boolean) => void;
  /** Show or hide the onboarding dialog. */
  setOnboardingOpen: (open: boolean) => void;
  /** Switch the active settings tab by its key. */
  setSettingsTab: (tab: string) => void;
  /** Load API usage statistics from the backend. */
  loadUsageStats: () => Promise<void>;
}

export type UiStore = {
  sidebarOpen: boolean;
  onboardingOpen: boolean;
  settingsTab: string;
  /** API usage statistics (null until loaded). */
  usageStats: UsageStats | null;
  /** True while usage stats are being fetched. */
  usageStatsLoading: boolean;
} & UiActions;

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useUiStore = create<UiStore>()((set) => ({
  sidebarOpen: true,
  onboardingOpen: false,
  settingsTab: 'general',
  usageStats: null,
  usageStatsLoading: false,

  toggleSidebar: () => {
    set((state) => ({ sidebarOpen: !state.sidebarOpen }));
  },

  setSidebarOpen: (sidebarOpen) => {
    set({ sidebarOpen });
  },

  setOnboardingOpen: (onboardingOpen) => {
    set({ onboardingOpen });
  },

  setSettingsTab: (settingsTab) => {
    set({ settingsTab });
  },

  loadUsageStats: async () => {
    set({ usageStatsLoading: true });
    try {
      // Attempt to read persisted usage stats; falls back to zeroed stats
      // when running outside Tauri (browser dev / static build).
      const { load } = await import('@tauri-apps/plugin-store');
      const store = await load('usage.json', { autoSave: true, defaults: {} as Record<string, unknown> });
      const saved = await store.get<UsageStats>('stats');
      if (saved) {
        set({ usageStats: saved });
      } else {
        set({
          usageStats: {
            totalTokens: 0,
            totalCost: 0,
            requestCount: 0,
            lastResetDate: new Date().toISOString(),
            dailyStats: {},
          },
        });
      }
    } catch {
      // Tauri plugin-store unavailable — running in a browser context
      try {
        const raw = localStorage.getItem('voice-translation-usage');
        if (raw) {
          set({ usageStats: JSON.parse(raw) as UsageStats });
        }
      } catch {
        // Corrupt or inaccessible localStorage entry
      }
    } finally {
      set({ usageStatsLoading: false });
    }
  },
}));
