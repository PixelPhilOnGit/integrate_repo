/**
 * Direct speech-to-translation using multimodal LLM (e.g., Qwen3-Omni).
 *
 * Skips the separate transcription (Whisper) and translation (DeepSeek) steps.
 * Audio WAV is sent directly to a multimodal model that understands speech
 * and outputs translated text in a single API call.
 *
 * Supported backends:
 * - SiliconFlow: Qwen/Qwen3-Omni-30B-A3B-Instruct
 * - OpenAI: gpt-4o-audio-preview (if accessible)
 *
 * @module speechTranslationService
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SpeechTranslationConfig {
  apiKey: string;
  apiBaseUrl: string;
  model: string;
  sourceLanguage: string;
  targetLanguage: string;
  /** Recent translation history for context (max 10 entries). */
  history?: string[];
}

// ---------------------------------------------------------------------------
// Blob → base64
// ---------------------------------------------------------------------------

async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      // Strip the "data:..." prefix
      const base64 = result.split(',')[1] ?? result;
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// ---------------------------------------------------------------------------
// API call
// ---------------------------------------------------------------------------

/**
 * Translate speech audio directly to text in the target language.
 *
 * @param audioBlob - WAV audio blob (16kHz mono recommended).
 * @param config - API configuration.
 * @returns Translated text in the target language.
 */
export async function translateSpeech(
  audioBlob: Blob,
  config: SpeechTranslationConfig,
): Promise<string> {
  if (!config.apiKey) {
    throw new Error('API key is not configured.');
  }

  const base64Audio = await blobToBase64(audioBlob);

  const targetLangName =
    config.targetLanguage === 'zh-CN' ? 'Chinese' :
    config.targetLanguage === 'en-US' ? 'English' :
    config.targetLanguage === 'ja-JP' ? 'Japanese' :
    config.targetLanguage;

  // Build prompt with optional history for context
  let prompt =
    `You are a real-time speech translator. Translate this audio clip into natural ${targetLangName}.\n` +
    `Rules:\n` +
    `- Transcribe and translate EVERYTHING you hear, sentence by sentence.\n` +
    `- Output complete sentences, not fragments or summaries.\n` +
    `- If there's no speech, output an empty string.\n`;

  if (config.history && config.history.length > 0) {
    const recent = config.history.slice(-8);
    prompt += `\nRecent translations (for context — do NOT repeat, build on them):\n`;
    for (const h of recent) {
      prompt += `- ${h}\n`;
    }
    prompt += `\nContinue translating. The new audio comes right after the last line above.\n`;
  }

  prompt += `\nOutput: just the translated text. No labels, no prefixes.`;

  const response = await fetch(
    `${config.apiBaseUrl.replace(/\/+$/, '')}/chat/completions`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              {
                type: 'input_audio',
                input_audio: {
                  data: base64Audio,
                  format: 'wav',
                },
              },
            ],
          },
        ],
        max_tokens: 1024,
        temperature: 0.1,
      }),
    },
  );

  if (!response.ok) {
    const status = response.status;
    const detail = await response.text().catch(() => '');
    if (status === 401 || status === 403) {
      throw new Error('Speech translation API authentication failed.');
    }
    throw new Error(
      `Speech translation API error (HTTP ${status}): ${detail.slice(0, 300)}`,
    );
  }

  const data = await response.json();
  const text: string =
    data.choices?.[0]?.message?.content ?? '';

  return text.trim();
}
