/**
 * Scenario: EMA calibration of heuristic token estimates vs measured usage.
 *
 * Responsibilities: assert factor update bounds and apply path for estimates.
 * Wiring: pure helpers. Run:
 * vitest run test/agent/contextSize/tokenCalibration.test.ts
 */
import { describe, expect, it } from 'vitest';

import {
  applyTokenCalibration,
  emptyTokenCalibration,
  updateTokenCalibration,
} from '#/agent/contextSize/tokenCalibration';

describe('tokenCalibration', () => {
  it('starts at factor 1 and moves toward measured/estimated ratio', () => {
    const state = emptyTokenCalibration();
    expect(state.factor).toBe(1);
    // estimated 100, measured 200 → sample 2.0; alpha 0.5 → 1.5
    const next = updateTokenCalibration(state, 100, 200, 0.5);
    expect(next.factor).toBeCloseTo(1.5, 5);
    expect(next.samples).toBe(1);
    expect(applyTokenCalibration(100, next.factor)).toBe(150);
  });

  it('ignores non-positive samples and clamps extreme factors', () => {
    expect(updateTokenCalibration(emptyTokenCalibration(), 0, 100).factor).toBe(1);
    const extreme = updateTokenCalibration(emptyTokenCalibration(), 1, 1000, 1);
    expect(extreme.factor).toBe(4);
    const tiny = updateTokenCalibration(emptyTokenCalibration(), 1000, 1, 1);
    expect(tiny.factor).toBe(0.25);
  });
});
