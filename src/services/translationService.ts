/**
 * DeepSeek-powered translation service.
 *
 * Provides a translation function that calls the OpenAI-compatible chat
 * completions endpoint with a strict system prompt, retry logic, request
 * deduplication, token estimation, and usage event emission.
 *
 * @module translationService
 */

import type { TranslationConfig } from '@/types';
import { DEEPSEEK_PRICING } from '@/constants/languages';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UsageEventPayload {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost: number;
  timestamp: number;
}

type UsageListener = (event: UsageEventPayload) => void;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of retry attempts on failure */
const MAX_RETRIES = 3;

/** Base delay in ms for exponential backoff */
const BASE_RETRY_DELAY_MS = 1_000;

/** Deduplication window in ms — repeated text within this window is skipped */
const DEDUP_WINDOW_MS = 5_000;

/** Factor used for token estimation (char-to-token ratio for Chinese text) */
const TOKEN_ESTIMATION_FACTOR = 2;

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

/** Tracks in-flight requests for deduplication */
const pendingCache = new Map<string, { promise: Promise<string>; timestamp: number }>();

/** Registered usage event listeners */
const usageListeners = new Set<UsageListener>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Estimate the number of tokens in a text string.
 * Uses a rough heuristic: text.length / 2 (appropriate for mixed CJK/Latin).
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / TOKEN_ESTIMATION_FACTOR);
}

/**
 * Build the deduplication key for a translation request.
 */
function buildCacheKey(text: string, source: string, target: string): string {
  return `${source}|${target}|${text}`;
}

/**
 * Build the system prompt used for translation.
 *
 * Optimized for spoken/subtitle content: emphasizes natural conversational
 * flow, conciseness (subtitles have limited display time), and tone preservation.
 */
function buildSystemPrompt(source: string, target: string): string {
  return (
    `You are a professional subtitle translator for video and spoken content. ` +
    `Translate the following from ${source} to ${target}. ` +
    'Rules:\n' +
    '- Output natural, conversational ' + target + ' suitable for subtitles.\n' +
    '- Keep it concise — subtitles have limited display time.\n' +
    '- Preserve the speaker\'s tone, intent, and emotion.\n' +
    '- If the input is an incomplete sentence, complete it naturally based on context.\n' +
    '- NEVER output explanations, notes, or multiple translation alternatives.\n' +
    '- Output ONLY the translated text, nothing else.'
  );
}

/**
 * Calculate the cost of a single API call based on token usage.
 */
function calculateCost(promptTokens: number, completionTokens: number): number {
  const inputCost = (promptTokens / 1_000_000) * DEEPSEEK_PRICING.inputPerMillion;
  const outputCost = (completionTokens / 1_000_000) * DEEPSEEK_PRICING.outputPerMillion;
  return inputCost + outputCost;
}

// ---------------------------------------------------------------------------
// API call
// ---------------------------------------------------------------------------

/**
 * Send a single translation request to the DeepSeek API.
 *
 * @throws If the network is offline or the API returns a non-2xx status.
 */
async function callTranslateAPI(
  text: string,
  sourceLang: string,
  targetLang: string,
  config: TranslationConfig,
): Promise<string> {
  // Check connectivity before making the request
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    throw new Error('Network is offline. Please check your internet connection.');
  }

  const url = `${config.apiBaseUrl.replace(/\/+$/, '')}/chat/completions`;
  const systemPrompt = buildSystemPrompt(sourceLang, targetLang);
  const estimatedPromptTokens = estimateTokens(systemPrompt + text);

  const body = JSON.stringify({
    model: config.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: text },
    ],
    temperature: config.temperature,
    max_tokens: config.maxTokens,
    stream: false,
  });

  let response: Response;

  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body,
    });
  } catch (fetchError: unknown) {
    if (fetchError instanceof TypeError && fetchError.message === 'Failed to fetch') {
      throw new Error(
        'Unable to reach the translation server. ' +
        'Please check your network connection and API endpoint URL.',
      );
    }
    throw fetchError;
  }

  if (!response.ok) {
    let errorBody = '';
    try {
      errorBody = await response.text();
    } catch {
      // Ignore parse failures in error path
    }

    const status = response.status;
    if (status === 401 || status === 403) {
      throw new Error(
        'Authentication failed (HTTP ' + status + '). ' +
        'Please check your API key in Settings.',
      );
    }
    if (status === 429) {
      throw new Error(
        'Rate limit exceeded. Please wait a moment before trying again.',
      );
    }
    if (status >= 500) {
      throw new Error(
        'Translation server error (HTTP ' + status + '). ' +
        'Please try again later.',
      );
    }

    throw new Error(
      'Translation request failed (HTTP ' + status + '): ' +
      errorBody.slice(0, 200),
    );
  }

  const data = await response.json();

  // Extract response text
  const translatedText: string | undefined =
    data.choices?.[0]?.message?.content;

  if (!translatedText) {
    throw new Error('Unexpected API response format: no translation content found.');
  }

  // Emit usage event
  const promptTokens = data.usage?.prompt_tokens ?? estimatedPromptTokens;
  const completionTokens = data.usage?.completion_tokens ?? estimateTokens(translatedText);
  const totalTokens = promptTokens + completionTokens;
  const cost = calculateCost(promptTokens, completionTokens);

  emitUsage({
    promptTokens,
    completionTokens,
    totalTokens,
    cost,
    timestamp: Date.now(),
  });

  return translatedText.trim();
}

