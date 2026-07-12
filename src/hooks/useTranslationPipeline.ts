/**
 * Central orchestrator hook that coordinates the full
 * audio → ASR → translation → TTS pipeline.
 *
 * Exposes:
 * - `startConversation()` / `stopConversation()` for push-to-talk mode
 * - `startSimultaneous()` / `stopSimultaneous()` for continuous mode
 * - `pipelineState` for UI status indicators
 *
 * Uses browser Web APIs (MediaRecorder, SpeechRecognition, SpeechSynthesis)
 * so it works in Tauri's WebView without depending on the Rust backend.
 *
 * @example
 * ```tsx
 * const { startConversation, stopConversation, pipelineState } = useTranslationPipeline();
 *
 * // In RecordButton:
 * <button
 *   onMouseDown={startConversation}
 *   onMouseUp={stopConversation}
 * >
 *   {pipelineState}
 * </button>
 * ```
 */

import { useCallback, useRef, useState } from 'react';
import { useSettingsStore } from '@/stores/settingsStore';
import { useConversationStore } from '@/stores/conversationStore';
import { audioCapture } from '@/services/audioCapture';
import {
  speechRecognitionService,
  SpeechRecognitionService,
} from '@/services/speechRecognitionService';
import { speechSynthesisService } from '@/services/speechSynthesisService';
import { systemAudioCapture, SystemAudioCapture } from '@/services/systemAudioCapture';
import { tauriSystemAudioCapture, TauriSystemAudioCapture } from '@/services/tauriSystemAudio';
import { transcribeAudio } from '@/services/whisperService';
import { translateSpeech } from '@/services/speechTranslationService';
import { translate } from '@/services/translationService';
import { SUPPORTED_LANGUAGES } from '@/constants/languages';
import type { RecordingState } from '@/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PipelineState = RecordingState;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getLanguageName(code: string): string {
  const lang = SUPPORTED_LANGUAGES.find((l) => l.code === code);
  return lang?.name ?? code;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useTranslationPipeline() {
  // --- Store subscriptions ---
  const apiKey = useSettingsStore((s) => s.apiKey);
  const apiBaseUrl = useSettingsStore((s) => s.apiBaseUrl);
  const model = useSettingsStore((s) => s.model);
  const temperature = useSettingsStore((s) => s.temperature);
  const maxTokens = useSettingsStore((s) => s.maxTokens);
  const sourceLanguage = useSettingsStore((s) => s.sourceLanguage);
  const targetLanguage = useSettingsStore((s) => s.targetLanguage);
  const audioSource = useSettingsStore((s) => s.audioSource);
  const whisperApiKey = useSettingsStore((s) => s.whisperApiKey);
  const whisperApiBaseUrl = useSettingsStore((s) => s.whisperApiBaseUrl);
  const whisperModel = useSettingsStore((s) => s.whisperModel);
  const speechTranslateModel = useSettingsStore((s) => s.speechTranslateModel);
  const addMessage = useConversationStore((s) => s.addMessage);
  const updateMessage = useConversationStore((s) => s.updateMessage);
  const setRecordingState = useConversationStore((s) => s.setRecordingState);
  const setStatusMessage = useConversationStore((s) => s.setStatusMessage);
  const addSubtitle = useConversationStore((s) => s.addSubtitle);
  const setListening = useConversationStore((s) => s.setListening);

  // --- Refs (avoid stale closures) ---
  const settingsRef = useRef({
    apiKey,
    apiBaseUrl,
    model,
    temperature,
    maxTokens,
    sourceLanguage,
    targetLanguage,
    audioSource,
    whisperApiKey,
    whisperApiBaseUrl,
    whisperModel,
    speechTranslateModel,
  });
  settingsRef.current = {
    apiKey,
    apiBaseUrl,
    model,
    temperature,
    maxTokens,
    sourceLanguage,
    targetLanguage,
    audioSource,
    whisperApiKey,
    whisperApiBaseUrl,
    whisperModel,
    speechTranslateModel,
  };

  const removeSubtitle = useConversationStore((s) => s.removeSubtitle);
  const updateSubtitle = useConversationStore((s) => s.updateSubtitle);

  const storeRef = useRef({
    addMessage,
    updateMessage,
    setRecordingState,
    setStatusMessage,
    addSubtitle,
    removeSubtitle,
    updateSubtitle,
    setListening,
  });
  storeRef.current = {
    addMessage,
    updateMessage,
    setRecordingState,
    setStatusMessage,
    addSubtitle,
    removeSubtitle,
    updateSubtitle,
    setListening,
  };

  const isRunningRef = useRef(false);

  // --- Local state ---
  const [pipelineState, setPipelineState] = useState<PipelineState>('idle');

  // --- Conversation mode (push-to-talk) ---

  const startConversation = useCallback(async () => {
    if (isRunningRef.current) return;

    const { apiKey: key, sourceLanguage: src } = settingsRef.current;
    if (!key) {
      storeRef.current.setStatusMessage('Please configure your API key in Settings.');
      return;
    }

    isRunningRef.current = true;
    setPipelineState('recording');
    storeRef.current.setRecordingState('recording');
    storeRef.current.setStatusMessage('Listening...');

    // Log SpeechRecognition availability for debugging
    console.log('[Pipeline] SpeechRecognition available:', SpeechRecognitionService.isAvailable());

    // Start ASR (final results only, not continuous)
    const speechLang = SpeechRecognitionService.mapLanguage(src);
    console.log('[Pipeline] Starting push-to-talk ASR, language:', src, '→', speechLang);

    let resolved = false;
    const finalTextPromise = new Promise<string>((resolve) => {
      // Safety timeout: if nothing happens within 30s, resolve empty
      const timeout = setTimeout(() => {
        if (!resolved) { resolved = true; resolve(''); }
      }, 30_000);

      const safeResolve = (text: string) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          resolve(text);
        }
      };

      speechRecognitionService.start(
        speechLang,
        false, // continuous = false for push-to-talk
        false, // interimResults = false
        {
          onFinalResult: (text) => safeResolve(text),
          onError: (error) => {
            storeRef.current.setStatusMessage(error);
            safeResolve(''); // resolve empty on error to unblock
          },
          onEnd: () => {
            // If recognition ended without a result (e.g. no-speech was
            // silenced by some implementations), resolve empty to unblock
            safeResolve('');
          },
        },
      );
    });

    // Store the promise so stopConversation can await it
    (startConversation as any)._resultPromise = finalTextPromise;
  }, []);

  const stopConversation = useCallback(async () => {
    if (!isRunningRef.current) return;

    setPipelineState('recognizing');
    storeRef.current.setRecordingState('recognizing');
    storeRef.current.setStatusMessage('Recognizing...');

    // Stop ASR and get result
    speechRecognitionService.stop();

    const resultPromise: Promise<string> | undefined =
      (startConversation as any)._resultPromise;
    const recognizedText = resultPromise ? await resultPromise : '';

    if (!recognizedText.trim()) {
      setPipelineState('idle');
      storeRef.current.setRecordingState('idle');
      storeRef.current.setStatusMessage('');
      isRunningRef.current = false;
      return;
    }

    // Create message with original text
    const { sourceLanguage: src, targetLanguage: tgt } = settingsRef.current;
    const msgId = storeRef.current.addMessage({
      originalText: recognizedText,
      translatedText: '',
      sourceLanguage: src,
      targetLanguage: tgt,
      isRetranslated: false,
    });

    // Translate
    setPipelineState('translating');
    storeRef.current.setRecordingState('translating');
    storeRef.current.setStatusMessage('Translating...');

    try {
      const config = {
        apiKey: settingsRef.current.apiKey,
        apiBaseUrl: settingsRef.current.apiBaseUrl,
        model: settingsRef.current.model,
        temperature: settingsRef.current.temperature,
        maxTokens: settingsRef.current.maxTokens,
      };

      const translated = await translate(
        recognizedText,
        getLanguageName(src),
        getLanguageName(tgt),
        config,
      );

      storeRef.current.updateMessage(msgId, { translatedText: translated });

      // TTS: speak the translation
      setPipelineState('playing');
      storeRef.current.setRecordingState('playing');
      storeRef.current.setStatusMessage('Speaking...');

      try {
        await speechSynthesisService.speak(translated, tgt);
      } catch {
        // TTS failure is non-critical
      }
    } catch (err: unknown) {
      const errorMsg =
        err instanceof Error ? err.message : 'Translation failed';
      storeRef.current.updateMessage(msgId, {
        translatedText: '',
        error: errorMsg,
      });
      storeRef.current.setStatusMessage(errorMsg);
    }

    setPipelineState('idle');
    storeRef.current.setRecordingState('idle');
    storeRef.current.setStatusMessage('');
    isRunningRef.current = false;
  }, []);

  // --- Simultaneous mode (continuous) ---

  // We store the callbacks in a ref so auto-restart can access the latest
  // versions without stale closures.
  const simCallbacksRef = useRef<{
    onInterimResult: (text: string) => void;
    onFinalResult: (text: string) => Promise<void>;
    onError: (error: string) => void;
    onSpeechStart: () => void;
    onSpeechEnd: () => void;
    onEnd: () => void;
  } | null>(null);

  // --- Helper: process translation for a recognized text segment ---
  const processTranslation = useCallback(async (text: string) => {
    const { sourceLanguage: src, targetLanguage: tgt } = settingsRef.current;
    const config = {
      apiKey: settingsRef.current.apiKey,
      apiBaseUrl: settingsRef.current.apiBaseUrl,
      model: settingsRef.current.model,
      temperature: settingsRef.current.temperature,
      maxTokens: settingsRef.current.maxTokens,
    };
    return translate(text, getLanguageName(src), getLanguageName(tgt), config);
  }, []);

  const startSimultaneous = useCallback(async () => {
    if (isRunningRef.current) return;

    const {
      apiKey: key,
      sourceLanguage: src,
      audioSource: as,
      whisperApiKey: wk,
    } = settingsRef.current;

    if (!key) {
      storeRef.current.setStatusMessage('Please configure your API key in Settings.');
      return;
    }

    isRunningRef.current = true;
    setPipelineState('recording');
    storeRef.current.setRecordingState('recording');
    storeRef.current.setListening(true);

    // ── System Audio mode (utterance-driven, native ScreenCaptureKit on macOS) ──
    if (as === 'system_audio') {
      if (!wk) {
        storeRef.current.setStatusMessage(
          'Whisper API key is required for system audio. Set it in Settings > API.'
        );
        isRunningRef.current = false;
        setPipelineState('idle');
        storeRef.current.setRecordingState('idle');
        storeRef.current.setListening(false);
        return;
      }

      console.log('[Pipeline] Starting system audio capture (utterance mode)...');
      storeRef.current.setStatusMessage('Capturing system audio...');

      const useNative = await TauriSystemAudioCapture.isNativeAvailable();
      const useDirect = !!settingsRef.current.speechTranslateModel;

      // Translation context: maintains a sliding window of recent translations
      // to inject into each translation request for coherence.
      interface ContextEntry {
        original: string;
        translated: string;
      }
      const contextWindow: ContextEntry[] = [];
      const MAX_CONTEXT = 5;

      /**
       * Build a context string from recent translations for injection
       * into the translation prompt.
       */
      const buildContextPrompt = (): string => {
        if (contextWindow.length === 0) return '';
        const lines = contextWindow.map(
          (e, i) => `${i + 1}. "${e.original}" → "${e.translated}"`,
        );
        return (
          'Previous (already translated, for context only — do NOT re-translate):\n' +
          lines.join('\n') +
          '\n\nNow translate the following new text, maintaining consistency with the above:\n'
        );
      };

      /**
       * Process a single complete utterance:
       * ASR → build context → translate → create individual subtitle entry.
       */
      const handleUtterance = async (wavBlob: Blob) => {
        if (!isRunningRef.current) return;
        console.log('[Pipeline] Utterance:', wavBlob.size, 'bytes');

        storeRef.current.setStatusMessage('Transcribing...');

        try {
          if (useDirect) {
            // Direct speech→translation (multimodal model)
            const translatedText = await translateSpeech(wavBlob, {
              apiKey: settingsRef.current.whisperApiKey,
              apiBaseUrl: settingsRef.current.whisperApiBaseUrl,
              model: settingsRef.current.speechTranslateModel,
              sourceLanguage: settingsRef.current.sourceLanguage,
              targetLanguage: settingsRef.current.targetLanguage,
              history: contextWindow.map((e) => e.translated).slice(-8),
            });

            if (!translatedText.trim() || !isRunningRef.current) return;

            // Create an individual subtitle entry
            storeRef.current.addSubtitle({
              originalText: '',
              translatedText: translatedText.trim(),
              isFinal: true,
            });

            contextWindow.push({ original: '', translated: translatedText.trim() });
            if (contextWindow.length > MAX_CONTEXT) contextWindow.shift();

            storeRef.current.setStatusMessage('Listening...');
          } else {
            // Two-step: Whisper ASR → DeepSeek translation
            const whisperConfig = {
              apiKey: settingsRef.current.whisperApiKey,
              apiBaseUrl: settingsRef.current.whisperApiBaseUrl,
              model: settingsRef.current.whisperModel,
            };

            const originalText = await transcribeAudio(wavBlob, src, whisperConfig);
            if (!originalText.trim() || !isRunningRef.current) return;

            // Create subtitle entry with original text immediately
            const subId = storeRef.current.addSubtitle({
              originalText: originalText.trim(),
              translatedText: '',
              isFinal: false,
            });

            storeRef.current.setStatusMessage('Translating...');

            // Build translation with context
            const contextPrefix = buildContextPrompt();
            const textToTranslate = contextPrefix
              ? contextPrefix + originalText.trim()
              : originalText.trim();

            const config = {
              apiKey: settingsRef.current.apiKey,
              apiBaseUrl: settingsRef.current.apiBaseUrl,
              model: settingsRef.current.model,
              temperature: settingsRef.current.temperature,
              maxTokens: settingsRef.current.maxTokens,
            };

            const { sourceLanguage: srcLang, targetLanguage: tgtLang } = settingsRef.current;
            const translatedText = await translate(
              textToTranslate,
              getLanguageName(srcLang),
              getLanguageName(tgtLang),
              config,
            );

            if (!isRunningRef.current) return;

            // Update the subtitle with translation
            storeRef.current.updateSubtitle(subId, {
              translatedText: translatedText.trim(),
              isFinal: true,
            });

            // Add to context window
            contextWindow.push({
              original: originalText.trim(),
              translated: translatedText.trim(),
            });
            if (contextWindow.length > MAX_CONTEXT) contextWindow.shift();

            storeRef.current.setStatusMessage('Listening...');
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Processing error';
          storeRef.current.setStatusMessage(msg);
          console.error('[Pipeline] Utterance error:', msg);
        }
      };

      if (useNative) {
        console.log('[Pipeline] Using native utterance-driven capture (ScreenCaptureKit)');
        tauriSystemAudioCapture.start(handleUtterance).catch((err: unknown) => {
          storeRef.current.setStatusMessage(String(err));
          isRunningRef.current = false;
          setPipelineState('idle');
          storeRef.current.setRecordingState('idle');
          storeRef.current.setListening(false);
        });
      } else {
        // Browser fallback: use getDisplayMedia with 5s chunks
        // Wrap each chunk as if it were an utterance
        console.log('[Pipeline] Using browser fallback:', SystemAudioCapture.getDiagnostics());
        const unsubSilence = systemAudioCapture.onStateChange((state) => {
          if (state.silenceWarning && isRunningRef.current) {
            storeRef.current.setStatusMessage(state.silenceWarning);
          }
        });
        (startSimultaneous as any)._unsubSilence = unsubSilence;
        systemAudioCapture.start((blob: Blob) => handleUtterance(blob)).catch((err: unknown) => {
          storeRef.current.setStatusMessage(String(err));
          isRunningRef.current = false;
          setPipelineState('idle');
          storeRef.current.setRecordingState('idle');
          storeRef.current.setListening(false);
        });
      }

      return;
    }

    // ── Microphone mode (Web Speech API) ──
    console.log('[Pipeline] Starting microphone simultaneous mode, language:', src);
    storeRef.current.setStatusMessage('Simultaneous mode active');

    const speechLang = SpeechRecognitionService.mapLanguage(src);
    let pendingInterimId: string | null = null;

    const startRecognition = () => {
      if (!isRunningRef.current) return;

      speechRecognitionService.start(
        speechLang,
        true, true,
        {
          onInterimResult: simCallbacksRef.current!.onInterimResult,
          onFinalResult: simCallbacksRef.current!.onFinalResult,
          onError: simCallbacksRef.current!.onError,
          onSpeechStart: simCallbacksRef.current!.onSpeechStart,
          onSpeechEnd: simCallbacksRef.current!.onSpeechEnd,
          onEnd: simCallbacksRef.current!.onEnd,
        },
      );
    };

    simCallbacksRef.current = {
      onInterimResult: (text: string) => {
        if (pendingInterimId) {
          storeRef.current.removeSubtitle(pendingInterimId);
        }
        pendingInterimId = storeRef.current.addSubtitle({
          originalText: text,
          translatedText: '',
          isFinal: false,
        });
      },

      onFinalResult: async (text: string) => {
        if (pendingInterimId) {
          storeRef.current.removeSubtitle(pendingInterimId);
          pendingInterimId = null;
        }
        const subId = storeRef.current.addSubtitle({
          originalText: text,
          translatedText: '',
          isFinal: true,
        });
        try {
          const translatedText = await processTranslation(text);
          storeRef.current.updateSubtitle(subId, {
            translatedText: translatedText,
          });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Translation failed';
          storeRef.current.setStatusMessage(msg);
        }
      },

      onError: (error: string) => {
        storeRef.current.setStatusMessage(error);
      },

      onSpeechStart: () => {
        storeRef.current.setStatusMessage('Speech detected...');
      },

      onSpeechEnd: () => {
        if (isRunningRef.current) {
          storeRef.current.setStatusMessage('Listening...');
        }
      },

      onEnd: () => {
        if (isRunningRef.current) {
          setTimeout(() => startRecognition(), 300);
        }
      },
    };

    startRecognition();
  }, [processTranslation]);

  const stopSimultaneous = useCallback(() => {
    console.log('[Pipeline] stopSimultaneous called');
    isRunningRef.current = false;
    speechRecognitionService.stop();
    systemAudioCapture.stop();
    tauriSystemAudioCapture.stop();
    speechSynthesisService.cancel();

    // Unsubscribe from silence monitoring if active
    const unsubSilence: (() => void) | undefined =
      (startSimultaneous as any)._unsubSilence;
    if (unsubSilence) {
      unsubSilence();
      delete (startSimultaneous as any)._unsubSilence;
    }

    setPipelineState('idle');
    storeRef.current.setRecordingState('idle');
    storeRef.current.setListening(false);
    storeRef.current.setStatusMessage('Simultaneous mode paused');
  }, [startSimultaneous]);

  // --- Cleanup ---

  const cancel = useCallback(() => {
    isRunningRef.current = false;
    speechRecognitionService.abort();
    speechSynthesisService.cancel();
    audioCapture.cancel();
    setPipelineState('idle');
    storeRef.current.setRecordingState('idle');
    storeRef.current.setListening(false);
    storeRef.current.setStatusMessage('');
  }, []);

  return {
    /** Current pipeline stage (idle → recording → recognizing → translating → playing). */
    pipelineState,
    /** Start push-to-talk recording. */
    startConversation,
    /** Stop push-to-talk recording and process through ASR → translation → TTS. */
    stopConversation,
    /** Start continuous simultaneous interpretation. */
    startSimultaneous,
    /** Stop continuous simultaneous interpretation. */
    stopSimultaneous,
    /** Cancel any in-progress pipeline operation. */
    cancel,
    /** Whether the pipeline is currently active. */
    isActive: pipelineState !== 'idle',
  } as const;
}
