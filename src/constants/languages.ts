/**
 * Language definitions and application-wide constants.
 *
 * SUPPORTED_LANGUAGES drives the language picker UI.
 * DEFAULT_SETTINGS provides sensible defaults for first-run users.
 */

import type { Language } from '@/types';

/** Languages available for translation. Ordered by expected usage frequency. */
export const SUPPORTED_LANGUAGES: Language[] = [
  { code: 'zh-CN', name: 'Chinese (Simplified)', nativeName: '简体中文', flag: '🇨🇳', ttsCode: 'zh-CN' },
  { code: 'en-US', name: 'English (US)', nativeName: 'English', flag: '🇺🇸', ttsCode: 'en-US' },
  { code: 'ja-JP', name: 'Japanese', nativeName: '日本語', flag: '🇯🇵', ttsCode: 'ja-JP' },
  { code: 'ko-KR', name: 'Korean', nativeName: '한국어', flag: '🇰🇷', ttsCode: 'ko-KR' },
  { code: 'fr-FR', name: 'French', nativeName: 'Français', flag: '🇫🇷', ttsCode: 'fr-FR' },
  { code: 'de-DE', name: 'German', nativeName: 'Deutsch', flag: '🇩🇪', ttsCode: 'de-DE' },
  { code: 'es-ES', name: 'Spanish', nativeName: 'Español', flag: '🇪🇸', ttsCode: 'es-ES' },
  { code: 'pt-BR', name: 'Portuguese (Brazil)', nativeName: 'Português', flag: '🇧🇷', ttsCode: 'pt-BR' },
  { code: 'ru-RU', name: 'Russian', nativeName: 'Русский', flag: '🇷🇺', ttsCode: 'ru-RU' },
  { code: 'ar-SA', name: 'Arabic', nativeName: 'العربية', flag: '🇸🇦', ttsCode: 'ar-SA' },
  { code: 'th-TH', name: 'Thai', nativeName: 'ไทย', flag: '🇹🇭', ttsCode: 'th-TH' },
  { code: 'vi-VN', name: 'Vietnamese', nativeName: 'Tiếng Việt', flag: '🇻🇳', ttsCode: 'vi-VN' },
];

/** Default application settings for first launch */
export const DEFAULT_SETTINGS = {
  apiBaseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
  temperature: 0.1,
  maxTokens: 1024,
  asrConfidenceThreshold: 0.6,
  subtitleFontSize: 18,
  subtitlePosition: 'bottom' as const,
  autoStart: false,
  startMinimized: false,
  whisperApiBaseUrl: 'https://api.openai.com/v1',
  whisperModel: 'whisper-1',
  speechTranslateModel: '',
};

/** DeepSeek API pricing per million tokens (CNY) */
export const DEEPSEEK_PRICING = {
  inputPerMillion: 1.0,
  outputPerMillion: 2.0,
};

/** Maximum recording duration in milliseconds */
export const MAX_RECORDING_DURATION_MS = 30_000;

/** Silence timeout used for Voice Activity Detection (ms) */
export const VAD_SILENCE_TIMEOUT_MS = 1_500;

/** Storage keys used across the app */
export const STORAGE_KEYS = {
  SETTINGS: 'voice-translation-settings',
  USAGE_STATS: 'voice-translation-usage',
} as const;
