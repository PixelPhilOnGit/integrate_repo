/**
 * Whisper API transcription service.
 *
 * Sends audio chunks to an OpenAI-compatible /audio/transcriptions endpoint
 * for speech-to-text conversion. Used as the ASR backend for system audio
 * capture mode (when the browser SpeechRecognition API cannot access
 * system audio).
 *
 * Requires a Whisper-compatible API key (OpenAI or proxy). The API base URL
 * and key are configured separately from the translation API settings.
 *
 * @module whisperService
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WhisperConfig {
  apiKey: string;
  apiBaseUrl: string;
  model?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum audio size in bytes (25 MB) — larger files are rejected. */
const MAX_AUDIO_SIZE_BYTES = 25 * 1024 * 1024;

/** Request timeout in ms. */
const REQUEST_TIMEOUT_MS = 30_000;

/** Maximum retries on timeout or server error. */
const MAX_RETRIES = 2;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Fetch with timeout support.
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// API call
// ---------------------------------------------------------------------------

/**
 * Transcribe an audio blob using a Whisper-compatible API.
 *
 * @param audioBlob - The recorded audio (webm/opus or wav).
 * @param language - BCP-47 language hint (e.g. "en" for English).
 * @param config - API key and base URL.
 * @returns The transcribed text.
 */
export async function transcribeAudio(
  audioBlob: Blob,
  language: string,
  config: WhisperConfig,
): Promise<string> {
  if (!config.apiKey) {
    throw new Error('Whisper API key is not configured. Please set it in Settings > API.');
  }

  if (audioBlob.size > MAX_AUDIO_SIZE_BYTES) {
    throw new Error(
      `Audio too large (${(audioBlob.size / 1024 / 1024).toFixed(1)} MB). ` +
      `Maximum is ${MAX_AUDIO_SIZE_BYTES / 1024 / 1024} MB.`
    );
  }

  if (audioBlob.size < 100) {
    // Too small to contain meaningful audio — likely empty
    return '';
  }

  const url = `${config.apiBaseUrl.replace(/\/+$/, '')}/audio/transcriptions`;

  // Build multipart form data
  const formData = new FormData();

  // Use correct extension based on actual blob type (wav vs webm)
  const ext = audioBlob.type.includes('wav') ? 'wav' : 'webm';
  formData.append('file', audioBlob, `audio.${ext}`);
  formData.append('model', config.model || 'whisper-1');
  // Strip region subtag: "en-US" → "en", "zh-CN" → "zh"
  formData.append('language', language.split('-')[0]);
  formData.append('response_format', 'json');

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetchWithTimeout(
        url,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
          },
          body: formData,
        },
        REQUEST_TIMEOUT_MS,
      );

      if (!response.ok) {
        const status = response.status;
        if (status === 401 || status === 403) {
          throw new Error(
            'Whisper API authentication failed. Please check your Whisper API key in Settings.'
          );
        }
        if (status === 429) {
          throw new Error('Whisper API rate limit exceeded. Please wait and try again.');
        }
        let detail = '';
        try {
          detail = await response.text();
        } catch { /* ignore */ }
        throw new Error(`Whisper API error (HTTP ${status}): ${detail.slice(0, 500)}`);
      }

      const data = await response.json();

      if (!data.text || typeof data.text !== 'string') {
        throw new Error('Unexpected Whisper API response format.');
      }

      return data.text.trim();
    } catch (err: unknown) {
      lastError = err instanceof Error ? err : new Error(String(err));

      // Don't retry auth errors or client errors
      if (lastError.message.includes('authentication') || lastError.message.includes('API key')) {
        throw lastError;
      }

      // Retry on timeout or server errors
      if (attempt < MAX_RETRIES) {
        const delay = 1000 * Math.pow(2, attempt);
        console.warn(`[Whisper] Retry ${attempt + 1}/${MAX_RETRIES} after ${delay}ms:`, lastError.message);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
    }
  }

  throw lastError || new Error('Whisper transcription failed after retries.');
}
