/**
 * Speech recognition service wrapping the browser Web Speech API.
 *
 * Provides real-time speech-to-text with interim results for simultaneous
 * interpretation mode, and final results for conversation mode. Falls
 * back gracefully when the API is unavailable.
 *
 * API reference: https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition
 *
 * @module speechRecognitionService
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RecognitionCallbacks {
  /** Called with interim (non-final) results — useful for live subtitles. */
  onInterimResult?: (text: string) => void;
  /** Called when a final recognition result is available. */
  onFinalResult?: (text: string, confidence: number) => void;
  /** Called when recognition ends (naturally or manually). */
  onEnd?: () => void;
  /** Called on recognition errors. */
  onError?: (error: string) => void;
  /** Called when speech start is detected. */
  onSpeechStart?: () => void;
  /** Called when speech end is detected. */
  onSpeechEnd?: () => void;
}

export interface RecognitionState {
  isListening: boolean;
  error: string | null;
  available: boolean;
}

// ---------------------------------------------------------------------------
// Browser API type declarations
// ---------------------------------------------------------------------------

// Web Speech API types are not included in all TypeScript targets
interface SpeechRecognitionEvent extends Event {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultList;
}

interface SpeechRecognitionResultList {
  readonly length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  item(index: number): SpeechRecognitionAlternative;
  [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionAlternative {
  readonly transcript: string;
  readonly confidence: number;
}

interface SpeechRecognitionErrorEvent extends Event {
  readonly error: string;
  readonly message: string;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const SpeechRecognitionAPI =
  (window as any).SpeechRecognition ||
  (window as any).webkitSpeechRecognition;

export class SpeechRecognitionService {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private recognition: any = null;
  private _isListening = false;

  /** Check whether the Web Speech API is available in this environment. */
  static isAvailable(): boolean {
    return !!SpeechRecognitionAPI;
  }

  /**
   * Start listening for speech.
   *
   * @param language - BCP-47 language tag (e.g. "zh-CN", "en-US").
   * @param continuous - When true, recognition continues after a pause.
   * @param interimResults - When true, interim results are emitted as the user speaks.
   * @param callbacks - Event callbacks for results, errors, and lifecycle events.
   */
  start(
    language: string,
    continuous: boolean,
    interimResults: boolean,
    callbacks: RecognitionCallbacks,
  ): void {
    if (!SpeechRecognitionAPI) {
      callbacks.onError?.('Speech recognition is not supported in this browser.');
      return;
    }

    // If already listening, stop first
    this.stop();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const recognition = new SpeechRecognitionAPI() as any;
    this.recognition = recognition;

    recognition.lang = language;
    recognition.continuous = continuous;
    recognition.interimResults = interimResults;
    recognition.maxAlternatives = 1;

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      // Process results in order
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const alternative = result[0];
        const transcript = alternative.transcript.trim();
        const confidence = alternative.confidence;

        if (!transcript) continue;

        if (result.isFinal) {
          callbacks.onFinalResult?.(transcript, confidence);
        } else {
          callbacks.onInterimResult?.(transcript);
        }
      }
    };

    recognition.onspeechstart = () => {
      callbacks.onSpeechStart?.();
    };

    recognition.onspeechend = () => {
      callbacks.onSpeechEnd?.();
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      // "no-speech" and "aborted" are normal lifecycle events, not fatal errors.
      // But we still need to notify the caller so promises don't hang.
      if (event.error === 'no-speech') {
        callbacks.onError?.('No speech detected. Please try again.');
        return;
      }
      if (event.error === 'aborted') {
        callbacks.onError?.('Speech recognition aborted.');
        return;
      }
      const message =
        event.error === 'not-allowed'
          ? 'Microphone access denied for speech recognition.'
          : event.error === 'network'
            ? 'Speech recognition requires a network connection.'
            : `Speech recognition error: ${event.message || event.error}`;
      callbacks.onError?.(message);
    };

    recognition.onend = () => {
      this._isListening = false;
      callbacks.onEnd?.();

      // Auto-restart for continuous mode if we weren't intentionally stopped
      if (continuous && this._isListening === false && this.recognition === recognition) {
        // Only restart if we're still supposed to be listening
        // (continuous mode gets restarted by the orchestrator)
      }
    };

    try {
      recognition.start();
      this._isListening = true;
    } catch (err: unknown) {
      callbacks.onError?.(`Failed to start speech recognition: ${String(err)}`);
    }
  }

  /** Stop listening for speech. */
  stop(): void {
    if (this.recognition) {
      try {
        this.recognition.stop();
      } catch {
        // May already be stopped
      }
      this.recognition = null;
    }
    this._isListening = false;
  }

  /** Abort (cancel) speech recognition immediately. */
  abort(): void {
    if (this.recognition) {
      try {
        this.recognition.abort();
      } catch {
        // May already be stopped
      }
      this.recognition = null;
    }
    this._isListening = false;
  }

  /** Whether recognition is currently active. */
  get isListening(): boolean {
    return this._isListening;
  }

  /**
   * Map a BCP-47 language tag to a Web Speech API compatible language string.
   * Falls back to "en-US" if the language is not recognized.
   */
  static mapLanguage(bcp47: string): string {
    // Web Speech API uses slightly different codes for some languages
    const mapping: Record<string, string> = {
      'zh-CN': 'zh-CN',
      'en-US': 'en-US',
      'ja-JP': 'ja-JP',
      'ko-KR': 'ko-KR',
      'fr-FR': 'fr-FR',
      'de-DE': 'de-DE',
      'es-ES': 'es-ES',
      'pt-BR': 'pt-BR',
      'ru-RU': 'ru-RU',
      'ar-SA': 'ar-SA',
      'th-TH': 'th-TH',
      'vi-VN': 'vi-VN',
    };
    return mapping[bcp47] || 'en-US';
  }
}

/** Singleton instance shared across the app. */
export const speechRecognitionService = new SpeechRecognitionService();
