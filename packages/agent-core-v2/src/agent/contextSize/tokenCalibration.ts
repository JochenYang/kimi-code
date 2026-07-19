/**
 * EMA calibration of heuristic token estimates against measured provider usage.
 *
 * Compaction budgets and context-size reads combine a measured prefix with a
 * char-heuristic estimate of the unmeasured tail. When the provider reports
 * usage for a full exchange, we update a multiplicative factor so subsequent
 * estimates track reality more closely (CJK / tools / system prompt skew).
 */

export const DEFAULT_TOKEN_CALIBRATION_ALPHA = 0.2;
export const DEFAULT_TOKEN_CALIBRATION_FACTOR = 1;
export const MIN_TOKEN_CALIBRATION_FACTOR = 0.25;
export const MAX_TOKEN_CALIBRATION_FACTOR = 4;

export interface TokenCalibrationState {
  readonly factor: number;
  readonly samples: number;
}

export function emptyTokenCalibration(): TokenCalibrationState {
  return { factor: DEFAULT_TOKEN_CALIBRATION_FACTOR, samples: 0 };
}

/**
 * Update the calibration factor from an estimated vs measured pair.
 * Ignores non-positive samples so a zero estimate cannot blow up the factor.
 */
export function updateTokenCalibration(
  state: TokenCalibrationState,
  estimated: number,
  measured: number,
  alpha: number = DEFAULT_TOKEN_CALIBRATION_ALPHA,
): TokenCalibrationState {
  if (!(estimated > 0) || !(measured > 0) || !(alpha > 0 && alpha <= 1)) {
    return state;
  }
  const sample = measured / estimated;
  const next = state.factor * (1 - alpha) + sample * alpha;
  return {
    factor: clampCalibrationFactor(next),
    samples: state.samples + 1,
  };
}

export function applyTokenCalibration(estimate: number, factor: number): number {
  if (!(estimate > 0)) return Math.max(0, estimate);
  return Math.max(0, Math.round(estimate * clampCalibrationFactor(factor)));
}

export function clampCalibrationFactor(factor: number): number {
  if (!Number.isFinite(factor)) return DEFAULT_TOKEN_CALIBRATION_FACTOR;
  return Math.min(MAX_TOKEN_CALIBRATION_FACTOR, Math.max(MIN_TOKEN_CALIBRATION_FACTOR, factor));
}
