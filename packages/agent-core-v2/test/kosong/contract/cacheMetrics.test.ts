/**
 * Scenario: prompt-cache ratio helpers used by step/turn/compaction telemetry.
 *
 * Responsibilities: assert hit ratio and miss token math against real TokenUsage.
 * Wiring: pure functions only. Run:
 * vitest run test/kosong/contract/cacheMetrics.test.ts
 */
import { describe, expect, it } from 'vitest';

import {
  cacheHitRatio,
  cacheMissInputTokens,
  cacheUsageTelemetryFields,
  type TokenUsage,
} from '#/kosong/contract/usage';

function usage(partial: Partial<TokenUsage>): TokenUsage {
  return {
    inputOther: 0,
    output: 0,
    inputCacheRead: 0,
    inputCacheCreation: 0,
    ...partial,
  };
}

describe('cacheMetrics', () => {
  it('computes cache hit ratio and miss input from TokenUsage', () => {
    const u = usage({
      inputCacheRead: 900,
      inputOther: 80,
      inputCacheCreation: 20,
      output: 50,
    });
    expect(cacheHitRatio(u)).toBeCloseTo(0.9, 5);
    expect(cacheMissInputTokens(u)).toBe(100);
    expect(cacheUsageTelemetryFields(u)).toEqual({
      input_cache_read: 900,
      input_cache_creation: 20,
      input_other: 80,
      input_tokens: 1000,
      cache_hit_ratio: 0.9,
    });
  });

  it('returns 0 hit ratio when there is no input', () => {
    expect(cacheHitRatio(usage({ output: 10 }))).toBe(0);
    expect(cacheUsageTelemetryFields(usage({})).cache_hit_ratio).toBe(0);
  });
});
