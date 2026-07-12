/**
 * Zustand store for persisted application settings.
 *
 * Manages all user-configurable settings with persistence via
 * @tauri-apps/plugin-store (Tauri native) falling back to localStorage
 * when running in a browser environment (e.g. during development).
 *
 * The store exposes the full AppSettings interface merged with action
 * functions. Only the settings fields are serialized to disk; action
 * functions are stripped during persistence.
 *
 * @example
 * ```ts
 * const apiKey = useSettingsStore((s) => s.apiKey);
 * const { updateSetting, loadSettings } = useSettingsStore();
 * ```
 */

import { create } from 'zustand';
import type { AppSettings, Theme, AsrEngine, AudioSource } from '@/types';
import { DEFAULT_SETTINGS, STORAGE_KEYS } from '@/constants/languages';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SettingsActions {
  /** Load persisted settings from disk or localStorage into the store. */
  loadSettings: () => Promise<void>;
  /** Update a single setting key and persist the full settings object. */
  updateSetting: <K extends keyof AppSettings>(
    key: K,
    value: AppSettings[K],
  ) => Promise<void>;
  /** Reset all settings to their factory defaults and persist. */
  resetSettings: () => Promise<void>;
  /** Returns true when a valid API key is present. */
  isConfigured: () => boolean;
}

export type SettingsStore = AppSettings & SettingsActions;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build the default AppSettings object from constants.
 */
function createDefaultSettings(): AppSettings {
  return {
    apiKey: '',
    apiBaseUrl: DEFAULT_SETTINGS.apiBaseUrl,
    model: DEFAULT_SETTINGS.model,
    temperature: DEFAULT_SETTINGS.temperature,
    maxTokens: DEFAULT_SETTINGS.maxTokens,
    sourceLanguage: 'zh-CN',
    targetLanguage: 'en-US',
    theme: 'system' as Theme,
    asrEngine: 'system' as AsrEngine,
    asrConfidenceThreshold: DEFAULT_SETTINGS.asrConfidenceThreshold,
    audioSource: 'microphone' as AudioSource,
    autoStart: DEFAULT_SETTINGS.autoStart,
    startMinimized: DEFAULT_SETTINGS.startMinimized,
    onboardingCompleted: false,
    subtitleFontSize: DEFAULT_SETTINGS.subtitleFontSize,
    subtitlePosition: DEFAULT_SETTINGS.subtitlePosition,
    whisperApiKey: '',
    whisperApiBaseUrl: DEFAULT_SETTINGS.whisperApiBaseUrl,
    whisperModel: DEFAULT_SETTINGS.whisperModel,
    speechTranslateModel: DEFAULT_SETTINGS.speechTranslateModel,
  };
}

/**
 * Strip action methods from the combined store state, returning only the
 * AppSettings fields suitable for serialisation.
 */
function pickAppSettings(state: SettingsStore): AppSettings {
  return {
    apiKey: state.apiKey,
    apiBaseUrl: state.apiBaseUrl,
    model: state.model,
    temperature: state.temperature,
    maxTokens: state.maxTokens,
    sourceLanguage: state.sourceLanguage,
    targetLanguage: state.targetLanguage,
    theme: state.theme,
    asrEngine: state.asrEngine,
    asrConfidenceThreshold: state.asrConfidenceThreshold,
    audioSource: state.audioSource,
    autoStart: state.autoStart,
    startMinimized: state.startMinimized,
    onboardingCompleted: state.onboardingCompleted,
    subtitleFontSize: state.subtitleFontSize,
    subtitlePosition: state.subtitlePosition,
    whisperApiKey: state.whisperApiKey,
    whisperApiBaseUrl: state.whisperApiBaseUrl,
    whisperModel: state.whisperModel,
    speechTranslateModel: state.speechTranslateModel,
  };
}

// ---------------------------------------------------------------------------
// Persistence layer
// ---------------------------------------------------------------------------

/**
 * Try to read persisted settings from the most capable storage available.
 * Priority: Tauri plugin-store > localStorage > defaults.
 */
async function loadPersistedSettings(): Promise<AppSettings> {
  const defaults = createDefaultSettings();

  // 1. Attempt Tauri plugin-store
  try {
    const { load } = await import('@tauri-apps/plugin-store');
    const store = await load('settings.json', { autoSave: true, defaults: {} as Record<string, unknown> });
    const saved = await store.get<Partial<AppSettings>>('settings');
    if (saved && Object.keys(saved).length > 0) {
      return { ...defaults, ...saved };
    }
  } catch {
    // Tauri APIs are unavailable — running in a browser context
  }

  // 2. Fall back to localStorage
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.SETTINGS);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<AppSettings>;
      return { ...defaults, ...parsed };
    }
  } catch {
    // Corrupt or inaccessible localStorage entry
  }

  return defaults;
}

/**
 * Persist the given settings to all available storage back-ends.
 * Writes to both Tauri store and localStorage so either is always up to date.
 */
async function persistSettings(settings: AppSettings): Promise<void> {
  try {
    const { load } = await import('@tauri-apps/plugin-store');
    const store = await load('settings.json', { autoSave: true, defaults: {} as Record<string, unknown> });
    await store.set('settings', settings);
    await store.save();
  } catch {
    // Tauri unavailable — skip
  }

  try {
    localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(settings));
  } catch {
    // localStorage full or blocked — skip
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useSettingsStore = create<SettingsStore>()((set, get) => ({
  ...createDefaultSettings(),

  /**
   * Load settings from the most capable persistence layer available.
   * Should be called once during app initialisation (e.g. in App.tsx).
   */
  loadSettings: async () => {
    const settings = await loadPersistedSettings();
    set(settings);
  },

  /**
   * Update a single setting by key and persist the full settings object
   * immediately.
   */
  updateSetting: async <K extends keyof AppSettings>(
    key: K,
    value: AppSettings[K],
  ) => {
    set({ [key]: value });
    await persistSettings(pickAppSettings(get()));
  },

  /**
   * Reset every setting back to its default and persist.
   */
  resetSettings: async () => {
    const defaults = createDefaultSettings();
    set(defaults);
    await persistSettings(defaults);
  },

  /**
   * Returns true when the user has provided a non-empty API key.
   */
  isConfigured: () => {
    return get().apiKey.length > 0;
  },
}));
