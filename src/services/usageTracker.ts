/**
 * API usage tracker — records token usage and cost into localStorage.
 *
 * This module tracks every translation API call so the user can monitor
 * their DeepSeek usage and costs. Data is stored locally as JSON;
 * no sensitive information (API keys) is persisted here.
 *
 * @module usageTracker
 */

import type { UsageStats } from '@/types';
import { DEEPSEEK_PRICING, STORAGE_KEYS } from '@/constants/languages';

// ---------------------------------------------------------------------------
// Key helpers
// ---------------------------------------------------------------------------

/** Format a Date to YYYY-MM-DD for daily stats keys */
function dateKey(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// ---------------------------------------------------------------------------
// Default stats
// ---------------------------------------------------------------------------

function createDefaultStats(): UsageStats {
  return {
    totalTokens: 0,
    totalCost: 0,
    requestCount: 0,
    lastResetDate: dateKey(),
    dailyStats: {},
  };
}

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

/**
 * Load usage stats from localStorage.
 * Returns default stats if no data is found or the stored data is corrupted.
 */
function loadStats(): UsageStats {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.USAGE_STATS);
    if (!raw) {
      return createDefaultStats();
    }
    const parsed = JSON.parse(raw) as UsageStats;

    // Validate critical fields
    if (
      typeof parsed.totalTokens !== 'number' ||
      typeof parsed.totalCost !== 'number' ||
      typeof parsed.requestCount !== 'number'
    ) {
      return createDefaultStats();
    }

    return parsed;
  } catch {
    // Corrupted data — start fresh
    return createDefaultStats();
  }
}

/**
 * Persist usage stats to localStorage.
 */
function saveStats(stats: UsageStats): void {
  try {
    localStorage.setItem(STORAGE_KEYS.USAGE_STATS, JSON.stringify(stats));
  } catch {
    // localStorage might be full or disabled — fail silently.
    // The user will lose tracking for this session only.
    console.warn('[usageTracker] Failed to persist usage stats to localStorage.');
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Record token usage from a translation API call.
 *
 * Updates the running totals as well as the daily breakdown for today.
 *
 * @param promptTokens - Number of input tokens consumed.
 * @param completionTokens - Number of output tokens generated.
 */
export function recordUsage(promptTokens: number, completionTokens: number): void {
  const stats = loadStats();
  const today = dateKey();

  const inputCost = (promptTokens / 1_000_000) * DEEPSEEK_PRICING.inputPerMillion;
  const outputCost = (completionTokens / 1_000_000) * DEEPSEEK_PRICING.outputPerMillion;
  const totalCost = inputCost + outputCost;
  const totalTokens = promptTokens + completionTokens;

  // Update daily stats
  const daily = stats.dailyStats[today] ?? { tokens: 0, cost: 0 };
  daily.tokens += totalTokens;
  daily.cost += totalCost;
  stats.dailyStats[today] = daily;

  // Update running totals
  stats.totalTokens += totalTokens;
  stats.totalCost += totalCost;
  stats.requestCount += 1;

  saveStats(stats);
}

/**
 * Retrieve the current usage statistics.
 *
 * @returns A snapshot of all accumulated usage stats.
 */
export function getUsageStats(): UsageStats {
  return loadStats();
}

/**
 * Reset all usage statistics to zero.
 *
 * This clears the running totals, daily breakdown, and sets the
 * last-reset date to today.
 */
export function resetStats(): void {
  saveStats(createDefaultStats());
}

/**
 * Export the current usage stats as a formatted JSON string.
 *
 * Useful for debugging or manual export.
 */
export function exportStatsAsJson(): string {
  const stats = loadStats();
  return JSON.stringify(stats, null, 2);
}
