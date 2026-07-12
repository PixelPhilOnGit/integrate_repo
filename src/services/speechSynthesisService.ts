/**
 * Text-to-speech service wrapping the browser Web Speech Synthesis API.
 *
 * Provides voice selection by language and returns a Promise that resolves
 * when speech completes, making it easy to chain in the translation pipeline.
 *
 * API reference: https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesis
 *
 * @module speechSynthesisService
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Map a BCP-47 language tag to a Web Speech API voice language string.
 */
function mapToVoiceLang(bcp47: string): string {
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

/**
 * Find the best matching voice for a given language.
 */
function findVoice(voiceLang: string): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis.getVoices();

  const exact = voices.find((v) => v.lang === voiceLang);
  if (exact) return exact;

  const prefix = voices.find((v) => v.lang.startsWith(voiceLang));
  if (prefix) return prefix;

  const langPrefix = voiceLang.split('-')[0];
  const broad = voices.find((v) => v.lang.startsWith(langPrefix));
  if (broad) return broad;

  return voices[0] ?? null;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class SpeechSynthesisService {
  private _isSpeaking = false;

  /**
   * Speak text in the given language.
   *
   * @returns A Promise that resolves when speech completes.
   */
  speak(text: string, language: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!text.trim()) {
        resolve();
        return;
      }

      this.cancel();

      const synth = window.speechSynthesis;
      const utterance = new SpeechSynthesisUtterance(text);
      const voiceLang = mapToVoiceLang(language);

      const trySpeak = () => {
        const voice = findVoice(voiceLang);
        if (voice) {
          utterance.voice = voice;
        }
        utterance.lang = voiceLang;
        utterance.rate = 1.0;
        utterance.pitch = 1.0;
        utterance.volume = 1.0;

        utterance.onstart = () => {
          this._isSpeaking = true;
        };

        utterance.onend = () => {
          this._isSpeaking = false;
          resolve();
        };

        utterance.onerror = (event) => {
          this._isSpeaking = false;
          if (event.error === 'canceled' || event.error === 'interrupted') {
            resolve();
            return;
          }
          reject(new Error(`Speech synthesis error: ${event.error}`));
        };

        synth.speak(utterance);
      };

      if (synth.getVoices().length === 0) {
        const onVoicesChanged = () => {
          synth.removeEventListener('voiceschanged', onVoicesChanged);
          trySpeak();
        };
        synth.addEventListener('voiceschanged', onVoicesChanged);
      } else {
        trySpeak();
      }
    });
  }

  /** Cancel any active speech. */
  cancel(): void {
    window.speechSynthesis.cancel();
    this._isSpeaking = false;
  }

  get isSpeaking(): boolean {
    return this._isSpeaking;
  }

  static isAvailable(): boolean {
    return 'speechSynthesis' in window;
  }
}

/** Singleton instance shared across the app. */
export const speechSynthesisService = new SpeechSynthesisService();
