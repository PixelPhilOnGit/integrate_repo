/**
 * Core type definitions for the voice translation application.
 * All types, interfaces, and enums used across the app are defined here.
 */

/** A single translated message in a conversation thread */
export interface Message {
  id: string;
  timestamp: number;
  originalText: string;
  translatedText: string;
  sourceLanguage: string;
  targetLanguage: string;
  isRetranslated: boolean;
  error?: string;
}

/** The current state of the recording and processing pipeline */
export type RecordingState =
  | 'idle'
  | 'recording'
  | 'recognizing'
  | 'translating'
  | 'playing';

/** A subtitle frame used in simultaneous interpretation mode */
export interface Subtitle {
  id: string;
  timestamp: number;
  originalText: string;
  translatedText: string;
  isFinal: boolean;
}

/** Top-level application mode */
export type AppMode = 'conversation' | 'simultaneous' | 'settings';

/** Theme preference */
export type Theme = 'light' | 'dark' | 'system';

/** Automatic Speech Recognition engine backend */
export type AsrEngine = 'system' | 'whisper';

/** Audio input source */
export type AudioSource = 'microphone' | 'system_audio';

/** Language definition with display and TTS metadata */
export interface Language {
  /** BCP-47 language tag, e.g. "en-US", "zh-CN" */
  code: string;
  /** English display name, e.g. "English" */
  name: string;
  /** Native language name */
  nativeName: string;
  /** Flag emoji */
  flag: string;
  /** Language code used for text-to-speech synthesis */
  ttsCode: string;
}

/** Translation endpoint configuration */
export interface TranslationConfig {
  apiKey: string;
  apiBaseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
}

/** Result from the speech recognition engine */
export interface RecognitionResult {
  text: string;
  confidence: number;
}

/** Persisted application settings */
export interface AppSettings {
  apiKey: string;
  apiBaseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  sourceLanguage: string;
  targetLanguage: string;
  theme: Theme;
  asrEngine: AsrEngine;
  asrConfidenceThreshold: number;
  audioSource: AudioSource;
  autoStart: boolean;
  startMinimized: boolean;
  onboardingCompleted: boolean;
  subtitleFontSize: number;
  subtitlePosition: 'top' | 'bottom';
  /** Whisper API key for system audio transcription (OpenAI-compatible). */
  whisperApiKey: string;
  /** Whisper API base URL (defaults to https://api.openai.com/v1). */
  whisperApiBaseUrl: string;
  /** Whisper model name (e.g. 'whisper-1' for OpenAI, 'FunAudioLLM/SenseVoiceSmall' for SiliconFlow). */
  whisperModel: string;
  /** Direct speech-to-translation model. When set, skips Whisper+DeepSeek and uses a multimodal model (e.g. Qwen3-Omni). */
  speechTranslateModel: string;
}

/** API usage statistics for cost tracking */
export interface UsageStats {
  totalTokens: number;
  totalCost: number;
  requestCount: number;
  lastResetDate: string;
  dailyStats: Record<string, { tokens: number; cost: number }>;
}

/** Metadata about an available audio input/output device */
export interface AudioDeviceInfo {
  id: string;
  name: string;
  isDefault: boolean;
}

/** Event payload emitted after each translation API call */
export interface UsageEvent {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost: number;
  timestamp: number;
}
