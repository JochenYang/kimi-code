/**
 * Prompt-cache metrics derived from `TokenUsage`.
 *
 * Providers report cache-read / cache-creation / other input tokens; these
 * helpers turn that breakdown into stable ratios and telemetry-friendly
 * fields without depending on any agent domain.
 */

import type { TokenUsage } from './usage';
import { inputTotal } from './usage';

/** Cache hit ratio in [0, 1]. Returns 0 when there is no input. */
export function cacheHitRatio(usage: TokenUsage): number {
  const total = inputTotal(usage);
  if (total <= 0) return 0;
  return usage.inputCacheRead / total;
}

/** Input tokens that were not served from the prompt cache. */
export function cacheMissInputTokens(usage: TokenUsage): number {
  return usage.inputOther + usage.inputCacheCreation;
}

/**
 * Telemetry-friendly cache fields for a single generation / aggregated turn.
 * Ratios are rounded to 4 decimal places so float noise does not thrash sinks.
 */
export function cacheUsageTelemetryFields(usage: TokenUsage): {
  readonly input_cache_read: number;
  readonly input_cache_creation: number;
  readonly input_other: number;
  readonly input_tokens: number;
  readonly cache_hit_ratio: number;
} {
  const input_tokens = inputTotal(usage);
  return {
    input_cache_read: usage.inputCacheRead,
    input_cache_creation: usage.inputCacheCreation,
    input_other: usage.inputOther,
    input_tokens,
    cache_hit_ratio: roundRatio(cacheHitRatio(usage)),
  };
}

function roundRatio(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