// ---------------------------------------------------------------------------
// Retry wrapper
// ---------------------------------------------------------------------------

/**
 * Call the API with exponential-backoff retry logic.
 */
async function withRetry(
  fn: () => Promise<string>,
  attempt = 0,
): Promise<string> {
  try {
    return await fn();
  } catch (error) {
    if (attempt >= MAX_RETRIES - 1) {
      throw error;
    }
    const delay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
    await new Promise((resolve) => setTimeout(resolve, delay));
    return withRetry(fn, attempt + 1);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Translate a text string from source language to target language.
 *
 * Deduplicates identical requests made within a 5-second window.
 * Retries up to 3 times with exponential backoff on failure.
 *
 * @param text - The text to translate.
 * @param sourceLang - Source language display name (e.g. "Chinese (Simplified)").
 * @param targetLang - Target language display name (e.g. "English").
 * @param config - API configuration (key, endpoint, model, etc.).
 * @returns The translated text.
 * @throws If all retries fail or the request deduplication detects an error.
 */
export async function translate(
  text: string,
  sourceLang: string,
  targetLang: string,
  config: TranslationConfig,
): Promise<string> {
  if (!text.trim()) {
    return '';
  }

  if (!config.apiKey) {
    throw new Error('API key is not configured. Please set your API key in Settings.');
  }

  const cacheKey = buildCacheKey(text, sourceLang, targetLang);
  const now = Date.now();

  // Deduplication: return the in-flight promise if the same request was made recently
  const cached = pendingCache.get(cacheKey);
  if (cached && now - cached.timestamp < DEDUP_WINDOW_MS) {
    return cached.promise;
  }

  const promise = withRetry(() =>
    callTranslateAPI(text, sourceLang, targetLang, config),
  );

  pendingCache.set(cacheKey, { promise, timestamp: now });

  // Clean up cache entry after resolution
  promise
    .catch(() => {
      /* error is propagated to the caller */
    })
    .finally(() => {
      // Remove only if this exact entry is still the current one
      if (pendingCache.get(cacheKey)?.promise === promise) {
        pendingCache.delete(cacheKey);
      }
    });

  return promise;
}

/**
 * Test that the API connection is working by sending a minimal request.
 *
 * @param config - API configuration.
 * @returns `true` if the connection is valid, `false` otherwise.
 */
export async function testConnection(config: TranslationConfig): Promise<boolean> {
  if (!config.apiKey) {
    return false;
  }

  try {
    await callTranslateAPI('Hello', 'English', 'Chinese (Simplified)', config);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Usage event system
// ---------------------------------------------------------------------------

/**
 * Register a listener for usage events emitted after each translation.
 *
 * @param listener - Callback receiving usage event payloads.
 * @returns An unsubscribe function.
 */
export function onUsage(listener: UsageListener): () => void {
  usageListeners.add(listener);
  return () => {
    usageListeners.delete(listener);
  };
}

/**
 * Emit a usage event to all registered listeners.
 */
function emitUsage(event: UsageEventPayload): void {
  for (const listener of usageListeners) {
    try {
      listener(event);
    } catch {
      // Isolate listener failures so one bad listener doesn't break others
    }
  }
}

/**
 * Remove a previously registered usage listener.
 */
export function offUsage(listener: UsageListener): void {
  usageListeners.delete(listener);
}

/**
 * Clear the in-flight request deduplication cache.
 */
export function clearCache(): void {
  pendingCache.clear();
}
